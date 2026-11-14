/** RQ-PHX-SLACKREVIEWASK374 — the review branch on ownerStatusReply: an exact
 * "review" ask in the Slack leader thread is answered in-thread with the live
 * unowned review pick; a throwing review read gets the fixed review fallback;
 * "status" and "orders" are unchanged. The default path is exercised with
 * readReviewPick's seams mocked — the live readers never load, dirs are fake,
 * ids and shas are fake. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  composeOwnerReviewReply,
  isOwnerStatusRequest,
  OWNER_REVIEW_FALLBACK,
  ownerStatusReply,
} from '../src/core/agents/owner-status-reply.js';
import { formatReviewPickReply } from '../src/core/fleet/review-pick-reply.js';
import { readReviewPick, type ReviewPickReport } from '../src/core/fleet/review-pick.js';

vi.mock('../src/core/fleet/review-pick.js', () => ({ readReviewPick: vi.fn() }));
const readMock = vi.mocked(readReviewPick);

const RUNS_DIR = '/nonexistent/fake-runs-374';
const NOW = new Date('2026-11-14T19:30:00.000Z');
const AS_OF = '2026-11-14T19:30:00.000Z';
const DIGEST = 'Morning leader brief\nShipped (last 12h): none';
const ORDERS_TEXT = 'Phantom orders, as of 14:30 ET (order-trace)\nOrders: none';
const RECHECK_TEXT = 'Phantom recheck UNKNOWN · as of 2026-11-14T19:30:00.000Z';
const REVIEW_TEXT = 'Phantom review pick (as of now): fake reply';
const noBoard = () => { throw new Error('no board'); };

const CLAIMS_READ = {
  'claimed-tsv': 'read', 'bus-work-claims': 'read', 'coordination': 'read', 'live-workers': 'read',
} as const;

const report = (over: Partial<ReviewPickReport> = {}): ReviewPickReport => ({
  schema: 'fleet.review-pick.v1',
  as_of: AS_OF,
  repo: 'ashlrai/phantom',
  source: { prs: 'read', claims: { ...CLAIMS_READ }, unavailable: [] },
  picked: {
    repo: 'ashlrai/phantom', pr: 900374,
    head: 'codex-bridge/RQ-FAKE-374',
    head_sha: 'abc1234def5678901234567890123456789012',
    title: 'bridge: RQ-FAKE-374',
    owner: 'none',
    reason: 'no live claim or running worker names it; merge state CLEAN; oldest update among 3 unowned candidates',
  },
  reason: 'no live claim or running worker names it; merge state CLEAN; oldest update among 3 unowned candidates',
  skipped: [],
  unowned_candidates: 3,
  ...over,
});

beforeEach(() => { readMock.mockReset(); });

describe('ownerStatusReply review gating', () => {
  it('accepts the exact review asks and nothing else', () => {
    const reply = ownerStatusReply();
    for (const ask of ['review', 'review pick', 'unowned review', 'Review?', 'UNOWNED REVIEW!']) {
      expect(reply.ask(ask)).toBe(true);
    }
    expect(reply.ask('status')).toBe(true);
    expect(reply.ask('orders')).toBe(true);
    expect(reply.ask('recheck')).toBe(true);
    expect(reply.ask('review PR #12 please')).toBe(false);
    expect(reply.ask('review please')).toBe(false);
  });

  it('keeps isOwnerStatusRequest status-only', () => {
    expect(isOwnerStatusRequest('review')).toBe(false);
    expect(isOwnerStatusRequest('unowned review')).toBe(false);
    expect(isOwnerStatusRequest('status')).toBe(true);
  });
});

describe('composeOwnerReviewReply', () => {
  it('returns the injected review answer', async () => {
    const review = vi.fn(async () => REVIEW_TEXT);
    expect(await composeOwnerReviewReply(NOW, { review })).toBe(REVIEW_TEXT);
    expect(review).toHaveBeenCalledWith(NOW);
  });

  it('returns the fixed fallback when the review read throws', async () => {
    const reply = await composeOwnerReviewReply(NOW, { review: async () => { throw new Error('synthetic review failure'); } });
    expect(reply).toBe(OWNER_REVIEW_FALLBACK);
    expect(OWNER_REVIEW_FALLBACK).toBe("Phantom review pick: the read failed; your message is in the Leader's inbox.");
  });
});

describe('ownerStatusReply review routing', () => {
  it('routes a review ask to the review seam, leaving brief, recheck and orders uncalled', async () => {
    const review = vi.fn(async () => REVIEW_TEXT);
    const orders = vi.fn(async () => ORDERS_TEXT);
    const recheck = vi.fn(async () => RECHECK_TEXT);
    const brief = vi.fn(async () => DIGEST);
    const reply = ownerStatusReply({ review, orders, recheck, brief, board: noBoard });
    expect(await reply.compose(RUNS_DIR, NOW, 'review')).toBe(REVIEW_TEXT);
    expect(review).toHaveBeenCalledWith(NOW);
    expect(orders).not.toHaveBeenCalled();
    expect(recheck).not.toHaveBeenCalled();
    expect(brief).not.toHaveBeenCalled();
    expect(await reply.compose(RUNS_DIR, NOW, 'unowned review')).toBe(REVIEW_TEXT);
    expect(await reply.compose(RUNS_DIR, NOW, 'review pick')).toBe(REVIEW_TEXT);
  });

  it('answers a throwing review seam with the review fallback, never the digest', async () => {
    const brief = vi.fn(async () => DIGEST);
    const reply = ownerStatusReply({ review: async () => { throw new Error('synthetic review failure'); }, brief, board: noBoard });
    expect(await reply.compose(RUNS_DIR, NOW, 'review')).toBe(OWNER_REVIEW_FALLBACK);
    expect(brief).not.toHaveBeenCalled();
  });

  it('keeps status and orders on their own answers', async () => {
    const review = vi.fn(async () => REVIEW_TEXT);
    const orders = vi.fn(async () => ORDERS_TEXT);
    const brief = vi.fn(async () => DIGEST);
    const reply = ownerStatusReply({ review, orders, brief, board: noBoard });
    expect(await reply.compose(RUNS_DIR, NOW, 'orders')).toBe(ORDERS_TEXT);
    expect(orders).toHaveBeenCalledWith(NOW);
    expect(review).not.toHaveBeenCalled();
    const status = await reply.compose(RUNS_DIR, NOW, 'status');
    expect(status).toMatch(/^Phantom status, \d\d:\d\d ET\nShipped \(last 12h\): none/);
    expect(brief).toHaveBeenCalledOnce();
    expect(review).not.toHaveBeenCalled();
    // No text (older callers) keeps the digest path.
    expect(await reply.compose(RUNS_DIR, NOW)).toMatch(/^Phantom status/);
    expect(review).not.toHaveBeenCalled();
  });
});

describe('default review answer (readReviewPick mocked)', () => {
  it('names repo#pr, head sha7, owner none and "not a claim" for a pick', async () => {
    readMock.mockResolvedValue(report());
    const reply = ownerStatusReply();
    const text = await reply.compose(RUNS_DIR, NOW, 'review');
    expect(readMock).toHaveBeenCalledWith({ repo: 'ashlrai/phantom' });
    expect(text).toBe(
      `Phantom review pick (as of ${AS_OF}): ashlrai/phantom#900374 head abc1234 "bridge: RQ-FAKE-374"`
      + ' — owner: none (no live claim or running worker names it). Evidence only; this is not a claim.',
    );
    expect(text).toContain('ashlrai/phantom#900374');
    expect(text).toContain('abc1234');
    expect(text).toContain('owner: none');
    expect(text).toContain('not a claim');
  });

  it('answers none with the reason and names each unreadable ownership source', async () => {
    readMock.mockResolvedValue(report({
      picked: null,
      reason: 'ownership source unavailable',
      source: {
        prs: 'read',
        claims: { ...CLAIMS_READ, 'bus-work-claims': 'unavailable', 'live-workers': 'unavailable' },
        unavailable: ['bus-work-claims', 'live-workers'],
      },
      unowned_candidates: 1,
    }));
    const reply = ownerStatusReply();
    const text = await reply.compose(RUNS_DIR, NOW, 'unowned review');
    expect(text).toBe(
      `Phantom review pick (as of ${AS_OF}): none — ownership source unavailable.`
      + ' Unreadable sources: bus-work-claims, live-workers.',
    );
    expect(text).toContain('none — ownership source unavailable');
    expect(text).not.toContain('owner: none');
  });

  it('names an unreadable PR list when the pr source is unavailable', async () => {
    readMock.mockResolvedValue(report({
      picked: null,
      reason: 'pr source unavailable',
      source: { prs: 'unavailable', claims: { ...CLAIMS_READ }, unavailable: [] },
      unowned_candidates: 0,
    }));
    const reply = ownerStatusReply();
    const text = await reply.compose(RUNS_DIR, NOW, 'review');
    expect(text).toBe(`Phantom review pick (as of ${AS_OF}): none — pr source unavailable. PR list unreadable.`);
  });

  it('answers the fixed fallback when the default read throws', async () => {
    readMock.mockRejectedValue(new Error('synthetic read failure'));
    const reply = ownerStatusReply();
    expect(await reply.compose(RUNS_DIR, NOW, 'review')).toBe(OWNER_REVIEW_FALLBACK);
  });
});

describe('formatReviewPickReply', () => {
  it('caps the reply at 600 characters and the title at 100', () => {
    const text = formatReviewPickReply(report({
      picked: {
        repo: 'ashlrai/phantom', pr: 900374, head: 'h',
        head_sha: 'f'.repeat(40), title: 't'.repeat(500), owner: 'none', reason: 'r',
      },
    }));
    expect(text.length).toBeLessThanOrEqual(600);
    expect(text).toContain(`"${'t'.repeat(100)}"`);
  });

  it('strips control characters and never carries a home path', () => {
    const text = formatReviewPickReply(report({
      picked: {
        repo: 'ashlrai/phantom', pr: 900374, head: 'h',
        head_sha: 'a'.repeat(40),
        title: 'bridge: RQ-FAKE-374 see /Users/masonwyatt/secret\tstuff',
        owner: 'none', reason: 'r',
      },
    }));
    expect([...text].every(c => c.charCodeAt(0) >= 0x20)).toBe(true);
    expect(text).not.toContain('/Users/');
    expect(text).not.toContain('masonwyatt');
  });
});
