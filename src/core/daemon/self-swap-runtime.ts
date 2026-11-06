import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { credentialSpawn } from '../integrations/secrets.js';
import { verifiedProcessStartIdentity } from '../fleet/local-store-lock.js';
import type { SelfSwapRuntime } from './self-swap.js';

// IPC establishes that *our* candidate owns the port. Disconnect also closes
// the probe after an updater crash; no tokens or child output reach stdout.
const PROBE = `
let handle;
let closing = false;
const close = async () => {
  closing = true;
  const deadline = setTimeout(() => process.exit(1), 5000);
  await handle?.close();
  clearTimeout(deadline);
  process.exit(0);
};
process.on('disconnect', close);
process.on('SIGTERM', close);
const { loadConfigReadOnly } = await import(process.argv[1] + '/dist/core/config.js');
const { startServer } = await import(process.argv[1] + '/dist/core/web/server.js');
if (!closing) {
  handle = await startServer(loadConfigReadOnly(), { port: Number(process.argv[2]), open: false, allowDispatch: false });
  if (closing || !process.connected) await close();
  else process.send({ port: handle.port });
}
`;

function completion(child: ChildProcess): Promise<boolean> {
  return new Promise(resolve => {
    child.once('error', () => resolve(false));
    child.once('exit', code => resolve(code === 0));
  });
}

export const selfSwapRuntime: SelfSwapRuntime = {
  identify: verifiedProcessStartIdentity,
  async build(directory) {
    const child = credentialSpawn('npm', ['run', 'build'], { cwd: directory, stdio: 'ignore', timeout: 600_000, killSignal: 'SIGKILL' });
    if (!await completion(child)) throw new Error('Candidate build failed or timed out');
  },
  async probe(directory, port) {
    const home = mkdtempSync(join(tmpdir(), 'phantom-self-swap-'));
    const child = spawn(process.execPath, ['--input-type=module', '-e', PROBE, pathToFileURL(directory).href, String(port)], {
      cwd: directory, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, ASHLR_HOME: join(home, '.ashlr'), ASHLR_ADOPTION_AUTO: '0' },
    });
    const done = completion(child);
    let closed: Promise<void> | undefined;
    const close = () => closed ??= (async () => {
      if (child.connected) child.disconnect();
      const timer = setTimeout(() => child.kill('SIGKILL'), 6000);
      try { await done; } finally { clearTimeout(timer); rmSync(home, { recursive: true, force: true }); }
    })();
    try {
      const boundPort = await new Promise<number>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Candidate startup timed out')), 30_000);
        child.once('message', message => {
          clearTimeout(timer);
          const value = (message as { port?: number })?.port;
          if (Number.isInteger(value) && value! > 0 && value! <= 65535) resolve(value!);
          else reject(new Error('Invalid candidate readiness'));
        });
        void done.then(() => { clearTimeout(timer); reject(new Error('Candidate exited before readiness')); });
      });
      return { close, async healthy() {
        if (child.exitCode !== null || child.signalCode !== null) return false;
        try {
          const response = await fetch(`http://127.0.0.1:${boundPort}/api/health`, { signal: AbortSignal.timeout(2000), redirect: 'error' });
          const body = await response.text();
          return response.status === 200 && body.length < 1024 && JSON.parse(body).ok === true && child.exitCode === null && child.signalCode === null;
        } catch { return false; }
      } };
    } catch (error) { await close(); throw error; }
  },
  async drain(pid, identity) {
    const sameProcess = () => {
      try { process.kill(pid, 0); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false; throw new Error('Cannot inspect old process'); }
      const now = verifiedProcessStartIdentity(pid, { requiredSource: identity.source });
      if (!now) throw new Error('Cannot verify old process before drain');
      return now.ref === identity.ref;
    };
    if (!sameProcess()) return; // Exited or PID reused: never signal its replacement.
    process.kill(pid, 'SIGTERM');
    const deadline = performance.now() + 30_000;
    while (performance.now() < deadline) {
      if (!sameProcess()) return;
      await delay(Math.max(0, Math.min(100, deadline - performance.now())));
    }
    throw new Error('Old process drain timed out; selection committed, retry apply to finish');
  },
};
