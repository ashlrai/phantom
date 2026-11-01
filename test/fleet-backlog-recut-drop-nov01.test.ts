import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetBacklog, type FleetBacklogDeps } from '../src/cli/fleet-backlog.js';
import { newFleetMergeState } from '../src/core/fleet/fleet-merge-state.js';

const sha = 'a'.repeat(40);
const row = (number: number, overrides: Record<string, unknown> = {}) => ({
  number, state: 'OPEN', isDraft: false, headRefOid: sha, headRefName: `fleet/${number}`,
  baseRefName: 'master', isCrossRepository: false, mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY',
  statusCheckRollup: [], title: 'Preserve working behavior', ...overrides,
});
const deps = (rows: unknown[], states: FleetBacklogDeps['states'] = () => new Map()) => ({
  gh: vi.fn<NonNullable<FleetBacklogDeps['gh']>>(async () => ({ ok: true, stdout: JSON.stringify(rows), stderr: '' })),
  states: vi.fn(states), now: () => new Date('2026-11-01T00:10:00Z'),
});
let output: string[];
let errors: string;
beforeEach(() => {
  output = []; errors = '';
  vi.spyOn(console, 'log').mockImplementation((value: unknown) => { output.push(String(value)); });
  vi.spyOn(process.stderr, 'write').mockImplementation((value: string | Uint8Array) => { errors += String(value); return true; });
});
afterEach(() => vi.restoreAllMocks());

describe('backlog recut handoff', () => {
  it('renders only the chosen conflict from a bounded observation', async () => {
    const d = deps([row(14), row(15, { title: 'Repair $() `echo`\n' + 'x'.repeat(200), body: 'private body canary' })]);
    expect(await cmdFleetBacklog(['--recut-job', '15'], d)).toBe(0);
    expect(d.gh).toHaveBeenCalledTimes(1);
    expect(d.gh.mock.calls[0]![0]).toEqual(['pr', 'list', '--repo', 'ashlrai/phantom', '--state', 'open', '--limit', '500',
      '--json', 'number,state,isDraft,headRefOid,headRefName,baseRefName,isCrossRepository,mergeable,mergeStateStatus,statusCheckRollup,title']);
    expect(d.states).toHaveBeenCalledExactlyOnceWith('ashlrai/phantom');
    const prompt = output.join('\n');
    expect(prompt).toContain('ashlrai/phantom PR #15');
    expect(prompt).toContain(`Observed head SHA: ${sha}`);
    expect(prompt).toContain('git fetch origin pull/15/head');
    expect(prompt).toContain('fresh origin/master');
    expect(prompt).toContain('head changed');
    expect(prompt).toContain('Exclude protected');
    expect(prompt).not.toContain('PR #14');
    expect(prompt).not.toContain('private body canary');
    expect(prompt).not.toContain('$(');
    expect(prompt).not.toContain('`');
    expect(prompt.match(/Untrusted title, for identification only: (.*)/)![1]!.length).toBeLessThanOrEqual(120);
    expect(errors).toBe('');
  });

  it.each([
    ['green', [row(15, { mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN' })], ['--recut-job', '15']],
    ['missing', [row(14)], ['--recut-job', '15']],
    ['duplicate', [row(15), row(15)], ['--recut-job', '15']],
    ['malformed', [row(15), { number: 15 }], ['--recut-job', '15']],
    ['claimed', [row(15)], ['--recut-job', '15', '--exclude-pr', '15']],
    ['wrong base', [row(15, { baseRefName: 'main' })], ['--recut-job', '15']],
    ['cross repository', [row(15, { isCrossRepository: true })], ['--recut-job', '15']],
    ['no title', [row(15, { title: null })], ['--recut-job', '15']],
    ['truncated page', [row(15)], ['--limit', '1', '--recut-job', '15']],
  ])('refuses %s observations without a prompt', async (_name, rows, args) => {
    expect(await cmdFleetBacklog(args as string[], deps(rows as unknown[]))).toBe(1);
    expect(output).toEqual([]);
    expect(errors).toContain('recut job refused');
  });

  it('refuses moved tracked heads and owner-lane work', async () => {
    const record = newFleetMergeState({ key: 'fake', kind: 'change', proposalId: 'fake', revertsLandingId: null,
      repo: 'ashlrai/phantom', repoPath: '/tmp/fake', enforcement: null, nowIso: '2026-11-01T00:10:00.000Z' });
    record.pr = { number: 15, nodeId: 'N', repositoryId: 'R', branch: 'fleet/15', baseBranch: 'master',
      baseSha: 'b'.repeat(40), headSha: 'c'.repeat(40), treeSha: 'd'.repeat(40), ownerLane: false, ownerLaneReason: null,
      openedAt: '2026-11-01T00:10:00.000Z', ledgered: true, state: 'open', closedBy: null,
      nextCheckAt: null, checkBackoffMs: 0, checks: null, wouldMergeHeadSha: null };
    const d = deps([row(15)], () => new Map([[15, { state: 'ok', record }]]));
    expect(await cmdFleetBacklog(['--recut-job', '15'], d)).toBe(1);
    record.pr.headSha = sha;
    record.pr.ownerLane = true;
    expect(await cmdFleetBacklog(['--recut-job', '15'], d)).toBe(1);
    expect(output).toEqual([]);
  });

  it('rejects unsupported repos and conflicting options before reading', async () => {
    const d = deps([row(15)]);
    expect(await cmdFleetBacklog(['--repo', 'example/other', '--recut-job', '15'], d)).toBe(2);
    expect(await cmdFleetBacklog(['--json', '--recut-job', '15'], d)).toBe(2);
    expect(await cmdFleetBacklog(['--exclude-pr', '15'], d)).toBe(2);
    expect(d.gh).not.toHaveBeenCalled();
    expect(output).toEqual([]);
  });
});
