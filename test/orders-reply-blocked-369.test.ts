/** RQ-PHX-ORDERSREPLYBLOCKED369 — formatOrdersReply with lane evidence: the
 * thread answer can now say BLOCKED and name the held lane as the dependency,
 * and owner/PR are bound to the evidence's claimReceipt (the job that proves
 * the state), matching `ashlr fleet order-state` and the desktop orders API.
 * Hold reasons and changedBy never reach the reply; an unavailable lanes read
 * is named, and callers that pass no lanesState keep the pre-lanes reply
 * byte-identical. The caller half (defaultOrdersReply) is exercised with
 * injected readers only — the real trace, process table and slots.json never
 * load. All fixtures are plainly fake. */
import { describe, expect, it } from 'vitest';
import { formatOrdersReply } from '../src/core/fleet/orders-reply.js';
import { defaultOrdersReply } from '../src/core/agents/owner-status-reply.js';
import type { OrderTraceJob, OrderTraceV1 } from '../src/core/fleet/order-trace.js';
import type { LaneTargetsV1 } from '../src/core/fleet/runs-lane-targets.js';
import type { LiveWorkersSnapshot } from '../src/core/fleet/runs-live-workers.js';
import type { LiveJobIds } from '../src/core/fleet/order-work-state.js';

const NOW = '2026-11-14T19:30:00.000Z'; // 14:30 ET (EST, UTC-5)
const NOW_DATE = new Date(NOW);
const HEADING = 'Phantom orders, as of 14:30 ET (order-trace)';
const HELD_UNTIL = '2026-11-15T00:00:00.000Z';
const SENTINEL_REASON = 'HELDREASON-SENTINEL-369';
const SENTINEL_BY = 'CHANGEDBY-SENTINEL-369';

const job = (id: string, lane: string | null, state: OrderTraceJob['state'], url: string | null = null): OrderTraceJob =>
  ({ id, lane, state, url });

const laneRow = (lane: string, held: boolean): LaneTargetsV1['lanes'][number] => ({
  lane, target: held ? 0 : 6, floor: 0, ceiling: 8, held,
  heldReason: held ? SENTINEL_REASON : null,
  heldUntil: held ? HELD_UNTIL : null,
  pausedFrom: null, lastChange: null,
  changedBy: held ? SENTINEL_BY : null,
});

const LANES: LaneTargetsV1 = {
  v: 1, generatedAt: NOW, sourceState: 'healthy',
  lanes: [laneRow('codex-personal', true), laneRow('devin', false), laneRow('zai', false), laneRow('claude', false)],
};

const traceWith = (orders: OrderTraceV1['orders']): OrderTraceV1 => ({
  v: 1, generatedAt: NOW,
  sources: { inbox: 'healthy', prompts: 'healthy', publishes: 'healthy', queue: 'healthy' },
  orders,
});

const line = (text: string, orderAt: string): string =>
  text.split('\n').find(l => l.startsWith(orderAt))!;

