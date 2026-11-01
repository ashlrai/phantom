import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetBacklog, type FleetBacklogDeps } from '../src/cli/fleet-backlog.js';
import { newFleetMergeState } from '../src/core/fleet/fleet-merge-state.js';

const sha = 'a'.repeat(40);
const now = () => new Date('2026-10-31T00:00:00.000Z');
const row = (number: number, conflicting = false) => ({
  number, state: 'OPEN', isDraft: false, headRefOid: sha,
  headRefName: `fleet/${number}`, baseRefName: 'main', isCrossRepository: false,
  mergeable: conflicting ? 'CONFLICTING' : 'MERGEABLE',
  mergeStateStatus: conflicting ? 'DIRTY' : 'CLEAN',
  statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }],
});

function fixture(rows: unknown[]) {
  const gh = vi.fn<NonNullable<FleetBacklogDeps['gh']>>(async () => ({ ok: true, stdout: JSON.stringify(rows), stderr: '' }));
  const record = newFleetMergeState({
    key: 'release', kind: 'change', proposalId: 'release', revertsLandingId: null,
    repo: 'ashlrai/phantom', repoPath: '/tmp/fake', enforcement: null, nowIso: now().toISOString(),
  });
  record.pr = {
    number: 101, nodeId: 'N', repositoryId: 'R', branch: 'fleet/101', baseBranch: 'main',
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

describe('fleet backlog explicit PR selection', () => {
  it('plans only normalized requested PRs from one page and one state read', async () => {
    const deps = fixture([row(101), row(202, true), row(303)]);
    expect(await cmdFleetBacklog(['--pr', '101', '--pr', '202', '--pr', '0101', '--json'], deps)).toBe(0);
    const report = JSON.parse(output[0]!);
    expect(deps.gh).toHaveBeenCalledTimes(1);
    expect(deps.gh.mock.calls[0]![0]).toEqual(['pr', 'list', '--repo', 'ashlrai/phantom', '--state', 'open', '--limit', '500', '--json',
      'number,state,isDraft,headRefOid,headRefName,baseRefName,isCrossRepository,mergeable,mergeStateStatus,statusCheckRollup']);
    expect(deps.states).toHaveBeenCalledExactlyOnceWith('ashlrai/phantom');
    expect(report).toMatchObject({ open: 3, complete: true, tracked: 1, unreadable: 0,
      selection: { requested: [101, 202], found: [101, 202], missing: [], complete: true },
      counts: { ready: 1, conflicting: 1, behind: 0, repair: 0, waiting: 0 } });
    expect(report.plan.merges).toMatchObject([{ number: 101, record: 'ok' }]);
    expect(report.plan.recuts).toMatchObject([{ number: 202 }]);
    expect(report.plan.refreshes).toEqual([]);
    expect(report.plan.deferred).toEqual([]);
  });

  it('keeps missing PRs unknown and page completeness separate, including an empty selection', async () => {
    const deps = fixture([row(101), row(303)]);
    expect(await cmdFleetBacklog(['--limit', '2', '--pr', '999', '--json'], deps)).toBe(0);
    const report = JSON.parse(output[0]!);
    expect(report).toMatchObject({ open: 2, complete: false,
      selection: { requested: [999], found: [], missing: [999], complete: false },
      counts: { ready: 0, conflicting: 0, behind: 0, repair: 0, waiting: 0 } });
    expect(Object.values(report.plan).flat()).toEqual([]);
    output = [];
    expect(await cmdFleetBacklog(['--pr', '101', '--pr', '999'], deps)).toBe(0);
    expect(output.join('\n')).toContain('selection incomplete: requested #101, #999; found #101; missing from fetched page #999');
    expect(output.join('\n')).not.toContain('#303');
  });

  it('keeps a capped page incomplete even when all requested PRs are found', async () => {
    const deps = fixture([row(101), row(303)]);
    expect(await cmdFleetBacklog(['--limit', '2', '--pr', '101', '--json'], deps)).toBe(0);
    expect(JSON.parse(output[0]!)).toMatchObject({ complete: false, selection: { complete: true, missing: [] } });
  });

  it('treats unreadable and duplicate observations conservatively', async () => {
    const deps = fixture([row(101), { number: 101 }, row(202, true)]);
    expect(await cmdFleetBacklog(['--pr', '101', '--pr', '202', '--json'], deps)).toBe(0);
    const report = JSON.parse(output[0]!);
    expect(report.selection).toEqual({ requested: [101, 202], found: [202], missing: [101], complete: false });
    expect(report.plan.merges).toEqual([]);
    expect(report.plan.recuts).toMatchObject([{ number: 202 }]);
    output = [];
    expect(await cmdFleetBacklog(['--pr', '101', '--json'], fixture([row(101), row(101)]))).toBe(0);
    const duplicate = JSON.parse(output[0]!);
    expect(duplicate.plan.merges).toEqual([]);
    expect(duplicate.plan.deferred).toMatchObject([
      { number: 101, classification: { class: 'unknown', reason: 'duplicate-pr-observation' } },
      { number: 101, classification: { class: 'unknown', reason: 'duplicate-pr-observation' } },
    ]);
  });

  it.each([undefined, '0', '-1', '1.5', 'abc', '9007199254740992', '--json'])(
    'rejects malformed PR argument %j before any reads', async (value) => {
      const deps = fixture([]);
      expect(await cmdFleetBacklog(value === undefined ? ['--pr'] : ['--pr', value], deps)).toBe(2);
      expect(deps.gh).not.toHaveBeenCalled();
      expect(deps.states).not.toHaveBeenCalled();
      expect(errors).toContain('--pr requires a positive safe integer');
    },
  );

  it('preserves the default JSON and text output when no selection is requested', async () => {
    const deps = fixture([]);
    expect(await cmdFleetBacklog(['--json'], deps)).toBe(0);
    expect(JSON.parse(output[0]!)).toEqual({
      v: 1, repo: 'ashlrai/phantom', generatedAt: '2026-10-31T00:00:00.000Z', open: 0, complete: true,
      tracked: 0, unreadable: 0, counts: { ready: 0, conflicting: 0, behind: 0, repair: 0, waiting: 0 },
      plan: { merges: [], recuts: [], refreshes: [], deferred: [] },
    });
    output = [];
    expect(await cmdFleetBacklog([], deps)).toBe(0);
    expect(output).toEqual([
      'Fleet backlog (ashlrai/phantom): 0 open PR(s), 0 tracked by merge-state records',
      '  0 ready, 0 behind, 0 conflicting, 0 repair, 0 waiting',
      '  merges (green-ready):    —', '  recuts (refix):        —',
      '  refreshes (re-base):  —', '  deferred:            —',
    ]);
  });
});
