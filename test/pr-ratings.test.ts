import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hashDiff, signLocalMergeIntent, signLocalRealizedMergeReceipt } from '../src/core/foundry/provenance.js';
import { buildPrRatings, readPrRatings } from '../src/core/fleet/pr-ratings.js';
import { readPostMergeObservations, recordPostMergeObservation } from '../src/core/fleet/post-merge-observations.js';
import { readPostMergeStability, recordPostMergeStabilityCohort } from '../src/core/fleet/post-merge-stability.js';
import { readDetachedPostMergeVerificationCohorts, recordDetachedPostMergeVerificationCohort } from '../src/core/fleet/detached-post-merge-verification.js';
import type { Proposal, ProposalLocalMergeIntent } from '../src/core/types.js';
import * as git from '../src/core/git.js';
import * as github from '../src/core/integrations/github.js';
import { viewPrWithReconciliation } from '../src/core/inbox/remote-handoff-attestation.js';

let home: string;
let originalHome: string | undefined;
let originalAshlrHome: string | undefined;
const NOW = Date.parse('2026-10-13T20:00:00.000Z');
const MERGED = '2026-10-01T00:00:00.000Z';
const STABLE = '2026-10-08T00:00:00.000Z';
const healthy = { sourceState: 'healthy' as const, complete: true };
beforeEach(() => {
  originalHome = process.env.HOME;
  originalAshlrHome = process.env.ASHLR_HOME;
  home = mkdtempSync(join(tmpdir(), 'phantom-pr-ratings-'));
  process.env.HOME = home;
  process.env.ASHLR_HOME = join(home, '.ashlr');
});
afterEach(() => {
  vi.restoreAllMocks();
  if (originalHome === undefined) delete process.env.HOME; else process.env.HOME = originalHome;
  if (originalAshlrHome === undefined) delete process.env.ASHLR_HOME; else process.env.ASHLR_HOME = originalAshlrHome;
  rmSync(home, { recursive: true, force: true });
});
function proposal(id = 'rated-pr', ambition = 5): Proposal {
  const repo = join(home, id);
  mkdirSync(repo);
  const diff = '--- a/f.ts\n+++ b/f.ts\n@@\n-a\n+b\n';
  const diffHash = hashDiff(diff);
  const intent: Omit<ProposalLocalMergeIntent, 'attestation'> = { schemaVersion: 1, branch: `codex/${id}`,
    base: 'main', baseBeforeOid: '1'.repeat(40), proposalHeadOid: '2'.repeat(40), diffHash,
    evidencePackDigest: '4'.repeat(64), authorizationId: '5'.repeat(32), authorizedAt: MERGED };
  const intentAttestation = signLocalMergeIntent(id, repo, intent);
  const merge = { schemaVersion: 1 as const, source: 'local-default-branch' as const, base: 'main',
    baseBeforeOid: intent.baseBeforeOid, proposalHeadOid: intent.proposalHeadOid, mergeCommitOid: '3'.repeat(40),
    observedAt: MERGED, proposalId: id, diffHash, intentAttestation };
  return { id, repo, status: 'applied', origin: 'swarm', kind: 'pr', title: 'private title', summary: 'private summary',
    createdAt: MERGED, diff, diffHash, localMergeIntent: { ...intent, attestation: intentAttestation },
    realizedMerge: { ...merge, attestation: signLocalRealizedMergeReceipt(id, repo, merge) },
    verifyResult: { passed: true, baseHead: intent.baseBeforeOid, diffHash }, riskClass: 'high',
    taste: { alignment: 5, ambition, design: 4, overall: 5, verdict: 'gold', rationale: 'private rationale' } };
}
function stable(p: Proposal, overrides: Record<string, unknown> = {}, fail = false) {
  expect(recordDetachedPostMergeVerificationCohort({ cohortId: `detached-${p.id}`, observedAt: '2026-10-08T00:02:00.000Z',
    expectedMemberCount: 1, members: [{ repo: p.repo!, proposalId: p.id, baseBranch: 'main', baseHead: '1'.repeat(40),
      candidateHead: '2'.repeat(40), mergeCommit: '3'.repeat(40),
      verifierManifest: { digest: '7'.repeat(64), commandCount: 2 }, sourceState: 'healthy', terminal: fail ? 'fail' : 'pass',
      ...(fail ? { failureCategory: 'code' as const } : {}),
      verifiedHead: '3'.repeat(40), verifiedAt: '2026-10-08T00:01:00.000Z', workspaceClean: true, isolation: 'detached-worktree' }] })).toBe('recorded');
  expect(recordPostMergeStabilityCohort({ cohortId: `cohort-${p.id}`, completedAt: '2026-10-08T00:02:00.000Z',
    witnesses: [{ cohortId: `cohort-${p.id}`, repo: p.repo!, proposalId: p.id, mergeCommit: '3'.repeat(40),
      observedHead: '3'.repeat(40), windowStartedAt: MERGED, stableAt: STABLE, windowMs: 7 * 86400000,
      verificationDigest: '7'.repeat(64), schemaVersion: 2, verificationIsolation: 'detached-worktree',
      workspaceClean: true, requiredCommandCount: 2, verifiedAt: '2026-10-08T00:01:00.000Z', ...overrides, ...(overrides.schemaVersion === 1 ? { verifiedAt: undefined, verificationIsolation: undefined, workspaceClean: undefined, requiredCommandCount: undefined } : {}) }] })).toMatchObject({ recorded: 1 });
}
const read = (proposals: Proposal[]) => readPrRatings(proposals, healthy, Date.parse('2026-09-20'), NOW);

