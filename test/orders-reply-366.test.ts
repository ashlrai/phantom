/** RQ-PHX-SLACKORDERSASK366 — formatOrdersReply: the per-order thread answer
 * behind a short "orders" ask. A fake trace holds a merged order (fake PR
 * url), a launched order with live proof and a queued order; the checks are
 * the line shapes, owner/PR text, the 1500-char cap, the inbox-degraded and
 * live-unavailable honesty lines, and that order text and home paths never
 * reach the reply. All fixtures are plainly fake. */
import { describe, expect, it } from 'vitest';
import { formatOrdersReply } from '../src/core/fleet/orders-reply.js';
import type { OrderTraceJob, OrderTraceV1 } from '../src/core/fleet/order-trace.js';
import type { LiveJobIds } from '../src/core/fleet/order-work-state.js';

const NOW = '2026-11-14T19:30:00.000Z'; // 14:30 ET (EST, UTC-5)
const HEADING = 'Phantom orders, as of 14:30 ET (order-trace)';

const job = (id: string, lane: string | null, state: OrderTraceJob['state'], url: string | null = null): OrderTraceJob =>
  ({ id, lane, state, url });

const TRACE: OrderTraceV1 = {
  v: 1,
  generatedAt: NOW,
  sources: { inbox: 'healthy', prompts: 'healthy', publishes: 'healthy' },
  orders: [
    {
      at: '2026-11-14 12:00 ET', source: 'slack', key: '11-14 12:00',
      jobs: [job('RQ-PHX-FAKEJOB1', 'devin', 'merged', 'https://github.com/example/repo/pull/1')],
    },
    {
      at: '2026-11-14 11:00 ET', source: 'imessage', key: '11-14 11:00',
      jobs: [job('RQ-PHX-FAKEJOB2', 'claude', 'launched')],
    },
    {
      at: '2026-11-14 10:00 ET', source: 'desktop', key: '11-14 10:00',
      jobs: [job('RQ-PHX-FAKEJOB3', 'zai', 'queued')],
    },
  ],
};

const LIVE: LiveJobIds = { jobIds: new Set(['RQ-PHX-FAKEJOB2']), at: NOW };

