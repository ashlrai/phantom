import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { decideCrossReviewAtHead, runCrossReview } from '../src/core/fleet/cross-review-run.js';
import type { CrossReviewPolicy, CrossReviewRequest } from '../src/core/fleet/cross-review.js';

const reads = vi.hoisted(() => ({ pr: vi.fn(), required: vi.fn(), checks: vi.fn() }));
vi.mock('../src/core/fleet/host-merge.js', () => ({
  defaultHostMergeDeps: () => ({}), readPr: reads.pr, readRequiredChecks: reads.required, readHeadChecks: reads.checks,
}));

const HEAD = 'a'.repeat(40);
const pr = { headSha: HEAD, state: 'open', baseRef: 'master' };
const run = (name = 'Merge Gate', conclusion: string | null = 'success', status = 'completed', appId = '15368', id = 1) =>
  ({ name, conclusion, status, appId, id });
const policy: CrossReviewPolicy = {
  schemaVersion: 1, allowedRepos: ['ashlrai/phantom'], selfRepos: [], denylist: [], maxDiffBytes: 524288,
  reviewers: [{ pool: 'reviewer', model: 'local:fixture', bin: '/fixture/reviewer', args: [], credentialEnv: [], timeoutMs: 1000 }],
};
let home: string;
let request: CrossReviewRequest;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'check-gate-'));
  vi.stubEnv('ASHLR_HOME', home);
  const diffFile = join(home, 'pr.diff');
  writeFileSync(diffFile, 'diff --git a/src/strings.ts b/src/strings.ts\n--- a/src/strings.ts\n+++ b/src/strings.ts\n@@ -1 +1 @@\n-export const a = 1;\n+export const a = 2;\n');
  request = {
    schemaVersion: 1, repo: 'ashlrai/phantom', pr: 6102, headSha: HEAD,
    producer: { pool: 'producer', model: 'codex:gpt-5' }, title: 'Fixture', body: '', diffFile, codeownersFile: null,
  };
  reads.pr.mockReset().mockResolvedValue(pr);
  reads.required.mockReset().mockResolvedValue({ required: [{ context: 'Merge Gate', appId: '15368' }] });
  reads.checks.mockReset().mockResolvedValue({ runs: [run()], statuses: [] });
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
});

async function decide() {
  const { decision } = await runCrossReview(request, policy, {
    runReviewer: async () => ({ ok: true, verdict: { verdict: 'approve', reasons: ['correct-and-scoped'] } }),
  });
  const journal = readFileSync(join(home, 'fleet', 'cross-review.jsonl'), 'utf8');
  expect(JSON.parse(journal.trim().split('\n').at(-1)!)).toEqual(decision);
  return decision;
}

