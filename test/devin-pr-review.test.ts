import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { DevinClient, parseDevinPrReview, type DevinFetch } from '../src/core/devin/client.js';
import { devinPrReviewKey, parseDevinPrRef, planDevinPrReview, readDevinReviewFindings, triggerDevinPrReviewOnce, type DevinPrReviewDeps } from '../src/core/devin/pr-review.js';
import { runDevinCli } from '../src/cli/devin.js';
import type { HostMergeDeps } from '../src/core/fleet/host-merge.js';

const SHA = 'a'.repeat(40);
const KEY = 'cog_fake_review_key_abcdefghijklmnopqrstuvwxyz';
const response = { status: 'pending', repo_path: 'github.com/o/r', pr_number: 1, commit_sha: SHA, created_at: '2026-11-01T00:00:00Z' };
function harness(status = 200, body: unknown = response) {
  const calls: Array<{ url: string; init: Parameters<DevinFetch>[1] }> = [];
  const client = new DevinClient({ apiKey: KEY, sleep: async () => {}, fetch: async (url, init) => {
    calls.push({ url, init });
    return { status, headers: { get: () => null }, text: async () => JSON.stringify(body) };
  } });
  const deps: DevinPrReviewDeps = {
    config: () => ({ enabled: true }), now: () => new Date('2026-11-01T12:00:00Z'),
    journalPath: join(mkdtempSync(join(tmpdir(), 'review-')), 'reviews.jsonl'),
    weeklyCapacity: () => ({ remaining: 10 }), connectedClient: async () => ({ client, orgId: 'org-test' }),
  };
  const input = { repo: 'o/r', number: 1, headSha: SHA, origin: 'cli' as const };
  return { client, calls, deps, input };
}
describe('Devin Review', () => {
  it('posts the exact manual review request and reads the latest review', async () => {
    const h = harness();
    expect(await h.client.triggerPrReview('org-test', 'https://github.com/o/r/pull/1')).toEqual(response);
    expect(h.calls[0]?.url).toBe('https://api.devin.ai/v3/organizations/org-test/pr-reviews');
    expect(h.calls[0]?.init.method).toBe('POST');
    expect(h.calls[0]?.init.headers['Authorization']).toBe(`Bearer ${KEY}`);
    expect(JSON.parse(h.calls[0]!.init.body!)).toEqual({ pr_url: 'https://github.com/o/r/pull/1' });
    await h.client.getPrReview('org-test', 'https://github.com/o/r/pull/1', SHA);
    expect(h.calls[1]?.init.method).toBe('GET');
    expect(h.calls[1]?.url).toContain(`commit_sha=${SHA}`);
    expect(JSON.stringify(h.client)).not.toContain(KEY);
  });
  it('parses references and fails closed on malformed responses and URLs', async () => {
    expect(parseDevinPrRef('#1', 'o/r')?.prUrl).toBe('https://github.com/o/r/pull/1');
    expect(parseDevinPrRef('1', null)).toBeNull();
    expect(parseDevinPrRef('https://evil.com/o/r/pull/1', null)).toBeNull();
    for (const patch of [{ status: 'future' }, { status: ['pending'] }, { pr_number: 1.2 }, { commit_sha: 'xyz' }, { created_at: null }]) expect(parseDevinPrReview({ ...response, ...patch })).toBeNull();
    expect(parseDevinPrReview(null)).toBeNull();
    const h = harness();
    await expect(h.client.triggerPrReview('org-test', 'https://evil.com/o/r/pull/1')).rejects.toMatchObject({ code: 'invalid-request' });
    expect(h.calls).toHaveLength(0);
  });
  it('reserves each case-insensitive repo/PR/head once and allows a new head', async () => {
    const h = harness();
    expect(devinPrReviewKey('O/R', 1, SHA.toUpperCase())).toBe(`o/r#1@${SHA}`);
    expect((await triggerDevinPrReviewOnce(h.input, h.deps)).ok).toBe(true);
    expect(await triggerDevinPrReviewOnce({ ...h.input, repo: 'O/R' }, h.deps)).toMatchObject({ reason: 'duplicate' });
    expect(h.calls).toHaveLength(1);
    expect((await triggerDevinPrReviewOnce({ ...h.input, headSha: 'b'.repeat(40) }, h.deps)).ok).toBe(true);
    expect(h.calls).toHaveLength(2);
    expect(readFileSync(h.deps.journalPath!, 'utf8')).not.toContain(KEY);
  });
  it('enforces disabled, invalid, daily, unknown-plan and auth refusals before contact', async () => {
    const h = harness();
    for (const [patch, reason] of [
      [{ config: () => ({ enabled: false }) }, 'disabled'],
      [{ config: () => ({ enabled: true, review: { maxPerDay: 0 } }) }, 'disabled'],
      [{ weeklyCapacity: () => null }, 'unknown-plan'],
      [{ weeklyCapacity: () => ({ remaining: null }) }, 'unknown-plan'],
      [{ connectedClient: async () => ({ error: 'missing', failure: 'not-connected' as const }) }, 'missing-auth'],
      [{ weeklyCapacity: () => ({ remaining: 0 }) }, 'quota-exhausted'],
    ] as const) expect(await triggerDevinPrReviewOnce(h.input, { ...h.deps, ...patch })).toMatchObject({ reason });
    expect(await triggerDevinPrReviewOnce({ ...h.input, headSha: 'bad' }, h.deps)).toMatchObject({ reason: 'invalid-pr' });
    expect(h.calls).toHaveLength(0);
    const capped = { ...h.deps, config: () => ({ enabled: true, review: { maxPerDay: 1 } }) };
    await triggerDevinPrReviewOnce(h.input, capped);
    expect(await triggerDevinPrReviewOnce({ ...h.input, number: 2 }, capped)).toMatchObject({ reason: 'daily-cap' });
    expect(h.calls).toHaveLength(1);
  });
  it.each([
    [401, { detail: KEY }, 'request-failed', 'auth', 1],
    [429, {}, 'request-failed', 'rate-limited', 3],
    [402, {}, 'quota-exhausted', 'unknown', 1],
    [403, { error_code: 'on_demand_billing' }, 'quota-exhausted', 'forbidden', 1],
    [422, { detail: 'quota exhausted' }, 'quota-exhausted', 'invalid-request', 1],
  ])('maps HTTP %s safely and reserves ambiguous requests', async (status, body, reason, _code, count) => {
    const h = harness(status as number, body);
    const result = await triggerDevinPrReviewOnce(h.input, h.deps);
    expect(result).toMatchObject({ ok: false, reason });
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(h.calls).toHaveLength(count as number);
    const second = await triggerDevinPrReviewOnce({ ...h.input, number: reason === 'quota-exhausted' ? 2 : 1 }, h.deps);
    expect(second).toMatchObject({ reason: reason === 'quota-exhausted' ? reason : 'duplicate' });
    expect(h.calls).toHaveLength(count as number);
  });
  it('keeps provider error codes safe and bounded', async () => {
    const h = harness(403, { error_code: 'on_demand_billing', detail: KEY });
    await expect(h.client.triggerPrReview('org-test', 'https://github.com/o/r/pull/1')).rejects.toMatchObject({ errorCode: 'on_demand_billing' });
    const unsafe = harness(403, { error_code: KEY });
    await expect(unsafe.client.triggerPrReview('org-test', 'https://github.com/o/r/pull/1')).rejects.toMatchObject({ errorCode: null });
  });
  it('reads only pinned bot findings and returns null for unreadable GitHub data', async () => {
    const transport = vi.fn(async () => ({ status: 200, body: [
      { user: { login: 'devin-ai-integration[bot]' }, commit_id: SHA, body: 'a\nb', path: 'x.ts', line: 3 },
      { user: { login: 'other' }, commit_id: SHA, body: 'ignore' },
      { user: { login: 'devin-ai-integration[bot]' }, commit_id: 'old', body: 'ignore' },
    ] }));
    const host = { token: async () => ({ token: 'test', expiresAt: null }), transport } as unknown as HostMergeDeps;
    expect(await readDevinReviewFindings('o/r', 1, SHA, host)).toMatchObject({ count: 2, items: [{ body: 'a b' }, { body: 'a b' }] });
    transport.mockResolvedValueOnce({ status: 500, body: [] });
    expect(await readDevinReviewFindings('o/r', 1, SHA, host)).toBeNull();
    transport.mockResolvedValue({ status: 200, body: [] });
    expect(await readDevinReviewFindings('o/r', 1, SHA, host)).toEqual({ count: 0, items: [] });
  });
  it('defaults CLI to a handle-only plan and rejects unknown flags', async () => {
    const out: string[] = [];
    const deps = { out: (s: string) => out.push(s), err: () => {}, originRepo: () => 'o/r', cwd: () => '.' };
    expect(await runDevinCli(['review', '#1', '--json'], deps)).toBe(0);
    expect(JSON.parse(out[0]!)).toEqual(planDevinPrReview(parseDevinPrRef('1', 'o/r')!, null));
    expect(out.join('')).toContain('keychain:ai.ashlr.devin/api-key');
    expect(out.join('')).not.toContain('cog_');
    expect(await runDevinCli(['review', '#1', '--unknown'], deps)).toBe(2);
    expect(await runDevinCli(['review', '#1', '--apply', '--dry-run'], deps)).toBe(2);
  });
});
