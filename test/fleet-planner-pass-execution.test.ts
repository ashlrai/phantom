import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleet } from '../src/cli/fleet.js';

const roots: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(roots.splice(0).map((p) => rm(p, { recursive: true, force: true }))); });
async function fixture(code = 0, timeoutMs = 2000) {
  const root = await mkdtemp(join(tmpdir(), 'fake-planner-')); roots.push(root);
  const candidates = [];
  for (const provider of ['fake-first', 'fake-second']) {
    const runsRoot = join(root, provider); await mkdir(join(runsRoot, 'supervisor'), { recursive: true });
    const script = join(root, provider + '.cjs');
    await writeFile(script, `const fs=require('node:fs');fs.appendFileSync('calls','x');fs.writeFileSync('pid',String(process.pid));let b=[];process.stdin.on('data',x=>b.push(x));process.stdin.on('end',()=>{fs.writeFileSync('prompt',Buffer.concat(b));${code < 0 ? 'setInterval(()=>{},1000)' : `process.exit(${code})`}});`);
    candidates.push({ provider, executable: process.execPath, argv: [script], cwd: runsRoot, runsRoot });
  }
  const config = join(root, 'config.json'); const prompt = join(root, 'input');
  const bytes = Buffer.from([0, 255, 10, 65, 13, 10]); await writeFile(prompt, bytes);
  await writeFile(config, JSON.stringify({ timeoutMs, candidates }));
  const limited = async (index: number) => {
    const runs = candidates[index]!.runsRoot;
    await writeFile(join(runs, 'dispatch-events.log'), '2020-01-01 00:00:00 LEADER fake rc=0\n');
    await writeFile(join(runs, 'supervisor', 'run.fake.log'), "You've hit your usage limit. try again at Nov 4th, 2099 1:41 AM.");
  };
  const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const run = () => cmdFleet(['planner', 'run', '--config', config, '--prompt-file', prompt, '--json']);
  return { root, candidates, config, prompt, bytes, limited, output, run };
}
it('skips exhausted first executable, preserves exact bytes and cwd, and launches once', async () => {
  const f = await fixture(); await f.limited(0);
  expect(await f.run()).toBe(0);
  await expect(readFile(join(f.candidates[0]!.cwd, 'calls'))).rejects.toThrow();
  expect(await readFile(join(f.candidates[1]!.cwd, 'calls'), 'utf8')).toBe('x');
  expect(await readFile(join(f.candidates[1]!.cwd, 'prompt'))).toEqual(f.bytes);
  expect(JSON.parse(f.output.mock.calls[0]![0])).toMatchObject({ provider: 'fake-second', status: 'completed', exitCode: 0 });
});
it('propagates child failure and never retries', async () => {
  const f = await fixture(7); await f.limited(0);
  expect(await f.run()).toBe(1);
  expect(JSON.parse(f.output.mock.calls[0]![0])).toMatchObject({ provider: 'fake-second', status: 'failed', exitCode: 7 });
  expect(await readFile(join(f.candidates[1]!.cwd, 'calls'), 'utf8')).toBe('x');
});
it('all exhausted produces zero launches and reports selector reason and reset', async () => {
  const f = await fixture(); await f.limited(0); await f.limited(1);
  expect(await f.run()).toBe(1);
  for (const c of f.candidates) await expect(readFile(join(c.cwd, 'calls'))).rejects.toThrow();
  expect(JSON.parse(f.output.mock.calls[0]![0])).toMatchObject({ status: 'no-runner', reason: 'all candidates are usage-limited', nextResetAt: expect.stringContaining('2099') });
});
it('kills a timed-out process before returning failure', async () => {
  const f = await fixture(-1, 2000);
  expect(await f.run()).toBe(1);
  const pid = Number(await readFile(join(f.candidates[0]!.cwd, 'pid'), 'utf8'));
  expect(() => process.kill(pid, 0)).toThrow();
  expect(JSON.parse(f.output.mock.calls[0]![0])).toMatchObject({ status: 'timed-out' });
  await expect(readFile(join(f.candidates[1]!.cwd, 'calls'))).rejects.toThrow();
});
it('cancellation kills the child and returns failure', async () => {
  const f = await fixture(-1);
  const timer = setInterval(() => {
    void readFile(join(f.candidates[0]!.cwd, 'pid')).then(() => process.emit('SIGINT')).catch(() => undefined);
  }, 20);
  try {
    expect(await f.run()).toBe(1);
    const pid = Number(await readFile(join(f.candidates[0]!.cwd, 'pid'), 'utf8'));
    expect(() => process.kill(pid, 0)).toThrow();
    expect(JSON.parse(f.output.mock.calls[0]![0])).toMatchObject({ status: 'cancelled' });
  } finally { clearInterval(timer); }
});
it('respects planner hold without modifying it', async () => {
  const f = await fixture(); await writeFile(join(f.candidates[0]!.runsRoot, 'ORCH_OFF'), 'fake hold');
  expect(await f.run()).toBe(1);
  expect(JSON.parse(f.output.mock.calls[0]![0])).toMatchObject({ status: 'blocked' });
  await expect(readFile(join(f.candidates[0]!.cwd, 'calls'))).rejects.toThrow();
});
it('reports spawn errors without trying another candidate', async () => {
  const f = await fixture();
  f.candidates[0]!.executable = join(f.root, 'fake-nonexistent-executable');
  await writeFile(f.config, JSON.stringify({ timeoutMs: 1000, candidates: f.candidates }));
  expect(await f.run()).toBe(1);
  expect(JSON.parse(f.output.mock.calls[0]![0])).toMatchObject({ provider: 'fake-first', status: 'spawn-error', exitCode: null });
  await expect(readFile(join(f.candidates[1]!.cwd, 'calls'))).rejects.toThrow();
});
it('missing prompt fails before launch', async () => {
  const f = await fixture(); await rm(f.prompt);
  expect(await f.run()).toBe(1);
  for (const c of f.candidates) await expect(readFile(join(c.cwd, 'calls'))).rejects.toThrow();
});
