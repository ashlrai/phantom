import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AshlrConfig, Proposal } from '../src/core/types.js';

const mocks = vi.hoisted(() => ({ proposals: [] as Proposal[], inspect: vi.fn(), observe: vi.fn() }));
vi.mock('../src/core/inbox/store.js', () => ({
  listProposalsDetailed: () => ({ proposals: mocks.proposals, complete: true, sourceState: 'healthy' }),
}));
vi.mock('../src/core/fleet/judge-trace.js', () => ({ readJudgeTraces: () => [] }));
vi.mock('../src/core/fleet/post-merge-window.js', () => ({ inspectPostMergeWindow: mocks.inspect }));
vi.mock('../src/core/fleet/post-merge-observations.js', () => ({ recordPostMergeObservation: mocks.observe }));

import { scanRealWorldOutcomes } from '../src/core/fleet/outcome-watcher.js';
import { loadMonitoringCursor } from '../src/core/fleet/monitoring-cursor.js';

let root: string; let repo: string; let stateFile: string;
let oldHome: string | undefined; let oldAshlr: string | undefined;
beforeEach(() => {
  vi.clearAllMocks();
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'outcome-budget-')));
  repo = join(root, 'repo'); mkdirSync(repo);
  oldHome = process.env.HOME; oldAshlr = process.env.ASHLR_HOME;
  process.env.HOME = root; process.env.ASHLR_HOME = join(root, '.ashlr');
  stateFile = join(root, 'watcher.json');
  mocks.proposals = ['p-a', 'p-b', 'p-c'].map(id => ({
    id, repo, status: 'applied', createdAt: new Date().toISOString(),
    realizedMerge: { schemaVersion: 1, source: 'local-default-branch', base: 'main', baseBeforeOid: 'a'.repeat(40), proposalHeadOid: 'b'.repeat(40), mergeCommitOid: 'c'.repeat(40), observedAt: new Date().toISOString() },
  } as Proposal));
});
afterEach(() => {
  if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
  if (oldAshlr === undefined) delete process.env.ASHLR_HOME; else process.env.ASHLR_HOME = oldAshlr;
  rmSync(root, { recursive: true, force: true });
});

it('caps window time, keeps the last completed cursor, and retries the interrupted window', async () => {
  let clock = 0;
  mocks.inspect.mockImplementation((_input, opts) => {
    clock += opts.deadlineMs === 60 ? 20 : 40;
    return { state: 'complete', adverse: null };
  });
  const first = await scanRealWorldOutcomes({} as AshlrConfig, { enrolledRepos: [repo], stateFile, now: () => clock, deadlineAtMs: 60 });
  expect(first).toMatchObject({ sourceComplete: false, skippedReason: 'ancillary-budget', throttled: false });
  expect(mocks.inspect.mock.calls.map(call => call[1].deadlineMs)).toEqual([60, 40]);
  expect(loadMonitoringCursor([repo]).cursor?.outcome).toMatchObject({ candidateAfter: { proposalId: 'p-a' }, sweepComplete: false });
  expect(existsSync(stateFile)).toBe(false);
  mocks.inspect.mockImplementation(() => ({ state: 'complete', adverse: null }));
  const second = await scanRealWorldOutcomes({} as AshlrConfig, { enrolledRepos: [repo], stateFile });
  expect(second).toMatchObject({ scanned: 2, sourceComplete: true, throttled: false });
  expect(loadMonitoringCursor([repo]).cursor?.outcome).toMatchObject({ candidateAfter: { proposalId: 'p-c' }, sweepComplete: true });
  expect(existsSync(stateFile)).toBe(true);
});

it.each(['aborted', 'exhausted'] as const)('does not inspect or advance a cursor when %s before starting', async kind => {
  const parent = new AbortController(); if (kind === 'aborted') parent.abort();
  const result = await scanRealWorldOutcomes({} as AshlrConfig, { enrolledRepos: [repo], stateFile, signal: parent.signal, deadlineAtMs: kind === 'exhausted' ? 0 : undefined, now: () => 0 });
  expect(result.skippedReason).toBe(kind === 'aborted' ? 'phase-cancelled' : 'ancillary-budget');
  expect(mocks.inspect).not.toHaveBeenCalled(); expect(mocks.observe).not.toHaveBeenCalled();
  expect(loadMonitoringCursor([repo]).cursor).toBeNull(); expect(existsSync(stateFile)).toBe(false);
});

it('preserves an empty completed scan without a budget', async () => {
  mocks.proposals = [];
  const result = await scanRealWorldOutcomes({} as AshlrConfig, { enrolledRepos: [repo], stateFile });
  expect(result).toMatchObject({ scanned: 0, sourceComplete: true });
  expect(mocks.inspect).not.toHaveBeenCalled();
});

it('does not advance past an inspection that throws after cancellation', async () => {
  const parent = new AbortController();
  mocks.inspect.mockImplementation(() => { parent.abort(); throw new Error('interrupted'); });
  const result = await scanRealWorldOutcomes({} as AshlrConfig, { enrolledRepos: [repo], stateFile, signal: parent.signal });
  expect(result).toMatchObject({ sourceComplete: false, skippedReason: 'phase-cancelled' });
  expect(loadMonitoringCursor([repo]).cursor).toBeNull();
  expect(existsSync(stateFile)).toBe(false);
});
