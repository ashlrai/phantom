import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { graphResumeRun } from '../src/core/fleet/graph-resume-run.js';

vi.setConfig({ testTimeout: 60_000 });
let dir: string, file: string, checkpoint: string, markers: string, previous: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'graph-resume-deadline-'));
  file = join(dir, 'graph.json'); checkpoint = join(dir, 'checkpoint.json'); markers = join(dir, 'markers');
  previous = process.env.ASHLR_RUNS_DIR; process.env.ASHLR_RUNS_DIR = dir;
  writeFileSync(file, JSON.stringify({ version: 1, tasks: ['A', 'B', 'C'].map((id, index) => ({
    id, ...(index ? { dependsOn: [['A'], ['B']][index - 1] } : {}),
    argv: [process.execPath, '-e', `require('node:fs').appendFileSync(${JSON.stringify(markers)},${JSON.stringify(`${id}\n`)})`],
  })) }));
});
afterEach(() => {
  vi.restoreAllMocks();
  if (previous === undefined) delete process.env.ASHLR_RUNS_DIR; else process.env.ASHLR_RUNS_DIR = previous;
  rmSync(dir, { recursive: true, force: true });
});
const run = (apply = true) => graphResumeRun(file, checkpoint, apply, 30_000);
const lines = () => existsSync(markers) ? readFileSync(markers, 'utf8').trim().split('\n') : [];
const snapshot = () => Object.fromEntries(readdirSync(dir).sort().map(name => [name, readFileSync(join(dir, name), 'utf8')]));

it('resumes a real deadline-exhausted checkpoint without rerunning successes', async () => {
  // Advance the executor's monotonic clock only once A's success has been persisted.
  const clock = vi.spyOn(performance, 'now').mockImplementation(() => {
    if (!existsSync(checkpoint)) return 0;
    const state = JSON.parse(readFileSync(checkpoint, 'utf8'));
    return state.nodes[0].status === 'success' ? 30_000 : 0;
  });
  const first = await run();
  clock.mockRestore();
  expect(first.status).toBe('failed');
  expect(first.nodes).toEqual([
    { id: 'A', status: 'success', exitCode: 0 },
    { id: 'B', status: 'deadline-exhausted', exitCode: null },
    { id: 'C', status: 'deadline-exhausted', exitCode: null },
  ]);
  expect(JSON.parse(readFileSync(checkpoint, 'utf8')).nodes).toEqual(first.nodes);
  expect(lines()).toEqual(['A']);
  const before = snapshot();
  const preview = await run(false);
  expect(preview.status).toBe('preview');
  expect(preview.retained).toEqual(['A']); expect(preview.retried).toEqual(['B', 'C']);
  expect(snapshot()).toEqual(before);
  const second = await run();
  expect(second.status).toBe('complete');
  expect(second.retained).toEqual(['A']); expect(second.retried).toEqual(['B', 'C']);
  expect(second.nodes.map(node => node.status)).toEqual(['success', 'success', 'success']);
  expect(lines()).toEqual(['A', 'B', 'C']);
  const completed = snapshot();
  const third = await run();
  expect(third.status).toBe('complete'); expect(third.retried).toEqual([]);
  expect(third.retained).toEqual(['A', 'B', 'C']);
  expect(snapshot()).toEqual(completed); expect(lines()).toEqual(['A', 'B', 'C']);
});

it('rejects fabricated exhausted rows and inconsistent cached successes without launching', async () => {
  expect((await run()).status).toBe('complete');
  const saved = JSON.parse(readFileSync(checkpoint, 'utf8'));
  const cases = [
    [{ id: 'A', status: 'deadline-exhausted', exitCode: 0 }],
    [{ id: 'A', status: 'deadline-exhausted', exitCode: 7 }],
    [{ id: 'A', status: 'unknown-status', exitCode: null }],
    [{ id: 'A', status: 'deadline-exhausted', exitCode: null }], // B cannot have succeeded before A.
  ];
  for (const [row] of cases) {
    const state = structuredClone(saved); state.nodes[0] = row;
    writeFileSync(checkpoint, JSON.stringify(state));
    const before = snapshot();
    expect((await run(false)).status).toBe('invalid');
    expect((await run()).status).toBe('invalid');
    expect(snapshot()).toEqual(before); expect(lines()).toEqual(['A', 'B', 'C']);
  }
});
