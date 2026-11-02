import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetBacklog, type FleetBacklogDeps } from '../src/cli/fleet-backlog.js';
import { cmdFleet } from '../src/cli/fleet.js';
import { newFleetMergeState, type FleetMergeStateV1 } from '../src/core/fleet/fleet-merge-state.js';

const SHA = 'a'.repeat(40);

/** One `gh pr list --json` row; overrides shape each classification lane. */
function ghRow(number: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    number, state: 'OPEN', isDraft: false,
    headRefOid: SHA, headRefName: `fleet/${number}`, baseRefName: 'main',
    isCrossRepository: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
    statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }],
    ...over,
  };
}

const ghOk = (rows: unknown[]): FleetBacklogDeps['gh'] =>
  async () => ({ ok: true, stdout: JSON.stringify(rows), stderr: '' });
const noStates: FleetBacklogDeps['states'] = () => new Map();
const clock = () => new Date('2026-10-31T00:00:00.000Z');

/** A merge-state record whose stored head no longer matches the gh head → head-moved. */
function trackedRecord(number: number, headSha: string): FleetMergeStateV1 {
  const record = newFleetMergeState({
    key: `prop-${number}`, kind: 'change', proposalId: `prop-${number}`, revertsLandingId: null,
    repo: 'ashlrai/phantom', repoPath: '/tmp/fake', enforcement: null, nowIso: '2026-10-31T00:00:00.000Z',
  });
  record.pr = {
    number, nodeId: 'N', repositoryId: 'R', branch: `fleet/${number}`, baseBranch: 'main',
    baseSha: 'c'.repeat(40), headSha, treeSha: 'd'.repeat(40), ownerLane: false, ownerLaneReason: null,
    openedAt: '2026-10-31T00:00:00.000Z', ledgered: true, state: 'open', closedBy: null,
    nextCheckAt: null, checkBackoffMs: 0, checks: null, wouldMergeHeadSha: null,
  };
  return record;
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

const plan = () => JSON.parse(output.join('\n')) as {
  v: number; repo: string; open: number; complete: boolean; tracked: number; unreadable: number;
  counts: { ready: number; conflicting: number; behind: number; repair: number; waiting: number };
  plan: Record<'merges' | 'recuts' | 'refreshes' | 'deferred',
    { number: number | null; record: string; classification: { class: string; reason: string } }[]>;
};

describe('ashlr fleet backlog', () => {
  it('classifies a mixed backlog and joins merge-state records', async () => {
    const states: FleetBacklogDeps['states'] = () =>
      new Map([[6, { state: 'ok', record: trackedRecord(6, 'b'.repeat(40)) }]]);
    const deps: FleetBacklogDeps = {
      gh: ghOk([
        ghRow(1),                                                        // green-ready → merges
        ghRow(2, { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }), // conflicted → recuts
        ghRow(3, { mergeStateStatus: 'BEHIND' }),                        // behind → refreshes
        ghRow(4, { isDraft: true }),                                     // draft → waiting
        ghRow(5, { statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' }] }), // repair
        ghRow(6),                                                        // tracked, head moved → waiting
        { number: 'unreadable' },                                        // gh row fails validation → waiting
      ]),
      states,
      now: clock,
    };
    expect(await cmdFleetBacklog(['--json'], deps)).toBe(0);
    const report = plan();
    expect(report.v).toBe(1);
    expect(report.repo).toBe('ashlrai/phantom');
    expect(report.open).toBe(7);
    expect(report.complete).toBe(true);
    expect(report.tracked).toBe(1);
    expect(report.unreadable).toBe(1);
    expect(report.counts).toEqual({ ready: 1, conflicting: 1, behind: 1, repair: 1, waiting: 3 });
    expect(report.plan.merges.map((e) => e.number)).toEqual([1]);
    expect(report.plan.recuts.map((e) => e.number)).toEqual([2]);
    expect(report.plan.refreshes.map((e) => e.number)).toEqual([3]);
    expect(report.plan.deferred.map((e) => e.number)).toEqual([4, 5, 6, null]);
    expect(report.plan.deferred[2]).toMatchObject({ number: 6, record: 'ok', classification: { class: 'pending', reason: 'head-moved' } });
    expect(report.plan.deferred[3]!.number).toBeNull();
    expect(report.plan.deferred[3]!.classification.class).toBe('unknown');
    expect(errors).toBe('');
  });

  it('respects --repo and bounded --merges/--recuts lanes', async () => {
    const calls: string[][] = [];
    const gh: FleetBacklogDeps['gh'] = async (args) => { calls.push([...args]); return ghOk([ghRow(1), ghRow(2), ghRow(3)])(args); };
    expect(await cmdFleetBacklog(['--repo', 'acme/app', '--merges', '2', '--recuts', '0', '--json'], { gh, states: noStates, now: clock })).toBe(0);
    expect(calls).toEqual([['pr', 'list', '--repo', 'acme/app', '--state', 'open', '--limit', '500',
      '--json', 'number,state,isDraft,headRefOid,headRefName,baseRefName,isCrossRepository,mergeable,mergeStateStatus,statusCheckRollup']]);
    const report = plan();
    expect(report.repo).toBe('acme/app');
    expect(report.plan.merges).toHaveLength(2);
    expect(report.plan.deferred.map((e) => e.number)).toEqual([3]);
  });

  it('reports an empty backlog as empty, not as an error', async () => {
    expect(await cmdFleetBacklog(['--json'], { gh: ghOk([]), states: noStates, now: clock })).toBe(0);
    const report = plan();
    expect(report.open).toBe(0);
    expect(report.counts).toEqual({ ready: 0, conflicting: 0, behind: 0, repair: 0, waiting: 0 });
    expect(report.plan.merges).toEqual([]);
    output = [];
    expect(await cmdFleetBacklog([], { gh: ghOk([]), states: noStates, now: clock })).toBe(0);
    expect(output.join('\n')).toContain('0 open PR(s)');
  });

  it('a failed gh read exits nonzero with a message and never prints a plan', async () => {
    const gh: FleetBacklogDeps['gh'] = async () => ({ ok: false, stdout: '', stderr: 'gh: not authenticated' });
    expect(await cmdFleetBacklog(['--json'], { gh, states: noStates })).toBe(1);
    expect(errors).toContain('fleet backlog: could not read open PRs for ashlrai/phantom');
    expect(errors).toContain('gh: not authenticated');
    expect(output).toEqual([]);
    errors = '';
    const garbage: FleetBacklogDeps['gh'] = async () => ({ ok: true, stdout: '<html>rate limited</html>', stderr: '' });
    expect(await cmdFleetBacklog([], { gh: garbage, states: noStates })).toBe(1);
    expect(errors).toContain('not JSON');
    expect(output).toEqual([]);
  });

  it('prints the category summary in text mode', async () => {
    const deps: FleetBacklogDeps = { gh: ghOk([ghRow(1), ghRow(2, { mergeable: 'CONFLICTING' })]), states: noStates, now: clock };
    expect(await cmdFleetBacklog([], deps)).toBe(0);
    const text = output.join('\n');
    expect(text).toContain('Fleet backlog (ashlrai/phantom): 2 open PR(s)');
    expect(text).toContain('1 ready, 0 behind, 1 conflicting, 0 repair, 0 waiting');
    expect(text).toContain('#1');
    expect(text).toContain('#2');
  });

  it.each([
    ['--repo'], ['--repo', 'not a repo'], ['--limit'], ['--limit', 'abc'], ['--limit', '0'],
    ['--merges', '-1'], ['--recuts', '1.5'], ['--json', '--json'], ['extra'], ['--bogus'],
  ])('rejects bad arguments %j without reading gh', async (...args) => {
    const gh = vi.fn();
    expect(await cmdFleetBacklog(args, { gh, states: noStates })).toBe(2);
    expect(gh).not.toHaveBeenCalled();
    expect(errors).toContain('usage:');
  });

  it('is reachable through `fleet backlog` with option and help pre-checks', async () => {
    expect(await cmdFleet(['backlog', '--bogus'])).toBe(2);
    expect(errors).toContain('fleet backlog:');
    expect(await cmdFleet(['backlog', '--help'])).toBe(0);
    expect(output.join('\n')).toContain('ashlr fleet backlog');
  });
});
