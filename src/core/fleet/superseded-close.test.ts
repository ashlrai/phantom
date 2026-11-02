import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { closeSupersededPrs, planSupersededClose, type SupersededCloseRunner } from './superseded-close.js';
import type { MergedFleetPr, OpenFleetPr } from './superseded-prs.js';

const open: OpenFleetPr[] = [
  { number: 2461, title: 'bridge: RQ-PHX-FAKE1: first fake', mergeStateStatus: 'DIRTY' },
  { number: 2406, title: 'bridge: RQ-PHX-FAKE2: second fake', mergeStateStatus: 'DIRTY' },
  { number: 2379, title: 'bridge: RQ-PHX-FAKE3: third fake', mergeStateStatus: 'DIRTY' },
];
const merged: MergedFleetPr[] = [
  { number: 2505, title: 'bridge: RQ-PHX-FAKE1 recut lands' },
  { number: 2500, title: 'bridge: RQ-PHX-FAKE2 recut lands' },
];
const prompts = new Map([
  ['RQ-PHX-FAKE1', 'Redo PR #2461.'],
  ['RQ-PHX-FAKE2', 'Redo PR #2406.'],
  ['RQ-PHX-FAKE3', 'Redo PR #2379.'],
]);
const plan = () => planSupersededClose(open, merged, prompts);
const closeArgs = (number: number, merged_: number) =>
  ['pr', 'close', String(number), '--repo', 'ashlrai/phantom', '--comment',
    `Superseded by #${merged_} (merged). Closed by ashlr fleet superseded-close.`];

let root: string;
afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); });
async function runsDir(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), 'superseded-close-'));
  return root;
}
async function ledgerLines(dir: string): Promise<Record<string, unknown>[]> {
  const raw = await readFile(join(dir, 'queue', 'superseded-closes.jsonl'), 'utf8');
  return raw.trim().split('\n').map(line => JSON.parse(line) as Record<string, unknown>);
}

it('plans exactly the PRs with a merged recut, bridge titles only', () => {
  const extra = [
    ...open,
    { number: 2000, title: 'feature: RQ-PHX-FAKE4 not a bridge', mergeStateStatus: 'DIRTY' },
  ];
  const widerMerged = [...merged, { number: 2600, title: 'bridge: RQ-PHX-FAKE4 recut' }];
  const widerPrompts = new Map([...prompts, ['RQ-PHX-FAKE4', 'Redo PR #2000.']]);
  expect(planSupersededClose(extra, widerMerged, widerPrompts)).toEqual([
    { number: 2461, title: open[0]!.title, supersededBy: 2505,
      comment: 'Superseded by #2505 (merged). Closed by ashlr fleet superseded-close.' },
    { number: 2406, title: open[1]!.title, supersededBy: 2500,
      comment: 'Superseded by #2500 (merged). Closed by ashlr fleet superseded-close.' },
  ]);
});

it('dry run returns the plan untouched and never calls the runner', async () => {
  const dir = await runsDir();
  const runner = async () => { throw new Error('must not run'); };
  const result = await closeSupersededPrs(plan(), { apply: false, runner, runsDir: dir });
  expect(result).toEqual({ attempted: 0, closed: 0, failed: 0, rows: plan() });
  await expect(readFile(join(dir, 'queue', 'superseded-closes.jsonl'), 'utf8')).rejects.toThrow();
});

it('apply issues one gh pr close per row with the exact comment, in order', async () => {
  const dir = await runsDir();
  const calls: string[][] = [];
  const runner: SupersededCloseRunner = async (_file, args) => {
    calls.push(args);
    return { code: 0, stdout: '', stderr: '' };
  };
  const result = await closeSupersededPrs(plan(), { apply: true, runner, runsDir: dir, now: () => 1762560000000 });
  expect(result).toMatchObject({ attempted: 2, closed: 2, failed: 0 });
  expect(calls).toEqual([closeArgs(2461, 2505), closeArgs(2406, 2500)]);
  expect(await ledgerLines(dir)).toEqual([
    { at: '2025-11-08T00:00:00.000Z', pr: 2461, supersededBy: 2505, ok: true },
    { at: '2025-11-08T00:00:00.000Z', pr: 2406, supersededBy: 2500, ok: true },
  ]);
});

it('stops at the first non-zero exit and ledgers the failure', async () => {
  const dir = await runsDir();
  const calls: string[][] = [];
  const runner: SupersededCloseRunner = async (_file, args) => {
    calls.push(args);
    return { code: 1, stdout: '', stderr: 'fake close failure' };
  };
  const result = await closeSupersededPrs(plan(), { apply: true, runner, runsDir: dir });
  expect(result).toMatchObject({ attempted: 1, closed: 0, failed: 1, error: 'fake close failure' });
  expect(calls).toEqual([closeArgs(2461, 2505)]);
  expect(await ledgerLines(dir)).toEqual([
    expect.objectContaining({ pr: 2461, supersededBy: 2505, ok: false, error: 'fake close failure' }),
  ]);
});

it('honours the close limit', async () => {
  const dir = await runsDir();
  const calls: string[][] = [];
  const runner: SupersededCloseRunner = async (_file, args) => {
    calls.push(args);
    return { code: 0, stdout: '', stderr: '' };
  };
  const result = await closeSupersededPrs(plan(), { apply: true, limit: 1, runner, runsDir: dir });
  expect(result).toMatchObject({ attempted: 1, closed: 1, failed: 0 });
  expect(calls).toEqual([closeArgs(2461, 2505)]);
});
