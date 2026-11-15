import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { cmdFleetHandoffSend } from '../src/cli/fleet-handoff-send.js';
import { cmdFleetHandoffReceive } from '../src/cli/fleet-handoff-receive.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';

it('bounds a sent handoff at the child boundary without consuming its receipt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'handoff-timeout113-'));
  const root = join(dir, 'bus');
  const file = join(dir, 'handoff.json');
  const snapshot = join(dir, 'snapshot.json');
  const marker = join(dir, 'pid');
  let pid = 0;
  let stdout = '';
  let stderr = '';
  let watchdog: ReturnType<typeof setTimeout> | undefined;
  let pending: Promise<number> | undefined;
  const sink = (capture: (text: string) => void) => new Writable({
    write(chunk, _encoding, done) { capture(String(chunk)); done(); },
  });
  const io = () => ({ stdout: sink(s => { stdout += s; }), stderr: sink(s => { stderr += s; }) });
  const receive = (script: string, timeout: string) => cmdFleetHandoffReceive([
    '--id', 'timeout-message', '--to', 'worker', '--snapshot', snapshot, '--timeout-ms', timeout,
    '--', process.execPath, '-e', script,
  ], { root }, io());
  try {
    vi.stubEnv('HOME', dir);
    vi.stubEnv('ASHLR_HOME', join(dir, 'ashlr'));
    vi.stubEnv('ASHLR_RUNS_DIR', join(dir, 'runs'));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    writeFileSync(file, JSON.stringify({ id: 'WORK-TIMEOUT-113', task: 'Synthetic task',
      files: [{ path: 'src/example.ts' }], constraints: [], check: 'Check synthetic result' }));
    writeFileSync(snapshot, JSON.stringify({ node: { jobId: 'WORK-TIMEOUT-113', upstreamJobIds: [] },
      tasks: [{ jobId: 'WORK-TIMEOUT-113', text: 'Synthetic context' }], outputs: [], byteBudget: 8192 }));
    expect(await cmdFleetHandoffSend(['--file', file, '--id', 'timeout-message', '--from', 'planner',
      '--to', 'worker', '--apply', '--json'], { root })).toBe(0);
    const observedAt = Date.now();
    const receiptOptions = { root, now: () => observedAt };
    const before = listBusInboxAfter(0, 50, receiptOptions);
    expect(before.status).toBe('ok');
    if (before.status !== 'ok') throw new Error('bus unavailable');
    expect(before.messages).toHaveLength(1);

    // A synchronous marker proves the actual child reached its script before termination.
    const script = `require('node:fs').writeFileSync(${JSON.stringify(marker)}, String(process.pid));`
      + 'process.stdin.resume();setInterval(()=>{},1000)';
    const start = Date.now();
    pending = receive(script, '4000');
    const result = await Promise.race([pending, new Promise<never>((_, reject) => {
      watchdog = setTimeout(() => reject(new Error('receive did not settle within watchdog')), 20000);
    })]);
    expect(result).toBe(124);
    expect(Date.now() - start).toBeLessThan(20000);
    pid = Number(readFileSync(marker, 'utf8'));
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).toThrow();
    expect(stdout).toBe('');
    expect(stderr).toContain('worker ended by SIGTERM');
    expect(listBusInboxAfter(0, 50, receiptOptions)).toEqual(before);

    stdout = ''; stderr = '';
    expect(await receive('process.stdin.resume();process.stdin.on("end",()=>process.exit(0))', '10000')).toBe(0);
    expect(stdout).toBe('');
    expect(stderr).toBe('');
    expect(listBusInboxAfter(0, 50, receiptOptions)).toEqual(before);
  } finally {
    if (watchdog) clearTimeout(watchdog);
    try { pid ||= Number(readFileSync(marker, 'utf8')); } catch { /* child did not start */ }
    if (pid > 0) { try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ } }
    if (pending) await pending;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);