describe('fleet cross-review head check gate', () => {
  it.each(['failure', 'timed_out', 'action_required', 'startup_failure'])(
    'holds a non-required %s even with a successful Merge Gate', async conclusion => {
      reads.checks.mockResolvedValue({ runs: [run(), run('Quick typecheck', conclusion)], statuses: [] });
      expect(await decide()).toMatchObject({
        action: 'hold', checkStatus: 'hold', codes: ['checks-not-successful'], matchHeadCommit: null,
        checkDetail: `held: Quick typecheck (non-required): ${conclusion}`,
      });
      expect(reads.checks).toHaveBeenCalledWith('ashlrai/phantom', HEAD, expect.anything());
    },
  );

  it('waits for a non-required pending run, then arms only after it succeeds', async () => {
    reads.checks.mockResolvedValue({ runs: [run(), run('Quick typecheck', null, 'in_progress')], statuses: [] });
    expect(await decide()).toMatchObject({ action: 'hold', checkStatus: 'wait', matchHeadCommit: null });
    reads.checks.mockResolvedValue({ runs: [run(), run('Quick typecheck')], statuses: [] });
    expect(await decideCrossReviewAtHead(request, policy, HEAD))
      .toMatchObject({ action: 'enable-auto-merge', checkStatus: 'ready', matchHeadCommit: HEAD });
  });

  it('arms an all-green head, allowing skipped and neutral non-required checks', async () => {
    reads.checks.mockResolvedValue({ runs: [run(), run('Quick typecheck'), run('Daily CI', 'skipped'), run('Review', 'neutral')], statuses: [] });
    expect(await decide()).toMatchObject({ action: 'enable-auto-merge', checkStatus: 'ready', matchHeadCommit: HEAD });
    expect(reads.pr).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['empty', { runs: [], statuses: [] }],
    ['missing runs', { statuses: [] }],
    ['missing statuses', { runs: [run()] }],
    ['missing conclusion', { runs: [run(), run('Quick typecheck', null)], statuses: [] }],
    ['unknown status', { runs: [run(), run('Quick typecheck', null, 'unknown')], statuses: [] }],
    ['invalid run', { runs: [run(), { name: 'Quick typecheck' }], statuses: [] }],
    ['unreadable', 'API unavailable'],
  ])('holds %s check evidence', async (_name, checks) => {
    reads.checks.mockResolvedValue(checks);
    expect(await decide()).toMatchObject({ action: 'hold', checkStatus: 'hold', matchHeadCommit: null });
  });

  it('holds read errors without exposing the error body', async () => {
    reads.checks.mockRejectedValue(new Error('PRIVATE_RESPONSE_BODY'));
    expect(await decide()).toMatchObject({ action: 'hold', checkStatus: 'hold', codes: ['checks-unreadable'] });
    expect(readFileSync(join(home, 'fleet', 'cross-review.jsonl'), 'utf8')).not.toContain('PRIVATE_RESPONSE_BODY');
  });

  it('holds a failed same-named check from a non-required App', async () => {
    reads.checks.mockResolvedValue({ runs: [run(), run('Merge Gate', 'failure', 'completed', '999')], statuses: [] });
    expect(await decide()).toMatchObject({ action: 'hold', checkDetail: 'held: Merge Gate (non-required): failure' });
  });

  it('does not hide a failure behind pending or newer successful observations', async () => {
    reads.checks.mockResolvedValue({ runs: [run(), run('Quick typecheck', 'failure'), run('Quick typecheck', 'success', 'completed', '15368', 2), run('Review', null, 'queued')], statuses: [] });
    expect(await decide()).toMatchObject({ action: 'hold', checkStatus: 'hold', checkDetail: expect.stringContaining('Quick typecheck') });
  });

  it.each(['cancelled', 'stale'])('holds an inconclusive %s non-required run', async conclusion => {
    reads.checks.mockResolvedValue({ runs: [run(), run('Quick typecheck', conclusion)], statuses: [] });
    expect(await decide()).toMatchObject({ action: 'hold', checkStatus: 'hold', matchHeadCommit: null });
  });

  it('holds a failed non-required commit status and waits on a pending one', async () => {
    reads.checks.mockResolvedValue({ runs: [run()], statuses: [{ context: 'external-ci', state: 'error' }] });
    expect(await decide()).toMatchObject({ action: 'hold', checkStatus: 'hold', checkDetail: 'held: external-ci (non-required): error' });
    reads.checks.mockResolvedValue({ runs: [run()], statuses: [{ context: 'external-ci', state: 'pending' }] });
    expect(await decideCrossReviewAtHead(request, policy, HEAD)).toMatchObject({ action: 'hold', checkStatus: 'wait' });
  });

  it('still requires the pinned App and refuses a head that moved during reads', async () => {
    reads.checks.mockResolvedValue({ runs: [run('Merge Gate', 'success', 'completed', '999')], statuses: [] });
    expect(await decide()).toMatchObject({ action: 'hold', codes: ['checks-missing'] });
    reads.checks.mockResolvedValue({ runs: [run()], statuses: [] });
    reads.pr.mockResolvedValueOnce(pr).mockResolvedValueOnce({ ...pr, headSha: 'b'.repeat(40) });
    expect(await decideCrossReviewAtHead(request, policy, HEAD)).toMatchObject({ action: 'hold', codes: ['checks-stale'] });
  });

  it('bounds check diagnostics and removes terminal controls', async () => {
    reads.checks.mockResolvedValue({ runs: [run(), run('Quick\n\u001b[31m typecheck' + 'x'.repeat(500), 'failure')], statuses: [] });
    const decision = await decide();
    expect(decision.checkDetail!.length).toBeLessThanOrEqual(400);
    expect(decision.checkDetail).not.toContain('\n');
    expect(decision.checkDetail).not.toContain('\u001b');
  });
});