describe('formatOrdersReply with lane evidence', () => {
  it('reports BLOCKED and the held-lane dependency when every job is queued on a held lane', () => {
    const trace = traceWith([
      { at: '2026-11-14 12:00 ET', source: 'slack', key: '11-14 12:00', jobs: [job('RQ-PHX-HELD369', 'codex-personal', 'queued')] },
    ]);
    const text = formatOrdersReply({ trace, nowIso: NOW, liveState: 'healthy', lanes: LANES, lanesState: 'healthy' });
    const orderLine = line(text, '2026-11-14 12:00 ET');
    expect(orderLine).toContain('· BLOCKED ·');
    expect(orderLine).toContain(`waiting on: lane codex-personal held until ${HELD_UNTIL}`);
    expect(orderLine).toContain('owner RQ-PHX-HELD369 (codex-personal)');
    // Hold reasons and changedBy never reach the reply.
    expect(text).not.toContain(SENTINEL_REASON);
    expect(text).not.toContain(SENTINEL_BY);
  });

  it('is not BLOCKED when one queued job sits on an unheld lane', () => {
    const trace = traceWith([
      {
        at: '2026-11-14 12:00 ET', source: 'slack', key: '11-14 12:00',
        jobs: [job('RQ-PHX-HELD369', 'codex-personal', 'queued'), job('RQ-PHX-FREE370', 'devin', 'queued')],
      },
    ]);
    const text = formatOrdersReply({ trace, nowIso: NOW, liveState: 'healthy', lanes: LANES, lanesState: 'healthy' });
    const orderLine = line(text, '2026-11-14 12:00 ET');
    expect(orderLine).not.toContain('BLOCKED');
    expect(orderLine).not.toContain('waiting on:');
    expect(orderLine).toContain('· RECEIVED ·');
  });

  it('names the live job as owner when only the second of two launched jobs is live', () => {
    const trace = traceWith([
      {
        at: '2026-11-14 12:00 ET', source: 'slack', key: '11-14 12:00',
        jobs: [job('RQ-PHX-FIRST01', 'zai', 'launched'), job('RQ-PHX-SECOND02', 'devin', 'launched')],
      },
    ]);
    const live: LiveJobIds = { jobIds: new Set(['RQ-PHX-SECOND02']), at: NOW };
    const text = formatOrdersReply({ trace, nowIso: NOW, live, liveState: 'healthy', lanes: LANES, lanesState: 'healthy' });
    const orderLine = line(text, '2026-11-14 12:00 ET');
    expect(orderLine).toContain('· RUNNING ·');
    expect(orderLine).toContain('owner RQ-PHX-SECOND02 (devin)');
    expect(orderLine).not.toContain('RQ-PHX-FIRST01');
  });

  it('reports VERIFIED with the merged job as owner and PR when a queued sibling exists', () => {
    const trace = traceWith([
      {
        at: '2026-11-14 12:00 ET', source: 'slack', key: '11-14 12:00',
        jobs: [
          job('RQ-PHX-MERGED369', 'devin', 'merged', 'https://github.com/ashlrai/phantom/pull/369'),
          job('RQ-PHX-QUEUED370', 'zai', 'queued'),
        ],
      },
    ]);
    const text = formatOrdersReply({ trace, nowIso: NOW, liveState: 'healthy', lanes: LANES, lanesState: 'healthy' });
    const orderLine = line(text, '2026-11-14 12:00 ET');
    expect(orderLine).toBe('2026-11-14 12:00 ET · slack · VERIFIED · owner RQ-PHX-MERGED369 (devin) · PR #369 · missing: none');
  });

  it('names the unavailable lanes read instead of silently dropping BLOCKED', () => {
    const trace = traceWith([
      { at: '2026-11-14 12:00 ET', source: 'slack', key: '11-14 12:00', jobs: [job('RQ-PHX-HELD369', 'codex-personal', 'queued')] },
    ]);
    const text = formatOrdersReply({ trace, nowIso: NOW, liveState: 'healthy', lanes: LANES, lanesState: 'unavailable' });
    expect(text).toContain('BLOCKED not checked (lane holds unavailable)');
    const orderLine = line(text, '2026-11-14 12:00 ET');
    expect(orderLine).not.toContain('BLOCKED');
    expect(orderLine).not.toContain('waiting on:');
  });

  it('keeps the reply byte-identical when lanesState is omitted', () => {
    const TRACE: OrderTraceV1 = traceWith([
      {
        at: '2026-11-14 12:00 ET', source: 'slack', key: '11-14 12:00',
        jobs: [job('RQ-PHX-FAKEJOB1', 'devin', 'merged', 'https://github.com/example/repo/pull/1')],
      },
      { at: '2026-11-14 11:00 ET', source: 'imessage', key: '11-14 11:00', jobs: [job('RQ-PHX-FAKEJOB2', 'claude', 'launched')] },
      { at: '2026-11-14 10:00 ET', source: 'desktop', key: '11-14 10:00', jobs: [job('RQ-PHX-FAKEJOB3', 'zai', 'queued')] },
    ]);
    const LIVE: LiveJobIds = { jobIds: new Set(['RQ-PHX-FAKEJOB2']), at: NOW };
    const legacy = [
      HEADING,
      '2026-11-14 12:00 ET · slack · VERIFIED · owner RQ-PHX-FAKEJOB1 (devin) · PR #1 · missing: none',
      '2026-11-14 11:00 ET · imessage · RUNNING · owner RQ-PHX-FAKEJOB2 (claude) · no PR · missing: none',
      '2026-11-14 10:00 ET · desktop · RECEIVED · owner RQ-PHX-FAKEJOB3 (zai) · no PR · missing: durable claim receipt',
    ].join('\n');
    expect(formatOrdersReply({ trace: TRACE, nowIso: NOW, live: LIVE, liveState: 'healthy' })).toBe(legacy);
    // A lanes value without lanesState is still an old-caller call: identical.
    expect(formatOrdersReply({ trace: TRACE, nowIso: NOW, live: LIVE, liveState: 'healthy', lanes: LANES })).toBe(legacy);
  });
});

describe('defaultOrdersReply lane-holds read', () => {
  const blockedTrace = traceWith([
    { at: '2026-11-14 12:00 ET', source: 'slack', key: '11-14 12:00', jobs: [job('RQ-PHX-HELD369', 'codex-personal', 'queued')] },
  ]);
  const liveHealthy = async (): Promise<LiveWorkersSnapshot> =>
    ({ v: 1, generatedAt: NOW, sourceState: 'healthy', workers: [], leaders: [], orchestratorAgents: 0 });

  it('produces a reply naming BLOCKED unchecked when the lanes reader throws', async () => {
    const text = await defaultOrdersReply(NOW_DATE, {
      read: async () => blockedTrace,
      live: liveHealthy,
      lanes: async () => { throw new Error('synthetic slots failure'); },
    });
    expect(text).toContain('BLOCKED not checked (lane holds unavailable)');
    const orderLine = line(text, '2026-11-14 12:00 ET');
    expect(orderLine).not.toContain('BLOCKED');
  });

  it('reports BLOCKED with the dependency through the real caller path', async () => {
    const text = await defaultOrdersReply(NOW_DATE, {
      read: async () => blockedTrace,
      live: liveHealthy,
      lanes: async () => LANES,
    });
    const orderLine = line(text, '2026-11-14 12:00 ET');
    expect(orderLine).toContain('· BLOCKED ·');
    expect(orderLine).toContain(`waiting on: lane codex-personal held until ${HELD_UNTIL}`);
    // The caller strips hold reasons and changedBy before they can surface.
    expect(text).not.toContain(SENTINEL_REASON);
    expect(text).not.toContain(SENTINEL_BY);
  });
});
