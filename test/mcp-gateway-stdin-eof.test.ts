import { afterEach, expect, it } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

const sessions: { child: ChildProcess; home: string; pidFile: string }[] = [];
const gatewayUrl = new URL('../src/core/mcp-gateway.ts', import.meta.url).href;

function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function launch(stubborn = false): Promise<{ child: ChildProcess; pid: number }> {
  const home = mkdtempSync(join(tmpdir(), 'fake-mcp-eof-'));
  const pidFile = join(home, 'fake-server.pid');
  const downstream = `
    require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    setInterval(() => {}, 1000);
    ${stubborn ? "process.on('SIGTERM', () => {});" : "process.stdin.on('end', () => process.exit(0));"}
    require('node:readline').createInterface({ input: process.stdin }).on('line', line => {
      const m = JSON.parse(line);
      if (m.id === undefined) return;
      const result = m.method === 'initialize'
        ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake-eof-peer', version: '1' } }
        : { tools: [] };
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
    });`;
  const entry = `import { startGateway } from ${JSON.stringify(gatewayUrl)};
    await startGateway({ servers: [{ name: 'fake-eof-peer', command: process.execPath,
      args: ['-e', ${JSON.stringify(downstream)}], source: 'fake-test' }] });`;
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', entry], {
    env: { PATH: process.env.PATH, HOME: home, ASHLR_HOME: join(home, '.ashlr'), ASHLR_NO_HEAL: '1' },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  sessions.push({ child, home, pidFile });
  let output = '';
  child.stderr!.setEncoding('utf8');
  child.stderr!.on('data', (data: string) => { output += data; });
  child.stdout!.resume();
  // Loading the real gateway imports the native tool graph before startup.
  const deadline = Date.now() + 60_000;
  while (!output.includes('gateway ready')) {
    if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) {
      throw new Error(`Fake gateway failed to start: ${output}`);
    }
    await delay(25);
  }
  expect(output).toContain('from 1/1 server(s)');
  const pid = Number(readFileSync(pidFile, 'utf8'));
  expect(alive(pid)).toBe(true);
  return { child, pid };
}

async function exits(child: ChildProcess, pid: number): Promise<void> {
  const [code, signal] = await once(child, 'exit', { signal: AbortSignal.timeout(5_000) });
  expect({ code, signal }).toEqual({ code: 0, signal: null });
  // Reaping can complete just after the gateway's own exit event.
  const deadline = Date.now() + 1_000;
  while (alive(pid) && Date.now() < deadline) await delay(25);
  expect(alive(pid)).toBe(false);
}

afterEach(async () => {
  for (const { child, home, pidFile } of sessions.splice(0)) {
    const exited = child.exitCode !== null || child.signalCode !== null;
    const done = exited ? Promise.resolve() : once(child, 'exit');
    if (!exited) child.kill('SIGKILL');
    await done;
    try { process.kill(Number(readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* already gone */ }
    child.stdin?.destroy();
    child.stdout?.destroy();
    child.stderr?.destroy();
    rmSync(home, { recursive: true, force: true });
  }
});

it('stdin EOF exits the gateway and downstream within five seconds', async () => {
  const { child, pid } = await launch();
  const done = exits(child, pid);
  child.stdin!.end();
  await done;
}, 75_000);

it('stdin EOF also kills a downstream that ignores EOF and SIGTERM', async () => {
  const { child, pid } = await launch(true);
  const done = exits(child, pid);
  child.stdin!.end();
  await done;
}, 75_000);

it('SIGTERM still exits cleanly and ends the downstream', async () => {
  const { child, pid } = await launch();
  const done = exits(child, pid);
  child.kill('SIGTERM');
  await done;
}, 75_000);

it('an attached host keeps the gateway and downstream alive', async () => {
  const { child, pid } = await launch();
  await delay(2_100);
  expect(child.exitCode).toBeNull();
  expect(child.signalCode).toBeNull();
  expect(alive(pid)).toBe(true);
  const done = exits(child, pid);
  child.stdin!.end();
  await done;
}, 75_000);
