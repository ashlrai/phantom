import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetBacklog, type FleetBacklogDeps } from '../src/cli/fleet-backlog.js';
import { newFleetMergeState } from '../src/core/fleet/fleet-merge-state.js';

const now = () => new Date('2026-10-31T23:06:00Z');
const sha = 'a'.repeat(40);
const row = (number: number) => ({
  number, state: 'OPEN', isDraft: false, headRefOid: sha,
  headRefName: `fake/${number}`, baseRefName: 'main', isCrossRepository: false,
  mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY',
  statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }],
});

function fixture(rows: unknown[]) {
  const gh = vi.fn<NonNullable<FleetBacklogDeps['gh']>>(async () => ({ ok: true, stdout: JSON.stringify(rows), stderr: '' }));
  const record = newFleetMergeState({
    key: 'fake', kind: 'change', proposalId: 'fake', revertsLandingId: null,
    repo: 'example/project', repoPath: '/tmp/fake-project', enforcement: null, nowIso: now().toISOString(),
  });
  record.pr = {
    number: 101, nodeId: 'fake-node', repositoryId: 'fake-repo', branch: 'fake/101', baseBranch: 'main',
    baseSha: 'b'.repeat(40), headSha: sha, treeSha: 'c'.repeat(40), ownerLane: false, ownerLaneReason: null,
    openedAt: now().toISOString(), ledgered: true, state: 'open', closedBy: null,
    nextCheckAt: null, checkBackoffMs: 0, checks: null, wouldMergeHeadSha: null,
  };
  const states = vi.fn<NonNullable<FleetBacklogDeps['states']>>(() => new Map([[101, { state: 'ok', record }]]));
  return { gh, states, now };
}

let output: string[];
let errors: string;
beforeEach(() => {
  output = [];
  errors = '';
  vi.spyOn(console, 'log').mockImplementation((message: unknown) => { output.push(String(message)); });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { errors += String(chunk); return true; });
});
afterEach(() => vi.restoreAllMocks());

describe('fleet backlog claimed PR exclusions', () => {
  it('excludes before limits while preserving page counts and performing only the read', async () => {
    const deps = fixture([row(101), row(202), row(303)]);
    expect(await cmdFleetBacklog(['--repo', 'example/project', '--exclude-pr', '0101', '--exclude-pr', '101', '--recuts', '1', '--json'], deps)).toBe(0);
    const report = JSON.parse(output[0]!);
    expect(report).toMatchObject({ open: 3, complete: true, tracked: 1, unreadable: 0,
      exclusions: { requested: [101], found: [101], notFoundInFetchedPage: [] },
      countsScope: 'planned after exclusions', counts: { conflicting: 2 } });
    expect(report.plan.recuts).toMatchObject([{ number: 202 }]);
    expect(report.plan.deferred).toMatchObject([{ number: 303 }]);
    expect(deps.gh).toHaveBeenCalledTimes(1);
    expect(deps.gh.mock.calls[0]![0]).toEqual(['pr', 'list', '--repo', 'example/project', '--state', 'open', '--limit', '500', '--json',
      'number,state,isDraft,headRefOid,headRefName,baseRefName,isCrossRepository,mergeable,mergeStateStatus,statusCheckRollup']);
    expect(deps.states).toHaveBeenCalledExactlyOnceWith('example/project');
  });

  it('reports unknown malformed rows and partial pages without claiming repository absence', async () => {
    const deps = fixture([row(101), { number: 202 }, row(303)]);
    const args = ['--limit', '3', '--exclude-pr', '101', '--exclude-pr', '202', '--exclude-pr', '999'];
    expect(await cmdFleetBacklog([...args, '--json'], deps)).toBe(0);
    const report = JSON.parse(output[0]!);
    expect(report).toMatchObject({ open: 3, complete: false, unreadable: 1,
      exclusions: { requested: [101, 202, 999], found: [101], notFoundInFetchedPage: [202, 999] },
      counts: { conflicting: 1, waiting: 1 } });
    expect(report.plan.deferred).toMatchObject([{ number: null, classification: { class: 'unknown' } }]);
    output = [];
    expect(await cmdFleetBacklog(args, deps)).toBe(0);
    expect(output.join('\n')).toContain('page limit 3 reached, more may exist');
    expect(output.join('\n')).toContain('exclusions: requested #101, #202, #999; found in fetched page #101; not found in fetched page #202, #999');
    expect(output.join('\n')).toContain('exclusions may be affected by unreadable page rows');
    expect(output.join('\n')).toContain('planned after exclusions:');
  });

  it('supports disjoint selection and exclusion without altering global counts', async () => {
    const deps = fixture([row(101), row(202)]);
    expect(await cmdFleetBacklog(['--pr', '202', '--exclude-pr', '101', '--json'], deps)).toBe(0);
    const report = JSON.parse(output[0]!);
    expect(report).toMatchObject({ open: 2, tracked: 1, selection: { requested: [202], found: [202] },
      exclusions: { requested: [101], found: [101] }, counts: { conflicting: 1 } });
    expect(report.plan.recuts).toMatchObject([{ number: 202 }]);
  });

  it.each([undefined, '0', '-1', '1.5', 'abc', '9007199254740992', '--json'])(
    'rejects invalid exclusion %j before reads', async (value) => {
      const deps = fixture([]);
      expect(await cmdFleetBacklog(value === undefined ? ['--exclude-pr'] : ['--exclude-pr', value], deps)).toBe(2);
      expect(errors).toContain('--exclude-pr requires a positive safe integer');
      expect(deps.gh).not.toHaveBeenCalled();
      expect(deps.states).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['--pr', '101', '--exclude-pr', '0101'],
    ['--exclude-pr', '101', '--pr', '0101'],
  ])('rejects overlapping selection and exclusion in either order', async (...args) => {
    const deps = fixture([]);
    expect(await cmdFleetBacklog(args, deps)).toBe(2);
    expect(errors).toContain('PR #101 cannot be both selected and excluded');
    expect(deps.gh).not.toHaveBeenCalled();
    expect(deps.states).not.toHaveBeenCalled();
  });

  it('caps distinct exclusions, accepting repeats and rejecting the 101st before reads', async () => {
    const args = Array.from({ length: 100 }, (_, i) => ['--exclude-pr', String(i + 1)]).flat();
    const deps = fixture([]);
    expect(await cmdFleetBacklog([...args, '--exclude-pr', '001', '--json'], deps)).toBe(0);
    expect(JSON.parse(output[0]!).exclusions.requested).toHaveLength(100);
    deps.gh.mockClear();
    deps.states.mockClear();
    expect(await cmdFleetBacklog([...args, '--exclude-pr', '101'], deps)).toBe(2);
    expect(errors).toContain('at most 100 distinct PR numbers');
    expect(deps.gh).not.toHaveBeenCalled();
    expect(deps.states).not.toHaveBeenCalled();
  });
});
