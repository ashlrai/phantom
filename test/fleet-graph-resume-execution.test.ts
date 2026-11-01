import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { graphResumeRun } from '../src/core/fleet/graph-resume-run.js';
import { cmdFleetGraphResume } from '../src/cli/fleet-graph-resume.js';
vi.setConfig({ testTimeout: 60000 });

let dir: string, file: string, checkpoint: string, log: string, previous: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'graph-resume-test-'));
  file = join(dir, 'graph.json'); checkpoint = join(dir, 'checkpoint.json'); log = join(dir, 'log');
  previous = process.env.ASHLR_RUNS_DIR; process.env.ASHLR_RUNS_DIR = dir;
  const code = (id: string) => `const fs=require('node:fs');fs.appendFileSync(${JSON.stringify(log)},${JSON.stringify(`${id}\n`)});` +
    (id === 'B' ? `if(!fs.existsSync(${JSON.stringify(join(dir, 'once'))})){fs.writeFileSync(${JSON.stringify(join(dir, 'once'))},'');process.exit(7)}` : '');
  writeFileSync(file, JSON.stringify({ version: 1, tasks: ['A', 'B', 'C'].map((id, i) => ({ id,
    ...(i ? { dependsOn: [['A'], ['B']][i - 1] } : {}), argv: [process.execPath, '-e', code(id)] })) }));
});
afterEach(() => {
  if (previous === undefined) delete process.env.ASHLR_RUNS_DIR; else process.env.ASHLR_RUNS_DIR = previous;
  rmSync(dir, { recursive: true, force: true }); vi.restoreAllMocks();
});
const run = (apply = true) => graphResumeRun(file, checkpoint, apply, 10000);
const lines = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n') : [];
const load = () => JSON.parse(readFileSync(checkpoint, 'utf8'));

it('retries only unfinished nodes and then becomes a no-op', async () => {
  const before = readdirSync(dir);
  expect((await run(false)).retried).toEqual(['A', 'B', 'C']);
  expect(readdirSync(dir)).toEqual(before); expect(lines()).toEqual([]);
  const first = await run();
  expect(first.status).toBe('failed'); expect(first.nodes.map(n => n.status)).toEqual(['success', 'failed', 'blocked']);
  expect(lines()).toEqual(['A', 'B']);
  const saved = readFileSync(checkpoint, 'utf8');
  const preview = await run(false);
  expect(preview.retained).toEqual(['A']); expect(preview.retried).toEqual(['B', 'C']);
  expect(readFileSync(checkpoint, 'utf8')).toBe(saved); expect(lines()).toEqual(['A', 'B']);
  const second = await run();
  expect(second.status).toBe('complete'); expect(second.nodes.map(n => n.id)).toEqual(['A', 'B', 'C']);
  expect(second.nodes.every(n => n.status === 'success')).toBe(true);
  expect(second.retained).toEqual(['A']); expect(lines()).toEqual(['A', 'B', 'B', 'C']);
  const complete = readFileSync(checkpoint, 'utf8');
  expect((await run()).retried).toEqual([]); expect(lines()).toEqual(['A', 'B', 'B', 'C']);
  expect(readFileSync(checkpoint, 'utf8')).toBe(complete);
});

it('refuses changed manifests, corrupt checkpoints and inconsistent cached success', async () => {
  await run(); const original = readFileSync(checkpoint, 'utf8');
  const manifest = readFileSync(file, 'utf8');
  writeFileSync(file, `${manifest} `);
  expect((await run()).status).toBe('invalid');
  expect(readFileSync(checkpoint, 'utf8')).toBe(original);
  writeFileSync(file, manifest);
  writeFileSync(checkpoint, '{'); expect((await run()).status).toBe('invalid');
  const state = JSON.parse(original); state.nodes[0].status = 'failed'; state.nodes[0].exitCode = 1;
  state.nodes[1].status = 'success'; state.nodes[1].exitCode = 0;
  writeFileSync(checkpoint, JSON.stringify(state)); expect((await run()).status).toBe('invalid');
  state.nodes[0].status = 'success'; state.nodes[0].exitCode = 1;
  writeFileSync(checkpoint, JSON.stringify(state)); expect((await run()).status).toBe('invalid');
  state.nodes[0].exitCode = 0; state.nodes[2] = state.nodes[1];
  writeFileSync(checkpoint, JSON.stringify(state)); expect((await run()).status).toBe('invalid');
  expect(lines()).toEqual(['A', 'B']);
});