describe('formatOrdersReply', () => {
  it('prints one line per newest order with state, owner and PR', () => {
    const text = formatOrdersReply({ trace: TRACE, nowIso: NOW, live: LIVE, liveState: 'healthy' });
    expect(text.split('\n')).toEqual([
      HEADING,
      '2026-11-14 12:00 ET · slack · VERIFIED · owner RQ-PHX-FAKEJOB1 (devin) · PR #1 · missing: none',
      '2026-11-14 11:00 ET · imessage · RUNNING · owner RQ-PHX-FAKEJOB2 (claude) · no PR · missing: none',
      '2026-11-14 10:00 ET · desktop · RECEIVED · owner RQ-PHX-FAKEJOB3 (zai) · no PR · missing: durable claim receipt',
    ]);
  });

  it('sorts orders newest-first regardless of trace order', () => {
    const shuffled: OrderTraceV1 = { ...TRACE, orders: [TRACE.orders[2]!, TRACE.orders[0]!, TRACE.orders[1]!] };
    const lines = formatOrdersReply({ trace: shuffled, nowIso: NOW, live: LIVE, liveState: 'healthy' }).split('\n');
    expect(lines[1]).toContain('12:00');
    expect(lines[2]).toContain('11:00');
    expect(lines[3]).toContain('10:00');
  });

  it('proves RUNNING only with live evidence; without it the same order is ASSIGNED', () => {
    const text = formatOrdersReply({ trace: TRACE, nowIso: NOW, liveState: 'healthy' });
    expect(text).toContain('11:00 ET · imessage · ASSIGNED · owner RQ-PHX-FAKEJOB2 (claude)');
    expect(text).not.toContain('RUNNING');
  });

  it('names no owner when the most advanced job is not a plain RQ id, and unknown lane when the lane fails validation', () => {
    const trace: OrderTraceV1 = {
      ...TRACE,
      orders: [
        { at: '2026-11-14 13:00 ET', source: 'slack', key: '11-14 13:00', jobs: [job('not an rq id', 'devin', 'launched')] },
        { at: '2026-11-14 12:30 ET', source: 'slack', key: '11-14 12:30', jobs: [job('RQ-PHX-FAKEJOB4', 'Bad Lane', 'launched')] },
        { at: '2026-11-14 12:00 ET', source: 'slack', key: '11-14 12:00', jobs: [] },
      ],
    };
    const lines = formatOrdersReply({ trace, nowIso: NOW, liveState: 'healthy' }).split('\n');
    expect(lines[1]).toBe('2026-11-14 13:00 ET · slack · ASSIGNED · no owner · no PR · missing: none');
    expect(lines[2]).toContain('· ASSIGNED · owner RQ-PHX-FAKEJOB4 (unknown) · no PR · missing: none');
    expect(lines[3]).toBe('2026-11-14 12:00 ET · slack · RECEIVED · no owner · no PR · missing: named owner, durable claim receipt');
  });

  it('prints no PR for a merged job whose url is not a github pull url', () => {
    const trace: OrderTraceV1 = {
      ...TRACE,
      orders: [{ at: '2026-11-14 13:00 ET', source: 'slack', key: '11-14 13:00', jobs: [job('RQ-PHX-FAKEJOB5', 'devin', 'merged', 'https://example.test/artifacts/9')] }],
    };
    const line = formatOrdersReply({ trace, nowIso: NOW, liveState: 'healthy' }).split('\n')[1]!;
    expect(line).toContain('ASSIGNED');
    expect(line).toContain('no PR');
    expect(line).not.toContain('example.test');
  });

  it('says Orders: none only when a healthy inbox lists no orders', () => {
    const empty: OrderTraceV1 = { ...TRACE, orders: [] };
    const text = formatOrdersReply({ trace: empty, nowIso: NOW, liveState: 'healthy' });
    expect(text.split('\n')).toEqual([HEADING, 'Orders: none']);
  });

  it('says unknown on a degraded inbox and never claims none', () => {
    const degraded: OrderTraceV1 = { ...TRACE, sources: { inbox: 'degraded', prompts: 'healthy', publishes: 'healthy' }, orders: [] };
    const text = formatOrdersReply({ trace: degraded, nowIso: NOW, liveState: 'healthy' });
    expect(text).toContain('Orders: unknown (inbox degraded)');
    expect(text).not.toContain('Orders: none');
    const missing: OrderTraceV1 = { ...TRACE, sources: { inbox: 'missing', prompts: 'healthy', publishes: 'healthy' } };
    const text2 = formatOrdersReply({ trace: missing, nowIso: NOW, liveState: 'healthy' });
    expect(text2).toContain('Orders: unknown (inbox missing)');
    expect(text2).toContain('VERIFIED');
  });

  it('names the unavailable live read instead of dropping RUNNING silently', () => {
    const text = formatOrdersReply({ trace: TRACE, nowIso: NOW, liveState: 'unavailable' });
    expect(text).toContain('RUNNING not checked (live workers unavailable)');
    expect(text).toContain('11:00 ET · imessage · ASSIGNED · owner RQ-PHX-FAKEJOB2 (claude)');
  });

  it('caps the reply at 1500 chars, dropping the oldest order lines first', () => {
    const orders = Array.from({ length: 30 }, (_, i) => ({
      at: `2026-11-14 12:${String(59 - i).padStart(2, '0')} ET`,
      source: `fake-source-${'x'.repeat(180)}`,
      key: `11-14 12:${String(59 - i).padStart(2, '0')}`,
      jobs: [] as OrderTraceJob[],
    }));
    const text = formatOrdersReply({ trace: { ...TRACE, orders }, nowIso: NOW, liveState: 'healthy' });
    expect(text.length).toBeLessThanOrEqual(1500);
    const lines = text.split('\n');
    expect(lines[0]).toBe(HEADING);
    expect(lines.length).toBeGreaterThan(1);
    // The newest order survives; the oldest listed order lines were dropped first.
    expect(text).toContain('2026-11-14 12:59 ET');
    expect(lines.slice(1).every(l => l.startsWith('2026-11-14 12:'))).toBe(true);
    const shown = lines.slice(1).map(l => l.slice(11, 16));
    const sorted = [...shown].sort().reverse();
    expect(shown).toEqual(sorted);
  });

  it('keeps the newest 8 orders only', () => {
    const orders = Array.from({ length: 30 }, (_, i) => ({
      at: `2026-11-14 12:${String(i).padStart(2, '0')} ET`, source: 'slack', key: `11-14 12:${String(i).padStart(2, '0')}`,
      jobs: [] as OrderTraceJob[],
    }));
    const lines = formatOrdersReply({ trace: { ...TRACE, orders }, nowIso: NOW, liveState: 'healthy' }).split('\n');
    expect(lines).toHaveLength(9); // heading + 8 order lines
    expect(lines[1]).toContain('12:29');
    expect(lines[8]).toContain('12:22');
    expect(lines.some(l => l.includes('12:21'))).toBe(false);
  });

  it('never lets order text, home paths or banned verbs reach the reply', () => {
    const trace: OrderTraceV1 = {
      ...TRACE,
      orders: [{
        at: '2026-11-14 13:00 ET', source: 'slack dispatched from /Users/fakehome/x at 10.0.0.7', key: '11-14 13:00',
        jobs: [job('RQ-PHX-FAKEJOB6', 'devin', 'launched')],
      }],
    };
    const text = formatOrdersReply({ trace, nowIso: NOW, liveState: 'healthy' });
    expect(text).not.toContain('/Users/');
    expect(text).not.toContain('fakehome');
    expect(text).not.toContain('10.0.0.7');
    expect(text).not.toContain('dispatched');
    expect(text).toContain('[verb]');
    // The order's own line is still there, sanitized.
    expect(text).toContain('owner RQ-PHX-FAKEJOB6 (devin)');
  });
});