describe('tier1-verify end to end (RQ-TIER1-AGENTIC-1)', () => {
  const tier1Diff = [
    'diff --git a/src/core/authority/clamp.ts b/src/core/authority/clamp.ts', 'index 1111111..2222222 100644', '--- a/src/core/authority/clamp.ts', '+++ b/src/core/authority/clamp.ts',
    '@@ -1 +1 @@', '-export const LIMIT = 2;', '+export const LIMIT = 3;',
    'diff --git a/test/authority-clamp.test.ts b/test/authority-clamp.test.ts', 'index 3333333..4444444 100644', '--- a/test/authority-clamp.test.ts', '+++ b/test/authority-clamp.test.ts',
    '@@ -0,0 +1 @@', '+it("clamps at 3", () => {});', '',
  ].join('\n');
  const tier1Policy: CrossReviewPolicy = {
    ...policy,
    reviewers: [
      { pool: 'mac-b', model: 'local:fixture-a', bin: '/fixture/a', args: [], credentialEnv: [], timeoutMs: 1000 },
      { pool: 'mac-c', model: 'local:fixture-b', bin: '/fixture/b', args: [], credentialEnv: [], timeoutMs: 1000 },
    ],
    tier1: { enabled: true, fullChecks: ['CI (Node 22, *'] },
  };
  beforeEach(() => {
    writeFileSync(request.diffFile, tier1Diff);
    reads.checks.mockResolvedValue({ runs: [run(), run('CI (Node 22, shard 1/4)', 'success', 'completed', '15368', 2)], statuses: [] });
  });

  it('asks two different seats (standard, then semantic) and arms auto-merge with the full suite green', async () => {
    const asked: { pool: string; tier1: boolean }[] = [];
    const { review, decision } = await runCrossReview(request, tier1Policy, {
      runReviewer: async (reviewer, prompt) => {
        asked.push({ pool: reviewer.pool, tier1: prompt.includes('Tier-1 authority code') });
        return { ok: true, verdict: { verdict: 'approve', reasons: ['correct-and-scoped'] } };
      },
    });
    expect(asked).toEqual([{ pool: 'mac-b', tier1: false }, { pool: 'mac-c', tier1: true }]);
    expect(review.semantic).toMatchObject({ reviewerPool: 'mac-c', outcome: 'approve' });
    expect(decision).toMatchObject({ action: 'enable-auto-merge', codes: ['verdict-approve', 'tier1-verified'], matchHeadCommit: HEAD });
  });

  it('waits for the full suite, and rejects a semantic out-of-scope verdict with a fix job', async () => {
    reads.checks.mockResolvedValue({ runs: [run()], statuses: [] });
    const approve = async () => ({ ok: true as const, verdict: { verdict: 'approve' as const, reasons: ['correct-and-scoped' as const] } });
    expect((await runCrossReview(request, tier1Policy, { runReviewer: approve })).decision)
      .toMatchObject({ action: 'hold', codes: ['tier1-full-ci-missing'], checkStatus: 'wait', matchHeadCommit: null });
    const { decision } = await runCrossReview(request, tier1Policy, {
      runReviewer: async (reviewer) => reviewer.pool === 'mac-c'
        ? { ok: true, verdict: { verdict: 'reject', reasons: ['out-of-scope'] } } : approve(),
    });
    expect(decision).toMatchObject({ action: 'reject', codes: ['tier1-semantic-reject', 'semantic:out-of-scope'] });
    expect(decision.fixJob).toMatch(/^- READY RQ-T1FIX-phantom-6102-aaaaaaa /);
  });

  it('never asks a model about a GATES v3 floor change', async () => {
    writeFileSync(request.diffFile, 'diff --git a/contrib/mac/publish.sh b/contrib/mac/publish.sh\n--- a/contrib/mac/publish.sh\n+++ b/contrib/mac/publish.sh\n@@ -1 +1 @@\n-echo a\n+echo b\n');
    const ask = vi.fn();
    const { review, decision } = await runCrossReview(request, tier1Policy, { runReviewer: ask });
    expect(ask).not.toHaveBeenCalled();
    expect(review.outcome).toBe('skipped');
    expect(decision).toMatchObject({ action: 'escalate', codes: expect.arrayContaining(['tier1-floor', 'floor-security-pin']) });
  });
});