describe('longitudinal PR ratings', () => {
  it('withholds positive reward before an exact manifested detached verification window', () => {
    const p = proposal();
    expect(read([p]).ratings[0]).toMatchObject({ status: 'unobserved', advisoryReward: null });
    stable(p);
    const rating = read([p]).ratings[0]!;
    expect(rating).toMatchObject({ status: 'verified-window', advisoryReward: 96, proposalHeadOid: '2'.repeat(40),
      mergeCommitOid: '3'.repeat(40), observedHeadOid: '3'.repeat(40), impactEstimate: { source: 'critic-estimate', confidence: null } });
    expect(rating.diffHash).toBe(hashDiff(p.diff!));
    expect(rating.ratingDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(read([p]))).not.toMatch(/private title|private summary|private rationale/);
    expect(read([p])).toMatchObject({ authority: 'observation-only', policyEligible: false });
  });
  it('rewards validated ambition without rewarding risk alone', () => {
    const bold = proposal('bold', 5), small = proposal('small', 2);
    stable(bold); stable(small);
    const ratings = read([bold, small]).ratings;
    expect(ratings.find((r) => r.proposalId === bold.id)!.advisoryReward).toBeGreaterThan(ratings.find((r) => r.proposalId === small.id)!.advisoryReward!);
    bold.riskClass = 'low';
    expect(read([bold]).ratings[0]!.advisoryReward).toBe(96);
  });
  it('updates the same event rating when signed revert evidence supersedes stability', () => {
    const p = proposal(); stable(p);
    const before = read([p]).ratings[0]!;
    expect(recordPostMergeObservation({ proposalId: p.id, repo: p.repo!, mergeCommit: '3'.repeat(40), observedHead: '8'.repeat(40),
      observedAt: '2026-10-10T00:00:00.000Z', outcome: 'reverted', basis: 'git-revert-reference', confidence: 'deterministic' })).toMatchObject({ recorded: 1 });
    const after = read([p]).ratings[0]!;
    expect(after).toMatchObject({ status: 'reverted', advisoryReward: -100, eventDigest: before.eventDigest });
    expect(after.ratingDigest).not.toBe(before.ratingDigest);
  });
  it.each(['regressed', 'followed-up'] as const)('penalizes %s evidence without treating it as successful delivery', (outcome) => {
    const p = proposal();
    expect(recordPostMergeObservation({ proposalId: p.id, repo: p.repo!, mergeCommit: '3'.repeat(40), observedHead: '8'.repeat(40),
      observedAt: '2026-10-10T00:00:00.000Z', outcome, basis: outcome === 'regressed' ? 'bisect-first-bad' : 'overlapping-fix',
      confidence: outcome === 'regressed' ? 'deterministic' : 'heuristic' })).toMatchObject({ recorded: 1 });
    expect(read([p]).ratings[0]).toMatchObject({ status: outcome, advisoryReward: outcome === 'regressed' ? -80 : -20 });
  });
  it('rejects forged merges and withholds reward for a tampered diff', () => {
    const p = proposal(); stable(p);
    const forged = { ...p, realizedMerge: { ...p.realizedMerge!, attestation: '0'.repeat(64) } } as Proposal;
    expect(read([forged]).ratings).toEqual([]);
    p.diff += '+changed after verification\n';
    expect(read([p]).ratings[0]).toMatchObject({ status: 'unknown', advisoryReward: null });
  });
  it.each([{ mergeCommit: '9'.repeat(40) }, { schemaVersion: 1 }, { verificationIsolation: 'clean-workspace' },
    { observedHead: '6'.repeat(40) }, { verificationDigest: '9'.repeat(64) }, { requiredCommandCount: 3 }])(
    'withholds positive reward for a mismatched or legacy witness %j', (overrides) => {
      const p = proposal(); stable(p, overrides);
      expect(read([p]).ratings[0]).toMatchObject({ status: 'unobserved', advisoryReward: null });
    });
  it('never treats another merge adverse evidence as this PR regression', () => {
    const p = proposal(); stable(p);
    expect(recordPostMergeObservation({ proposalId: p.id, repo: p.repo!, mergeCommit: '9'.repeat(40), observedHead: '8'.repeat(40),
      observedAt: '2026-10-10T00:00:00.000Z', outcome: 'reverted', basis: 'git-revert-reference', confidence: 'deterministic' })).toMatchObject({ recorded: 1 });
    expect(read([p]).ratings[0]).toMatchObject({ status: 'verified-window', advisoryReward: 96 });
  });
  it('keeps incomplete sources and invalid critic values unknown', () => {
    const p = proposal(); stable(p);
    const input = { proposals: [p], proposalSource: healthy, adverse: readPostMergeObservations(), stability: readPostMergeStability(), detached: readDetachedPostMergeVerificationCohorts(), sinceMs: 0, nowMs: NOW };
    expect(buildPrRatings({ ...input, adverse: { ...input.adverse, complete: false } })).toMatchObject({ complete: false, ratings: [{ status: 'unknown', advisoryReward: null }] });
    expect(buildPrRatings({ ...input, detached: { ...input.detached, complete: false } })).toMatchObject({ complete: false, ratings: [{ status: 'unknown', advisoryReward: null }] });
    expect(buildPrRatings({ ...input, proposalSource: { ...healthy, complete: false } })).toMatchObject({ candidateCount: null, ratings: [] });
    p.taste!.ambition = Number.NaN;
    expect(read([p]).ratings[0]).toMatchObject({ status: 'verified-window', impactEstimate: null, advisoryReward: null });
  });
  it('does not accept future stability as already verified', () => {
    const p = proposal(); stable(p);
    const input = { proposals: [p], proposalSource: healthy, adverse: readPostMergeObservations(), stability: readPostMergeStability(), detached: readDetachedPostMergeVerificationCohorts(), sinceMs: 0, nowMs: Date.parse('2026-10-07') };
    expect(buildPrRatings(input).ratings[0]).toMatchObject({ status: 'unobserved', advisoryReward: null });
  });
  it('is wired into the real scorecard CLI/API model', async () => {
    const { computeFleetScorecard } = await import('../src/core/fleet/scorecard.js');
    expect(computeFleetScorecard('7d').prRatings).toMatchObject({ authority: 'observation-only', policyEligible: false, ratings: [] });
  });
  it('bounds history rows and reports incomplete coverage rather than a complete cohort', () => {
    const rows = Array.from({ length: 65 }, (_, i) => proposal(`bounded-${i}`));
    const report = read(rows);
    expect(report).toMatchObject({ capped: true, complete: false, candidateCount: null });
    expect(report.ratings.length).toBeLessThanOrEqual(64);
    expect(Buffer.byteLength(JSON.stringify(report.ratings))).toBeLessThanOrEqual(64 * 1024);
    expect(report.reasons).toContain('rating-limit');
  });
  it('rejects duplicate authenticated merge identities and invalid windows', () => {
    const p = proposal();
    expect(read([p, p])).toMatchObject({ complete: false, ratings: [], reasons: expect.arrayContaining(['duplicate-merge-identity']) });
    expect(readPrRatings([p], healthy, Number.NaN, NOW)).toMatchObject({ complete: false, candidateCount: null, reasons: ['invalid-rating-window'] });
  });
  it('retains a 12-day-old merge whose stable witness matured five days ago in a seven-day scorecard', () => {
    const p = proposal(); stable(p);
    const result = readPrRatings([p], healthy, NOW - 7 * 86400000, NOW);
    expect(result.ratings[0]).toMatchObject({ status: 'verified-window', advisoryReward: 96 });
    expect(result.lookbackStartedAt).toBe(new Date(NOW - 90 * 86400000).toISOString());
    expect(result.scorecardWindowStartedAt).toBe(new Date(NOW - 7 * 86400000).toISOString());
  });
  it('penalizes an exact signed detached code failure even beside a stable-window label', () => {
    const p = proposal(); stable(p, {}, true);
    expect(recordPostMergeObservation({ proposalId: p.id, repo: p.repo!, mergeCommit: '3'.repeat(40), observedHead: '8'.repeat(40),
      observedAt: '2026-10-10T00:00:00.000Z', outcome: 'followed-up', basis: 'overlapping-fix', confidence: 'heuristic' })).toMatchObject({ recorded: 1 });
    expect(read([p]).ratings[0]).toMatchObject({ status: 'verification-failed', advisoryReward: -60 });
  });
  it('tracks an authenticated GitHub PR and refuses a replaced diff despite matching mutable hashes', () => {
    const p = proposal();
    const pushUrl = 'https://github.com/example/fixture.git';
    vi.spyOn(git, 'resolveGitHubOriginAuthorityDetails').mockReturnValue({ nameWithOwner: 'example/fixture', pushUrls: [pushUrl] } as ReturnType<typeof git.resolveGitHubOriginAuthorityDetails>);
    vi.spyOn(git, 'resolveGitHubOriginAuthority').mockReturnValue('example/fixture');
    const authority = { provider: 'github' as const, nameWithOwner: 'example/fixture',
      pushAuthorityDigest: createHash('sha256').update(JSON.stringify(['ashlr.github-push-authority.v1', 'example/fixture', [pushUrl]])).digest('hex') };
    const intent = { ...p.localMergeIntent!, remoteAuthority: authority };
    intent.authorizationId = createHash('sha256').update(JSON.stringify(['ashlr.remote-handoff-authorization.v1', 'pre-effect',
      authority.provider, authority.nameWithOwner, authority.pushAuthorityDigest, intent.schemaVersion, intent.branch,
      intent.base, intent.baseBeforeOid, intent.proposalHeadOid, intent.diffHash, intent.evidencePackDigest, intent.authorizedAt, ''])).digest('hex').slice(0, 32);
    intent.attestation = signLocalMergeIntent(p.id, p.repo!, intent);
    p.localMergeIntent = intent;
    const handoff = { provider: 'github' as const, state: 'awaiting-host-merge' as const, branch: intent.branch,
      base: intent.base, expectedHeadOid: intent.proposalHeadOid, prUrl: 'https://github.com/example/fixture/pull/17',
      authority, intentAttestation: intent.attestation, createdAt: MERGED };
    vi.spyOn(github, 'viewPr').mockReturnValue({ url: handoff.prUrl, headRefName: handoff.branch, baseRefName: 'main',
      headRefOid: intent.proposalHeadOid, mergedAt: MERGED, mergeCommitOid: '3'.repeat(40) } as ReturnType<typeof github.viewPr>);
    const reconciled = viewPrWithReconciliation(p.repo!, handoff.prUrl, p.id, handoff);
    expect(reconciled?.reconciliation).toBeDefined();
    p.remoteHandoff = { ...handoff, state: 'merged', mergedAt: MERGED, mergeCommitOid: '3'.repeat(40), reconciliation: reconciled!.reconciliation };
    p.realizedMerge = { schemaVersion: 1, source: 'github-host', provider: 'github', prUrl: handoff.prUrl,
      branch: handoff.branch, base: handoff.base, expectedHeadOid: intent.proposalHeadOid, mergeCommitOid: '3'.repeat(40),
      mergedAt: MERGED, reconciliation: reconciled!.reconciliation! };
    stable(p);
    expect(read([p]).ratings[0]).toMatchObject({ status: 'verified-window', githubPr: { url: handoff.prUrl, number: 17, repository: 'example/fixture' }, mergeSource: 'github-host' });
    p.diff += '+replacement\n'; p.diffHash = hashDiff(p.diff); p.verifyResult!.diffHash = p.diffHash;
    expect(read([p]).ratings[0]).toMatchObject({ status: 'unknown', advisoryReward: null });
  });
});
