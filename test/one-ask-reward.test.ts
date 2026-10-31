import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Proposal } from '../src/core/types.js';
import { inspectOneAskReward, ONE_ASK_REWARD_WINDOW_MS } from '../src/core/fleet/one-ask-reward.js';
import { authenticatedRealizedMergeOf } from '../src/core/inbox/realized-merge.js';
import { inspectPostMergeWindow } from '../src/core/fleet/post-merge-window.js';

vi.mock('../src/core/inbox/realized-merge.js', () => ({ authenticatedRealizedMergeOf: vi.fn() }));
vi.mock('../src/core/fleet/post-merge-window.js', () => ({ inspectPostMergeWindow: vi.fn() }));

const merge = 'a'.repeat(40);
const start = Date.parse('2026-01-01T00:00:00.000Z');
const proposal = { repo: '/repo' } as Proposal;
const input = { outcome: { kind: 'merged' as const, proposal }, tokens: 200, weight: 4, nowMs: start + ONE_ASK_REWARD_WINDOW_MS };
const complete = {
  state: 'complete' as const, mergeCommit: merge, observedHead: 'b'.repeat(40),
  mergeTimeMs: start, windowStartedAtMs: start, followUpWindowEndMs: start + ONE_ASK_REWARD_WINDOW_MS,
  windowElapsed: true, commitsInspected: 0, adverse: null,
};

describe('one ask reward', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(authenticatedRealizedMergeOf).mockReturnValue({
      schemaVersion: 1, source: 'local-default-branch', base: 'main', baseBeforeOid: 'c'.repeat(40),
      proposalHeadOid: 'd'.repeat(40), mergeCommitOid: merge, observedAt: new Date(start).toISOString(),
      proposalId: 'p', diffHash: 'e'.repeat(64), intentAttestation: 'f'.repeat(64), attestation: 'f'.repeat(64),
    });
    vi.mocked(inspectPostMergeWindow).mockReturnValue(complete);
  });

  it('scores a stable authenticated merge as weight per token after 72 hours', () => {
    expect(inspectOneAskReward(input)).toEqual({ state: 'scored', outcome: 'stable', rewardPerToken: 0.02 });
    expect(inspectPostMergeWindow).toHaveBeenCalledWith({ repo: '/repo', mergeCommit: merge, observedAtMs: input.nowMs,
      followUpWindowMs: ONE_ASK_REWARD_WINDOW_MS, windowStartedAtMs: start });
  });
  it('waits until the exact 72-hour boundary using the real window inspector', async () => {
    const actual = await vi.importActual<typeof import('../src/core/fleet/post-merge-window.js')>(
      '../src/core/fleet/post-merge-window.js',
    );
    vi.mocked(inspectPostMergeWindow).mockImplementation((windowInput) => actual.inspectPostMergeWindow(windowInput, {
      runGit: ({ args }) => {
        if (args[0] === 'rev-parse') return { ok: true, stdout: Buffer.from(`${merge}\n`) };
        if (args[0] === 'merge-base') return { ok: true, stdout: Buffer.alloc(0) };
        if (args[0] === 'show') return { ok: true, stdout: Buffer.from(`${start / 1_000}\0${'c'.repeat(40)}\n`) };
        return { ok: true, stdout: Buffer.alloc(0) };
      },
    }));
    expect(inspectOneAskReward({ ...input, nowMs: input.nowMs - 1 })).toEqual({ state: 'unknown', reason: 'window-pending' });
    expect(inspectOneAskReward(input)).toEqual({ state: 'scored', outcome: 'stable', rewardPerToken: 0.02 });
  });
  it('scores publish-only as zero without inspecting a merge', () => {
    expect(inspectOneAskReward({ ...input, outcome: { kind: 'published' } })).toEqual({ state: 'scored', outcome: 'published', rewardPerToken: 0 });
    expect(authenticatedRealizedMergeOf).not.toHaveBeenCalled();
    expect(inspectPostMergeWindow).not.toHaveBeenCalled();
  });
  it('scores a deterministic revert negatively even before the window elapses', () => {
    vi.mocked(inspectPostMergeWindow).mockReturnValue({ ...complete, windowElapsed: false,
      adverse: { outcome: 'reverted', basis: 'git-revert-reference', confidence: 'deterministic', commit: 'b'.repeat(40) } });
    expect(inspectOneAskReward(input)).toEqual({ state: 'scored', outcome: 'reverted', rewardPerToken: -0.02 });
  });
  it('keeps unelapsed, inconclusive and heuristic follow-up observations unknown', () => {
    vi.mocked(inspectPostMergeWindow).mockReturnValue({ ...complete, windowElapsed: false });
    expect(inspectOneAskReward(input)).toEqual({ state: 'unknown', reason: 'window-pending' });
    vi.mocked(inspectPostMergeWindow).mockReturnValue({ state: 'inconclusive', reason: 'head-moved' });
    expect(inspectOneAskReward(input)).toEqual({ state: 'unknown', reason: 'inspection-inconclusive' });
    vi.mocked(inspectPostMergeWindow).mockReturnValue({ ...complete, adverse: { outcome: 'followed-up', basis: 'overlapping-fix', confidence: 'heuristic', commit: 'b'.repeat(40) } });
    expect(inspectOneAskReward(input)).toEqual({ state: 'unknown', reason: 'follow-up-observed' });
  });
  it('never accepts a proposal without an authenticated merge', () => {
    vi.mocked(authenticatedRealizedMergeOf).mockReturnValue(null);
    expect(inspectOneAskReward(input)).toEqual({ state: 'unknown', reason: 'no-authenticated-merge' });
    expect(inspectPostMergeWindow).not.toHaveBeenCalled();
  });
  it('uses the host merge time for the 72-hour window', () => {
    vi.mocked(authenticatedRealizedMergeOf).mockReturnValue({ schemaVersion: 1, source: 'github-host', provider: 'github',
      prUrl: 'https://github.com/a/b/pull/1', branch: 'feature', base: 'main', expectedHeadOid: 'd'.repeat(40),
      mergeCommitOid: merge, mergedAt: new Date(start).toISOString(),
      reconciliation: { schemaVersion: 1, observedAt: new Date(start + 1_000).toISOString(), attestation: 'f'.repeat(64) } });
    inspectOneAskReward(input);
    expect(inspectPostMergeWindow).toHaveBeenCalledWith(expect.objectContaining({ windowStartedAtMs: start }));
  });
  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid token count %s', (tokens) => {
    expect(inspectOneAskReward({ ...input, tokens })).toEqual({ state: 'unknown', reason: 'invalid-usage' });
  });
  it.each([0, -1, NaN, Infinity, Number.MIN_VALUE])('rejects invalid or unrepresentable weight %s', (weight) => {
    expect(inspectOneAskReward({ ...input, weight })).toEqual({ state: 'unknown', reason: 'invalid-weight' });
  });
});
