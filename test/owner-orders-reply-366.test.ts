/** RQ-PHX-SLACKORDERSASK366 — the orders branch on ownerStatusReply: an exact
 * "orders" ask in the Slack leader thread is answered in-thread with the
 * per-order reply; a throwing orders seam gets the fixed orders fallback;
 * "status" and "recheck" are unchanged. Every seam is injected — the live
 * readers never load, dirs are fake, ids are fake. */
import { describe, expect, it, vi } from 'vitest';
import {
  composeOwnerOrdersReply,
  isOwnerStatusRequest,
  OWNER_ORDERS_FALLBACK,
  ownerStatusReply,
} from '../src/core/agents/owner-status-reply.js';

const RUNS_DIR = '/nonexistent/fake-runs-366';
const NOW = new Date('2026-11-14T19:30:00.000Z');
const ORDERS_TEXT = 'Phantom orders, as of 14:30 ET (order-trace)\n2026-11-14 12:00 ET · slack · VERIFIED · owner RQ-PHX-FAKEJOB1 (devin) · PR #1 · missing: none';
const RECHECK_TEXT = 'Phantom recheck UNKNOWN · as of 2026-11-14T19:30:00.000Z';
const DIGEST = 'Morning leader brief\nShipped (last 12h): none';
const noBoard = () => { throw new Error('no board'); };

describe('ownerStatusReply orders gating', () => {
  it('accepts the exact orders asks and nothing else', () => {
    const reply = ownerStatusReply();
    for (const ask of ['orders', '/orders', 'my orders', 'phantom orders', 'fleet orders', 'order state', 'Orders?']) {
      expect(reply.ask(ask)).toBe(true);
    }
    expect(reply.ask('status')).toBe(true);
    expect(reply.ask('recheck')).toBe(true);
    expect(reply.ask('orders for PR #5315 please')).toBe(false);
    expect(reply.ask('orders please')).toBe(false);
  });

  it('keeps isOwnerStatusRequest status-only', () => {
    expect(isOwnerStatusRequest('orders')).toBe(false);
    expect(isOwnerStatusRequest('status')).toBe(true);
  });
});

describe('composeOwnerOrdersReply', () => {
  it('returns the injected orders answer', async () => {
    const orders = vi.fn(async () => ORDERS_TEXT);
    expect(await composeOwnerOrdersReply(NOW, { orders })).toBe(ORDERS_TEXT);
    expect(orders).toHaveBeenCalledWith(NOW);
  });

  it('returns the fixed fallback when the orders read throws', async () => {
    const reply = await composeOwnerOrdersReply(NOW, { orders: async () => { throw new Error('synthetic orders failure'); } });
    expect(reply).toBe(OWNER_ORDERS_FALLBACK);
    expect(OWNER_ORDERS_FALLBACK).toBe("Phantom orders: the orders read failed; your message is in the Leader's inbox.");
  });
});

describe('ownerStatusReply orders routing', () => {
  it('routes an orders ask to the orders seam, leaving brief and recheck uncalled', async () => {
    const orders = vi.fn(async () => ORDERS_TEXT);
    const recheck = vi.fn(async () => RECHECK_TEXT);
    const brief = vi.fn(async () => DIGEST);
    const reply = ownerStatusReply({ orders, recheck, brief, board: noBoard });
    expect(await reply.compose(RUNS_DIR, NOW, 'orders')).toBe(ORDERS_TEXT);
    expect(orders).toHaveBeenCalledWith(NOW);
    expect(recheck).not.toHaveBeenCalled();
    expect(brief).not.toHaveBeenCalled();
    expect(await reply.compose(RUNS_DIR, NOW, 'order state')).toBe(ORDERS_TEXT);
  });

  it('answers a throwing orders seam with the orders fallback, never the digest', async () => {
    const brief = vi.fn(async () => DIGEST);
    const reply = ownerStatusReply({ orders: async () => { throw new Error('synthetic orders failure'); }, brief, board: noBoard });
    expect(await reply.compose(RUNS_DIR, NOW, 'fleet orders')).toBe(OWNER_ORDERS_FALLBACK);
    expect(brief).not.toHaveBeenCalled();
  });

  it('keeps status and recheck on their own answers', async () => {
    const orders = vi.fn(async () => ORDERS_TEXT);
    const recheck = vi.fn(async () => RECHECK_TEXT);
    const brief = vi.fn(async () => DIGEST);
    const reply = ownerStatusReply({ orders, recheck, brief, board: noBoard });
    expect(await reply.compose(RUNS_DIR, NOW, 'recheck')).toBe(RECHECK_TEXT);
    expect(recheck).toHaveBeenCalledWith(NOW);
    expect(orders).not.toHaveBeenCalled();
    const status = await reply.compose(RUNS_DIR, NOW, 'status');
    expect(status).toMatch(/^Phantom status, \d\d:\d\d ET\nShipped \(last 12h\): none/);
    expect(brief).toHaveBeenCalledOnce();
    expect(orders).not.toHaveBeenCalled();
    // No text (older callers) keeps the digest path.
    expect(await reply.compose(RUNS_DIR, NOW)).toMatch(/^Phantom status/);
  });
});
