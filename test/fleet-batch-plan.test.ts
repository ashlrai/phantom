import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { cmdFleetBatchPlan } from '../src/cli/fleet-batch-plan.js';

let root: string | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function queue(text: string) {
  root = await mkdtemp(join(tmpdir(), 'batch-plan-'));
  await mkdir(join(root, 'queue'));
  await writeFile(join(root, 'queue', 'ready.tsv'), text);
  vi.stubEnv('ASHLR_RUNS_DIR', root);
}

it('groups queue-ordered jobs by repository, skips parked rows and splits batches', async () => {
  await queue('# queue\nA\tphantom\tdevin\twork\t/a\nB\tstack\tcodex\twork\t/b\nC\tphantom\tPARKED-DEP.devin\twork\t/c\nD\tphantom\tdevin\twork\t/d\nE\tphantom\tdevin\twork\t/e\n');
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetBatchPlan(['--size', '2', '--json'])).toBe(0);
  expect(JSON.parse(log.mock.calls[0]![0] as string)).toEqual([
    { batch: 1, repo: 'phantom', ids: ['A', 'D'] },
    { batch: 2, repo: 'phantom', ids: ['E'] },
    { batch: 3, repo: 'stack', ids: ['B'] },
  ]);
  log.mockClear();
  expect(await cmdFleetBatchPlan(['--size', '2'])).toBe(0);
  expect(log.mock.calls.map(call => call[0])).toEqual(['Batch 1: phantom — A, D', 'Batch 2: phantom — E', 'Batch 3: stack — B']);
});

it('defaults to ten and returns an empty JSON array for an empty queue', async () => {
  await queue(Array.from({ length: 11 }, (_, i) => `id${i}\trepo\tlane`).join('\n'));
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetBatchPlan(['--json'])).toBe(0);
  expect(JSON.parse(log.mock.calls[0]![0] as string).map((b: { ids: string[] }) => b.ids.length)).toEqual([10, 1]);
  await writeFile(join(root!, 'queue', 'ready.tsv'), '');
  log.mockClear();
  expect(await cmdFleetBatchPlan(['--json'])).toBe(0);
  expect(log).toHaveBeenCalledWith('[]');
});

it('rejects invalid sizes and reports unreadable input', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  for (const size of ['0', '-1', '1.5', 'Infinity', '9007199254740992']) expect(await cmdFleetBatchPlan(['--size', size])).toBe(2);
  root = await mkdtemp(join(tmpdir(), 'batch-plan-'));
  vi.stubEnv('ASHLR_RUNS_DIR', root);
  expect(await cmdFleetBatchPlan(['--json'])).toBe(1);
  expect(error).toHaveBeenLastCalledWith('error: unable to read queue/ready.tsv');
});
