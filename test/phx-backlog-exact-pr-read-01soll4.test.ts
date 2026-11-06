import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetBacklog, FLEET_BACKLOG_USAGE, type FleetBacklogDeps } from '../src/cli/fleet-backlog.js';
import { FLEET_PR_GH_VIEW_FIELDS, newFleetMergeState } from '../src/core/fleet/fleet-merge-state.js';

const row = (number: number, overrides: Record<string, unknown> = {}) => ({
  number, state: 'OPEN', isDraft: false, headRefOid: 'a'.repeat(40),
  headRefName: `fleet/${number}`, baseRefName: 'main', isCrossRepository: false,
  mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
  statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }],
  ...overrides,
});
const ok = (value: unknown) => ({ ok: true, stdout: JSON.stringify(value), stderr: '' });
const noStates: FleetBacklogDeps['states'] = () => new Map();
let output: string[];
let errors: string;
beforeEach(() => {
  output = []; errors = '';
  vi.spyOn(console, 'log').mockImplementation((message: unknown) => { output.push(String(message)); });
  vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { errors += String(chunk); return true; });
});
afterEach(() => vi.restoreAllMocks());
const report = () => JSON.parse(output.join('\n'));

describe('fleet backlog exact PR reads', () => {
  it('classifies an explicitly selected PR beyond a full page, once per distinct number', async () => {
    const calls: string[][] = [];
    const gh: NonNullable<FleetBacklogDeps['gh']> = async (args) => {
      calls.push([...args]);
      return args[1] === 'list' ? ok([row(1), row(2)]) : ok(row(900, { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }));
    };
    expect(await cmdFleetBacklog(['--repo', 'example/project', '--limit', '2', '--pr', '900', '--pr', '0900', '--json'], { gh, states: noStates })).toBe(0);
    expect(calls).toEqual([
      ['pr', 'list', '--repo', 'example/project', '--state', 'open', '--limit', '2', '--json', FLEET_PR_GH_VIEW_FIELDS],
      ['pr', 'view', '900', '--repo', 'example/project', '--json', FLEET_PR_GH_VIEW_FIELDS],
    ]);
    expect(report()).toMatchObject({ open: 2, complete: false, selection: { requested: [900], found: [900], missing: [], complete: true },
      counts: { conflicting: 1 }, plan: { recuts: [{ number: 900, classification: { class: 'conflicted' } }], merges: [] } });
  });

  it('joins direct results to local state before classification', async () => {
    const record = newFleetMergeState({ key: 'fake-1', kind: 'change', proposalId: 'fake-1', revertsLandingId: null,
      repo: 'example/project', repoPath: '/tmp/fake', enforcement: null, nowIso: '2026-11-01T00:00:00.000Z' });
    record.pr = { number: 42, nodeId: 'fake', repositoryId: 'fake', branch: 'fleet/42', baseBranch: 'main',
      baseSha: 'c'.repeat(40), headSha: 'b'.repeat(40), treeSha: 'd'.repeat(40), ownerLane: false, ownerLaneReason: null,
      openedAt: '2026-11-01T00:00:00.000Z', ledgered: true, state: 'open', closedBy: null,
      nextCheckAt: null, checkBackoffMs: 0, checks: null, wouldMergeHeadSha: null };
    const gh: NonNullable<FleetBacklogDeps['gh']> = async (args) => ok(args[1] === 'list' ? [] : row(42));
    expect(await cmdFleetBacklog(['--pr', '42', '--json'], { gh, states: () => new Map([[42, { state: 'ok', record }]]) })).toBe(0);
    expect(report().plan.deferred[0]).toMatchObject({ number: 42, classification: { reason: 'head-moved' } });
    expect(report().plan.merges).toEqual([]);
  });

  it('reports not found, closed, merged, mismatched and failed views without actionable entries', async () => {
    const gh: NonNullable<FleetBacklogDeps['gh']> = async (args) => {
      if (args[1] === 'list') return ok([]);
      switch (Number(args[2])) {
        case 1: return ok(null);
        case 2: return ok(row(2, { state: 'CLOSED', mergeable: 'CONFLICTING' }));
        case 3: return ok(row(3, { state: 'MERGED' }));
        case 4: return ok(row(400));
        case 5: return { ok: false, stdout: '', stderr: 'fake read failure' };
        default: return { ok: true, stdout: '{', stderr: '' };
      }
    };
    const args = ['--pr', '1', '--pr', '2', '--pr', '3', '--pr', '4', '--pr', '5', '--pr', '6'];
    expect(await cmdFleetBacklog([...args, '--json'], { gh, states: noStates })).toBe(1);
    expect(report()).toMatchObject({ complete: true, selection: { found: [], missing: [1, 2, 3, 4, 5, 6], complete: false,
      notFound: [1], notOpen: [{ number: 2, state: 'CLOSED' }, { number: 3, state: 'MERGED' }],
      lookupFailures: [{ number: 4, reason: 'PR number mismatch' }, { number: 5, reason: 'gh pr view failed' },
        { number: 6, reason: 'gh pr view failed or returned invalid JSON' }] }, plan: { merges: [], recuts: [] } });
    output = [];
    expect(await cmdFleetBacklog(args, { gh, states: noStates })).toBe(1);
    expect(output.join('\n')).toContain('selection incomplete');
    expect(output.join('\n')).toContain('selection #2: closed (not open)');
    expect(output.join('\n')).toContain('selection #4: PR number mismatch');
    expect(output.join('\n')).toContain('selection not found: #1');
  });

  it('does not replace malformed or duplicate page observations with exact reads', async () => {
    const gh = vi.fn(async () => ok([row(1), { number: 1 }, row(2), row(2)]));
    expect(await cmdFleetBacklog(['--pr', '1', '--pr', '2', '--json'], { gh, states: noStates })).toBe(0);
    expect(gh).toHaveBeenCalledTimes(1);
    expect(report()).toMatchObject({ selection: { found: [], missing: [1, 2], complete: false, ambiguous: [1, 2] },
      plan: { merges: [], recuts: [], deferred: [{ number: 2, classification: { reason: 'duplicate-pr-observation' } },
        { number: 2, classification: { reason: 'duplicate-pr-observation' } }] } });
  });

  it('bounds concurrent views and rejects excess distinct selections before any read', async () => {
    let active = 0; let max = 0;
    const gh: NonNullable<FleetBacklogDeps['gh']> = async (args) => {
      if (args[1] === 'list') return ok([]);
      active++; max = Math.max(max, active);
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return ok(row(Number(args[2])));
    };
    const args = Array.from({ length: 20 }, (_, i) => ['--pr', String(i + 1)]).flat();
    expect(await cmdFleetBacklog([...args, '--json'], { gh, states: noStates })).toBe(0);
    expect(max).toBe(4);
    expect(report().selection.complete).toBe(true);
    const never = vi.fn();
    expect(await cmdFleetBacklog([...args, '--pr', '21'], { gh: never, states: noStates })).toBe(2);
    expect(never).not.toHaveBeenCalled();
    expect(errors).toContain('at most 20 distinct');
    expect(FLEET_BACKLOG_USAGE).toContain('up to 20 distinct');
  });

  it('keeps the default path to one list call and rejects unknown options', async () => {
    const gh = vi.fn(async () => ok([row(1)]));
    expect(await cmdFleetBacklog(['--json'], { gh, states: noStates })).toBe(0);
    expect(gh).toHaveBeenCalledTimes(1);
    expect(report().selection).toBeUndefined();
    gh.mockClear();
    expect(await cmdFleetBacklog(['--pr', '2', '--unexpected'], { gh, states: noStates })).toBe(2);
    expect(gh).not.toHaveBeenCalled();
  });
});
