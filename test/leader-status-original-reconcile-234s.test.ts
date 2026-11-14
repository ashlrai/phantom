/**
 * RQ-PHX-STATUSORIGINALRECONCILE234S: exact-preservation evidence for original
 * PR #4885 (RQ-PHX-STATUSREPLYCONTENT95, pinned source
 * 3e2d0d6c6e6de2efddbd1c865830176a9df1f338). Drives the real
 * composeOwnerStatusReply -> gatherStatusDigestInput -> buildStatusDigest chain
 * with deterministic readers through the supported overrides seam, and asserts
 * the original five facts reach the owner-facing answer. Complements
 * leader-status-digest.test.ts (unit facts) and leader-status-reply-path.test.ts
 * (Slack socket); nothing here touches live GitHub, a host inbox or Slack.
 */
import { describe, expect, it } from 'vitest';
import { composeOwnerStatusReply, OWNER_STATUS_FALLBACK, ownerStatusReply } from '../src/core/agents/owner-status-reply.js';
import { buildStatusDigest } from '../src/core/leader/status-digest.js';
import { gatherStatusDigestInput, type StatusDigestSources } from '../src/core/leader/status-digest-sources.js';

const HOUR = 3_600_000;
/** 2026-11-10 20:00Z is 15:00 Eastern (EST) — the heading clock's stamp. */
const NOW = new Date('2026-11-10T20:00:00Z');
const HEADING = 'Phantom status, 15:00 ET';
const RUNS_DIR = '/fake-runs-dir-234s';

const lane = (name: string, running: number, target: number, held = false, heldReason: string | null = null) => (
  { lane: name, running, target, held, heldReason, queued: 0, floor: null, ceiling: null, tokensLastHour: null, merged24h: null, mergeRate24h: null });

/** The original PR's fixture facts, all plainly fake. */
const originalFacts: Partial<StatusDigestSources> = {
  installedVersion: () => '3.29.15',
  publishedVersion: async () => '3.30.32',
  mergeFacts: async (sinceMs, nowMs) => ({
    mergeCountUnavailable: false,
    shipped: [
      ...Array.from({ length: nowMs - sinceMs <= HOUR ? 3 : 41 }, (_, i) => ({ text: `ashlrai/phantom#${i + 1}: fake merge` })),
      { text: 'ashlrai/ashlr-hub#7: a different repo' },
    ],
  }),
  runsState: async () => ({ runsDirPresent: true, sources: { status: 'healthy' } as never,
    lanes: [lane('claude', 4, 8), lane('idle', 0, 0), lane('codex-cmp', 0, 0, true, 'usage limit')] }),
  needs: () => ({ status: 'available', items: [
    { text: 'rotate the Stripe API key' }, { text: 'approve the $200 fake payment' }, { text: 'review the docs wording' }] }),
  inbox: async () => ({ sourceState: 'healthy', entries: [
    { at: '2026-11-10 14:58', source: 'Slack', priority: 'P2', text: 'a newer non-P0 note' },
    { at: '2026-11-10 14:48', source: 'Slack', priority: 'P0', text: 'Phantom status' },
    { at: '2026-11-10 09:00', source: 'Slack', priority: 'P0', text: 'an older p0' },
  ] }),
  // The claims line postdates the original contract: disabling the reader keeps
  // this reply the original five facts byte-for-byte (covered by -claims-314).
  workClaims: undefined,
};

/** Same construction as the production digestBrief: real gather + real build, readers injected. */
const briefFrom = (sources: Partial<StatusDigestSources>) => async (runsDir: string, at: Date) =>
  ['Morning leader brief', ...buildStatusDigest(await gatherStatusDigestInput(runsDir, at, sources))].join('\n');

describe('composeOwnerStatusReply preserves the original PR #4885 contract', () => {
  it('renders all five original facts in the owner-facing answer', async () => {
    const reply = await composeOwnerStatusReply(RUNS_DIR, NOW, { brief: briefFrom(originalFacts) });
    expect(reply).toBe([
      HEADING,
      'App: installed 3.29.15 · published 3.30.32 · update pending',
      'Merges: 3 in the last hour · 41 in the last 24h',
      'Lanes: claude 4/8 · held: codex-cmp (usage limit)',
      'Needs Mason: 2 hard-limit asks waiting',
      'Top P0: Phantom status (12m ago)',
    ].join('\n'));
  });

  it('keeps unknown and its reason for unreadable sources — no manufactured 0 or up-to-date', async () => {
    const dead: Partial<StatusDigestSources> = {
      installedVersion: () => null,
      publishedVersion: async () => { throw new Error('fake release read'); },
      mergeFacts: async () => ({ shipped: [], mergeCountUnavailable: true }),
      runsState: async () => { throw new Error('fake lane read'); },
      needs: () => { throw new Error('fake needs read'); },
      inbox: async () => { throw new Error('fake inbox read'); },
      workClaims: undefined,
    };
    const reply = await composeOwnerStatusReply(RUNS_DIR, NOW, { brief: briefFrom(dead) });
    expect(reply).toBe([
      HEADING,
      'App: installed unknown (installed app version not readable) · published unknown (published release not readable)',
      'Merges: unknown (GitHub merge count unavailable or incomplete) · unknown (GitHub merge count unavailable or incomplete)',
      'Lanes: unknown (lane state not readable)',
      'Needs Mason: unknown (NEEDS-MASON.md could not be read)',
      'Top P0: unknown (MASON-INBOX.md not readable)',
    ].join('\n'));
    expect(reply).not.toMatch(/update pending|up to date|\b0 in the last|none waiting|none in the inbox/);
  });

  it('bounds the answer at 1500 chars with a trailing ellipsis', async () => {
    const huge = { ...originalFacts, runsState: async () => ({ runsDirPresent: true, sources: { status: 'healthy' } as never,
      lanes: [lane(`fake-${'x'.repeat(1600)}`, 1, 2)] }) };
    const reply = await composeOwnerStatusReply(RUNS_DIR, NOW, { brief: briefFrom(huge) });
    expect(reply).toHaveLength(1500);
    expect(reply.endsWith('…')).toBe(true);
  });

  it('returns the fixed fallback when composition fails instead of rejecting', async () => {
    const brief = async () => { throw new Error('fake composition failure'); };
    await expect(composeOwnerStatusReply(RUNS_DIR, NOW, { brief })).resolves.toBe(OWNER_STATUS_FALLBACK);
    await expect(ownerStatusReply({ brief }).compose(RUNS_DIR, NOW)).resolves.toBe(OWNER_STATUS_FALLBACK);
  });

  it('keeps the wrapper contract: exact short asks answered, anything else left to the Leader', () => {
    const reply = ownerStatusReply();
    expect(reply.fallback).toBe(OWNER_STATUS_FALLBACK);
    for (const ask of ['status', 'Phantom status', 'fleet status', '/status', "what's the status", 'whats the status']) {
      expect(reply.ask(ask)).toBe(true);
    }
    for (const other of ['status of the release pr #12', 'status please update the roadmap']) {
      expect(reply.ask(other)).toBe(false);
    }
  });
});