it('refuses symlinks, oversized state and occupied locks before launch', async () => {
  writeFileSync(join(dir, 'other'), '{}'); symlinkSync(join(dir, 'other'), checkpoint);
  expect((await run()).status).toBe('invalid'); expect(readFileSync(join(dir, 'other'), 'utf8')).toBe('{}');
  rmSync(checkpoint); writeFileSync(checkpoint, 'x'.repeat(262145));
  expect((await run()).status).toBe('invalid'); rmSync(checkpoint);
  writeFileSync(`${checkpoint}.lock`, ''); expect((await run()).status).toBe('invalid');
  expect(lines()).toEqual([]);
  rmSync(`${checkpoint}.lock`); rmSync(file); symlinkSync(join(dir, 'other'), file);
  expect((await run()).status).toBe('invalid'); expect(lines()).toEqual([]);
});

it('refuses an actually concurrent invocation and retains the lock until completion', async () => {
  const ready = join(dir, 'ready'), release = join(dir, 'release');
  const script = `const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(ready)},'');const t=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)}))clearInterval(t)},10)`;
  writeFileSync(file, JSON.stringify({ version: 1, tasks: [{ id: 'A', argv: [process.execPath, '-e', script] }] }));
  const running = run();
  try {
    const deadline = Date.now() + 10000;
    while (!existsSync(ready)) { if (Date.now() > deadline) throw Error('child did not start'); await new Promise(r => setTimeout(r, 10)); }
    expect(existsSync(`${checkpoint}.lock`)).toBe(true);
    expect((await run()).status).toBe('invalid'); expect(existsSync(checkpoint)).toBe(false);
  } finally { writeFileSync(release, ''); }
  expect((await running).status).toBe('complete'); expect(existsSync(`${checkpoint}.lock`)).toBe(false);
});

it('checks controls again before retrying', async () => {
  await run(); writeFileSync(join(dir, 'PAUSE'), '');
  const result = await run();
  expect(result.status).toBe('failed'); expect(result.nodes.map(n => n.status)).toEqual(['success', 'refused', 'blocked']);
  expect(lines()).toEqual(['A', 'B']); expect(load().nodes[0].status).toBe('success');
});

it('validates CLI flags and emits sanitized JSON with meaningful exit status', async () => {
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const args = ['--file', file, '--checkpoint', checkpoint, '--json'];
  for (const extra of [['--concurrency', '0'], ['--timeout-ms', '0'], ['--apply', '--apply'], ['--unknown']]) {
    expect(await cmdFleetGraphResume([...args, ...extra])).toBe(2);
  }
  expect(await cmdFleetGraphResume(['--file', file, '--checkpoint', checkpoint])).toBe(2);
  expect(await cmdFleetGraphResume(args)).toBe(0);
  expect(JSON.parse(String(output.mock.calls.at(-1)?.[0])).status).toBe('preview');
  expect(await cmdFleetGraphResume([...args, '--apply'])).toBe(1);
  const text = String(output.mock.calls.at(-1)?.[0]);
  expect(JSON.parse(text).status).toBe('failed'); expect(text).not.toContain(process.execPath); expect(text).not.toContain(log);
  expect(await cmdFleetGraphResume([...args, '--apply'])).toBe(0);
});

it('reports persistence failure when checkpoint state changes during a child', async () => {
  const script = `require('node:fs').writeFileSync(${JSON.stringify(checkpoint)},'external')`;
  writeFileSync(file, JSON.stringify({ version: 1, tasks: [{ id: 'A', argv: [process.execPath, '-e', script] }] }));
  const result = await run();
  expect(result.status).toBe('failed');
  expect(result.nodes[0].status).toBe('success');
  expect(readFileSync(checkpoint, 'utf8')).toBe('external');
});
