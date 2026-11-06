import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetContextRun } from '../src/cli/fleet-context-run.js';
import { runContextWorker } from '../src/core/fleet/context-worker-run.js';

let root: string, snapshot: string, prompt: string, output: string, errors: string;
const sink = (write: (text: string) => void) => new Writable({ write(chunk, _encoding, done) { write(String(chunk)); done(); } });
const io = () => ({ stdout: sink(s => { output += s; }), stderr: sink(s => { errors += s; }) });
const opts = (script: string, timeoutMs?: number) => ({ snapshot, prompt, argv: [process.execPath, '-e', script], timeoutMs });
const args = (script: string, flags: string[] = []) => ['--snapshot', snapshot, '--prompt', prompt, ...flags, '--', process.execPath, '-e', script];
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const waitForFile = async (path: string): Promise<string> => {
  for (let i = 0; i < 600; i++) {
    try { return await readFile(path, 'utf8'); } catch { await new Promise(resolveWait => setTimeout(resolveWait, 25)); }
  }
  throw new Error('worker did not become ready');
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'context-deadline-'));
  vi.stubEnv('HOME', root); vi.stubEnv('ASHLR_HOME', join(root, 'home')); vi.stubEnv('ASHLR_RUNS_DIR', join(root, 'runs'));
  await mkdir(join(root, 'runs'), { mode: 0o700 });
  snapshot = join(root, 'snapshot.json'); prompt = join(root, 'prompt.txt'); output = ''; errors = '';
  await writeFile(snapshot, JSON.stringify({ node: { jobId: 'CURRENT', upstreamJobIds: [] }, tasks: [], outputs: [], byteBudget: 800 }));
  await writeFile(prompt, 'prompt');
});
afterEach(async () => { vi.restoreAllMocks(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); });

it('preserves ordinary invocation and exact child exits, clearing deadline timers and signal listeners', async () => {
  const beforeInt = process.listenerCount('SIGINT'), beforeTerm = process.listenerCount('SIGTERM');
  const setTimer = vi.spyOn(globalThis, 'setTimeout');
  const clearTimer = vi.spyOn(globalThis, 'clearTimeout');
  expect(await cmdFleetContextRun(args('process.stdin.pipe(process.stdout)'), io())).toBe(0);
  expect(output).toContain('prompt');
  expect(await cmdFleetContextRun(args('process.stdin.resume()', ['--timeout-ms', '3600000']), io())).toBe(0);
  expect(await cmdFleetContextRun(args('process.stdin.resume();process.stdin.on("end",()=>process.exit(7))', ['--timeout-ms', '3600000']), io())).toBe(7);
  const index = setTimer.mock.calls.findIndex(call => call[1] === 3600000);
  expect(index).toBeGreaterThanOrEqual(0);
  expect(clearTimer).toHaveBeenCalledWith(setTimer.mock.results[index]!.value);
  expect(process.listenerCount('SIGINT')).toBe(beforeInt);
  expect(process.listenerCount('SIGTERM')).toBe(beforeTerm);
});

it.each(['0', '3600001', '-1', '1.5', 'NaN', '1e3', '9007199254740992'])('rejects invalid CLI timeout %s before spawn', async timeout => {
  const marker = join(root, 'spawned');
  const script = `require('fs').writeFileSync(${JSON.stringify(marker)}, 'started')`;
  expect(await cmdFleetContextRun(args(script, ['--timeout-ms', timeout]), io())).toBe(2);
  await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
});

it.each([0, -1, 3600001, 1.5, NaN, Infinity])('rejects invalid API timeout %s before spawn', async timeout => {
  const marker = join(root, 'spawned');
  expect(await runContextWorker(opts(`require('fs').writeFileSync(${JSON.stringify(marker)}, 'started')`, timeout), io())).toBe(2);
  await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
});

it('keeps spawn failure a failure with a deadline', async () => {
  expect(await runContextWorker({ snapshot, prompt, argv: [join(root, 'missing')], timeoutMs: 100 }, io())).toBe(1);
  expect(errors).toContain('worker spawn failed');
});

it.each(process.platform === 'win32' ? [false] : [false, true])('terminates a hanging child (ignore SIGTERM: %s) and clears resources', async ignoreTerm => {
  const beforeInt = process.listenerCount('SIGINT'), beforeTerm = process.listenerCount('SIGTERM');
  const setTimer = vi.spyOn(globalThis, 'setTimeout');
  const clearTimer = vi.spyOn(globalThis, 'clearTimeout');
  const script = `${ignoreTerm ? 'process.on("SIGTERM",()=>{});' : ''}process.stdin.resume();console.log(process.pid);setInterval(()=>{},1000)`;
  const start = Date.now();
  expect(await cmdFleetContextRun(args(script, ['--timeout-ms', '4000']), io())).toBe(124);
  expect(Date.now() - start).toBeLessThan(15000);
  const pid = Number(output.trim());
  expect(pid).toBeGreaterThan(0);
  expect(alive(pid)).toBe(false);
  for (const delay of [4000, 1000]) {
    const index = setTimer.mock.calls.findIndex(call => call[1] === delay);
    expect(index).toBeGreaterThanOrEqual(0);
    expect(clearTimer).toHaveBeenCalledWith(setTimer.mock.results[index]!.value);
  }
  expect(process.listenerCount('SIGINT')).toBe(beforeInt);
  expect(process.listenerCount('SIGTERM')).toBe(beforeTerm);
}, 20000);

it.skipIf(process.platform === 'win32')('keeps an earlier external signal authoritative while escalating a resistant child', async () => {
  const ready = join(root, 'ready');
  const entry = join(root, 'entry.mjs');
  await writeFile(entry, `import { cmdFleetContextRun } from ${JSON.stringify(resolve('src/cli/fleet-context-run.ts'))};process.exitCode=await cmdFleetContextRun(process.argv.slice(2));`);
  const script = `process.on('SIGTERM',()=>{});process.stdin.resume();require('fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));setInterval(()=>{},1000)`;
  const runner = spawn(process.execPath, ['--import', 'tsx', entry, ...args(script, ['--timeout-ms', '10000'])], { stdio: ['ignore', 'ignore', 'pipe'] });
  let pid = 0;
  const closed = new Promise<number | null>((done, reject) => { runner.once('error', reject); runner.once('close', done); });
  try {
    pid = Number(await waitForFile(ready));
    expect(pid).toBeGreaterThan(0);
    runner.kill('SIGTERM');
    expect(await closed).toBe(143);
    expect(alive(pid)).toBe(false);
  } finally {
    if (runner.exitCode === null && runner.signalCode === null) runner.kill('SIGKILL');
    if (pid && alive(pid)) process.kill(pid, 'SIGKILL');
    await closed;
  }
}, 25000);
