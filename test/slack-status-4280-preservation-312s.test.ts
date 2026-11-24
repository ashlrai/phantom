/**
 * RQ-PHX-STATUS4280RECONCILE312S: source-linked preservation evidence for
 * original PR #4280 (RQ-PHX-SLACKSTATUSREPLY09, observed head
 * be021041ba7d2f6e2eb77cb9928afa022fc3cd5f). The original
 * src/core/agents/leader-status-reply.ts module is gone; its descendants are
 * owner-status-reply.ts (isOwnerStatusRequest/composeOwnerStatusReply/
 * ownerStatusReply), fleet/status-ask.ts and leader/status-digest*.ts, with the
 * Slack adapter taking an injected statusReply seam instead of importing the
 * composer (slack-leader.ts is inside the Tier-1 closure).
 *
 * This suite replays the ORIGINAL test/leader-status-reply.test.ts request
 * examples through today's real isOwnerStatusRequest and pins the intentional
 * differences: the shared matcher now strips ALL trailing punctuation (the
 * original rejected 'status??'), accepts the wider operator phrase set, and
 * bounds asks at 40 chars (the original used 100). Socket-level behavior is
 * already proven by slack-leader-status-reply.test.ts,
 * slack-status-original-preservation-259s.test.ts and
 * leader-status-digest-owner-309s.test.ts; compose/digest facts by
 * leader-status-digest.test.ts, owner-status-reply.test.ts and
 * leader-status-original-reconcile-234s.test.ts. Fake ids only; no network,
 * credentials, real message text or outbound sends.
 */
import { describe, expect, it } from 'vitest';
import { composeOwnerStatusReply, isOwnerStatusRequest, OWNER_STATUS_FALLBACK, ownerStatusReply } from '../src/core/agents/owner-status-reply.js';

const NOW = new Date('2026-11-13T18:00:00Z');

describe('original #4280 isStatusRequest examples through isOwnerStatusRequest', () => {
  // Original accepts (test/leader-status-reply.test.ts `accepts %j`).
  it.each([
    'status',
    'Phantom status',
    ' fleet status ',
    'status?',
    "What's the status?",
    'whats the status.',
    'PHANTOM STATUS',
  ])('still accepts original ask %j', text => {
    expect(isOwnerStatusRequest(text)).toBe(true);
  });

  // Original rejects (test/leader-status-reply.test.ts `rejects %j`).
  it.each([
    'status of PR 4245',
    'phantom status and release plan',
    '',
    'x'.repeat(500),
    'please review PR 4245',
  ])('still rejects original non-ask %j', text => {
    expect(isOwnerStatusRequest(text)).toBe(false);
  });

  it('intentionally accepts status?? — the shared matcher strips all trailing punctuation', () => {
    // Original PHRASES lookup rejected 'status??' (only one [?.] was stripped).
    // isStatusAsk strips /[?.!]+$/, so repeated punctuation still normalises
    // to 'status'. This is the deliberate broadened acceptance, not a
    // regression: the ask remains exact-match after normalisation.
    expect(isOwnerStatusRequest('status??')).toBe(true);
    expect(isOwnerStatusRequest('status!?!')).toBe(true);
    expect(isOwnerStatusRequest('status of PR 4245?')).toBe(false);
  });

  it('intentionally accepts the wider shared status-ask phrases the original never listed', () => {
    // Parity with the desktop/operator surfaces (status-ask-101.test.ts,
    // owner-status-ask-parity-134.test.ts): '/status', 'glance', "what's up",
    // "how's the fleet" etc. are status asks everywhere now.
    for (const text of ['/status', '/status@MyBot', 'glance', "what's up", "what's running", "how's the fleet", 'how are we']) {
      expect(isOwnerStatusRequest(text), text).toBe(true);
    }
  });

  it('keeps asks exact after normalisation — trailing words still reject', () => {
    for (const text of ['status please', 'phantom status now', 'the status', 'status update']) {
      expect(isOwnerStatusRequest(text), text).toBe(false);
    }
  });
});

describe('ownerStatusReply wrapper contract behind the Slack statusReply seam', () => {
  it('accepts status asks through reply.ask and keeps the fixed fallback plus snapshot evidence', async () => {
    const reply = ownerStatusReply({ brief: async () => { throw new Error('synthetic status read failure'); } });
    // reply.ask is a superset of isOwnerStatusRequest (recheck, orders, review,
    // owners, bridge, peers). These status phrases stay true for both.
    for (const text of ['status', 'Status?', 'status??', '/status', 'glance', "what's up", "how's the fleet"]) {
      expect(isOwnerStatusRequest(text), text).toBe(true);
      expect(reply.ask(text), text).toBe(true);
    }
    for (const text of ['status please', 'phantom status now', 'the status', 'status update', 'status of PR 4245?']) {
      expect(reply.ask(text), text).toBe(false);
    }
    expect(reply.fallback).toBe(OWNER_STATUS_FALLBACK);
    // A failed digest read still starts with the fixed fallback. Slack compose
    // then appends snapshot evidence lines, including fleet state.
    const text = await reply.compose('/fake-runs-312s', NOW);
    expect(text.split('\n')[0]).toBe(OWNER_STATUS_FALLBACK);
    expect(text).toContain('\nFleet state: ');
  }, 15_000);

  it('bounds the composed answer at 1500 chars with the ET-clock heading', async () => {
    // Equivalent of the original <=8-line bound: the digest is five fixed
    // lines and composeOwnerStatusReply truncates at MAX_REPLY_CHARS.
    const huge = async () => `Morning leader brief\n${'q'.repeat(5000)}`;
    const text = await composeOwnerStatusReply('/fake-runs-312s', NOW, { brief: huge });
    expect(text).toHaveLength(1500);
    expect(text.endsWith('…')).toBe(true);
    expect(text.startsWith('Phantom status,')).toBe(true);
  });
});
