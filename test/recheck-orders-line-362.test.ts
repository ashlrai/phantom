/** RQ-PHX-RECHECKORDERSLINE362 — the "Orders 24h:" evidence line on the fleet
 * recheck verdict and reply: summarizeOrders over the order trace,
 * formatOrdersLine, and the evidence-only reader wiring. Every reader is
 * faked; no real home, ledger, bus or network. Fixtures are plainly fake. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatOrdersLine, summarizeOrders } from '../src/core/fleet/recheck-orders-line.js';
import { readFleetRecheck, type FleetRecheck, type FleetRecheckDeps } from '../src/core/fleet/fleet-recheck.js';
import { formatRecheckReply } from '../src/core/fleet/fleet-recheck-reply.js';
import { sanitizeIdentityText, type RuntimeIdentity } from '../src/core/fleet/runtime-identity.js';
import type { OrderTraceV1 } from '../src/core/fleet/order-trace.js';

const NOW = new Date('2026-11-14T18:05:00.000Z');
const ISO = NOW.toISOString();
const scrub = (s: string): string =>
  sanitizeIdentityText(s.replace(/\/(?:Users|home)\/[^/\s;,)]+/g, '~'), '');

/** nowIso is 18:05Z = 13:05 ET; the 24h window opens at 13:05 ET Nov 13. */
const TRACE: OrderTraceV1 = {
  v: 1,
  generatedAt: ISO,
  sources: { inbox: 'healthy', prompts: 'healthy', publishes: 'healthy' },
  orders: [
    {
      at: '2026-11-14 10:00 ET', source: 'slack', key: '11-14 10:00',
      jobs: [{ id: 'RQ-FAKE-MERGED', lane: 'devin', state: 'merged', url: 'https://github.com/ashlrai/phantom/pull/4666' }],
    },
    {
      at: '2026-11-14 08:00 ET', source: 'imessage', key: '11-14 08:00',
      jobs: [{ id: 'RQ-FAKE-LAUNCHED', lane: 'codex-local', state: 'launched', url: null }],
    },
    { at: '2026-11-13 15:00 ET', source: 'desktop', key: '11-13 15:00', jobs: [] },
    { at: '2026-11-13 06:00 ET', source: 'slack', key: '11-13 06:00', jobs: [] },
  ],
};

afterEach(() => vi.useRealTimers());

const runtime: RuntimeIdentity = {
  host: 'fake-host', platform: 'fakeos', asOf: ISO,
  installedVersion: '1.2.3', sourceVersion: '1.2.3', versionDrift: false,
  fleetState: { path: '~/.ashlr-runs/guardian/state.json', mtime: ISO, ageSeconds: 60, stale: false },
  tailnetName: 'fake-tailnet-node', reasons: [],
};

function deps(over: Partial<FleetRecheckDeps> = {}): FleetRecheckDeps {
  return {
    now: () => NOW,
    homeDir: () => '/home/fakeuser',
    readRuntimeIdentity: () => runtime,
    readFleetBoard: () => ({ schema: 'fleet.coordination.v1', state: 'known', claims: [], messages: [], proposals: [], expiredClaims: 0 }),
    readChannelHealth: () => ({ schemaVersion: 1, asOf: ISO, channels: [] }),
    listWorkBoard: () => ({ items: [], inbox: 'ok', truncated: false }) as never,
    listCoordination: () => ({ source: 'unavailable', claims: [] }) as never,
    listLiveWorkers: () => ({ workers: [], state: 'unknown' }) as never,
    readTailnetPeers: () => ({ asOf: ISO, self: 'fake-self', peers: [], reasons: [] }),
    readPool: () => ({ asOf: ISO, self: 'fake-self', role: 'primary', hosts: [], reasons: [] }),
    readOrders: () => TRACE,
    ...over,
  };
}

/** A verdict assembled by hand — never passed through readFleetRecheck's own
 * sanitize pass — so the formatter's redaction is what is under test. */
function handBuilt(over: Partial<FleetRecheck> = {}): FleetRecheck {
  return {
    schema: 'fleet.recheck.v1', asOf: ISO,
    tailnet: { source: 'tailscale-status', asOf: ISO, self: 'fake-self', online: 1, offline: 0, unknown: 0, peers: [{ name: 'fake-peer', online: true, ageSeconds: 3 }], reasons: [] },
    pool: { asOf: ISO, self: 'fake-self', role: 'primary', hosts: [], reasons: [] },
    sections: {
      runtime: {
        state: 'VERIFIED', source: 'runtime-identity', asOf: ISO,
        host: 'fake-host', platform: 'fakeos', tailnetName: 'fake-tailnet-node',
        installedVersion: '1.2.3', sourceVersion: '1.2.3', versionDrift: false,
        fleetState: { path: '~', mtime: ISO, ageSeconds: 60, stale: false }, reasons: [], missing: [],
      },
      claims: { state: 'VERIFIED', source: 'coordination', asOf: ISO, active: 0, expiredClaims: 0, top: [], claims: [], missing: [] },
      bridge: {
        state: 'VERIFIED', source: 'channel-health', asOf: ISO,
        channels: [
          { channel: 'slack', state: 'LIVE', runtimeHost: 'fake-host', processAlive: true, missingBridge: null },
          { channel: 'imessage', state: 'LIVE', runtimeHost: 'fake-host', processAlive: true, missingBridge: null },
        ],
        missingBridge: null, missing: [],
      },
      task: {
        state: 'VERIFIED', source: 'work-board', asOf: ISO,
        task: { id: 'fake-request-1', state: 'RUNNING', owner: 'fake-owner-agent', claimReceipt: 'bus-claim:fake-request-1:1:1700000000000', asOf: ISO, source: 'fake-source' },
        unowned: 0, unclaimed: 0, lastVerified: null, liveWorker: null, missing: [],
      },
    },
    overall: { state: 'VERIFIED', missing: [] },
    ...over,
  };
}

describe('summarizeOrders', () => {
  it('counts last-24h orders by state and excludes older ones', () => {
    const summary = summarizeOrders(TRACE, ISO);
    expect(summary.asOf).toBe(ISO);
    expect(summary.windowHours).toBe(24);
    expect(summary.total).toBe(3);
    expect(summary.counts).toEqual({ VERIFIED: 1, ASSIGNED: 1, RECEIVED: 1 });
    expect(summary.reasons).toEqual([]);
  });

  it('reports one reason per unhealthy trace source', () => {
    const summary = summarizeOrders({
      ...TRACE,
      sources: { inbox: 'healthy', prompts: 'degraded', publishes: 'missing' },
    }, ISO);
    expect(summary.reasons).toEqual(['orders: prompts degraded', 'orders: publishes missing']);
    expect(summary.total).toBe(3);
  });
});

describe('formatOrdersLine', () => {
  it('names nonzero states in fixed order and omits zero states', () => {
    const line = formatOrdersLine(
      { asOf: ISO, windowHours: 24, counts: { VERIFIED: 2, RUNNING: 1, ASSIGNED: 3, RECEIVED: 4 }, total: 10, reasons: [] },
      scrub,
    );
    expect(line).toBe(`Orders 24h: 2 VERIFIED, 1 RUNNING, 3 ASSIGNED, 4 RECEIVED · as of ${ISO} (order-trace)`);
  });

  it('says none when a readable trace counted no orders', () => {
    expect(formatOrdersLine({ asOf: ISO, windowHours: 24, counts: {}, total: 0, reasons: [] }, scrub))
      .toBe('Orders 24h: none');
  });

  it('says unknown on the reader-failed reason', () => {
    expect(formatOrdersLine({ asOf: ISO, windowHours: 24, counts: {}, total: 0, reasons: ['orders: reader failed'] }, scrub))
      .toBe('Orders 24h: unknown (reader failed)');
  });

  it('omits the line when nothing was counted and the order source is unreadable', () => {
    expect(formatOrdersLine({
      asOf: ISO, windowHours: 24, counts: {}, total: 0,
      reasons: ['orders: inbox missing', 'orders: prompts missing', 'orders: publishes missing'],
    }, scrub)).toBeNull();
    expect(formatOrdersLine(null, scrub)).toBeNull();
    expect(formatOrdersLine(undefined, scrub)).toBeNull();
  });
});

describe('fleet recheck orders evidence', () => {
  it('carries the summary and the reply puts Orders right after Task', async () => {
    const v = await readFleetRecheck(deps());
    expect(v.orders?.total).toBe(3);
    expect(v.orders?.counts).toEqual({ VERIFIED: 1, ASSIGNED: 1, RECEIVED: 1 });
    const lines = formatRecheckReply(v).split('\n');
    const i = lines.findIndex(l => l.startsWith('Task:'));
    expect(i).toBeGreaterThan(-1);
    expect(lines[i + 1]).toBe(`Orders 24h: 1 VERIFIED, 1 ASSIGNED, 1 RECEIVED · as of ${ISO} (order-trace)`);
  });

  it('a throwing reader says reader failed and changes nothing else', async () => {
    const healthy = await readFleetRecheck(deps());
    const v = await readFleetRecheck(deps({ readOrders: () => { throw new Error('boom'); } }));
    expect(v.orders).toEqual({ asOf: ISO, windowHours: 24, counts: {}, total: 0, reasons: ['orders: reader failed'] });
    expect(v.overall.state).toBe(healthy.overall.state);
    expect(v.overall).toEqual(healthy.overall);
    expect(v.sections).toEqual(healthy.sections);
    expect(formatRecheckReply(v)).toContain('Orders 24h: unknown (reader failed)');
  });

  it('a stalled reader times out within SECTION_TIMEOUT_MS plus slack', async () => {
    vi.useFakeTimers();
    const p = readFleetRecheck(deps({ readOrders: () => new Promise<OrderTraceV1>(() => {}) }));
    await vi.advanceTimersByTimeAsync(5_001);
    const v = await p;
    expect(v.orders?.reasons).toEqual(['orders: reader failed']);
  });

  it('drops the Orders line before every other optional line when over budget', () => {
    const v = handBuilt({
      orders: { asOf: ISO, windowHours: 24, counts: { VERIFIED: 1 }, total: 1, reasons: [] },
      overall: { state: 'BLOCKED', missing: [] },
    });
    let tipped = false;
    for (let m = 100; m < 900 && !tipped; m++) {
      v.overall.missing = ['y'.repeat(m)];
      const text = formatRecheckReply(v);
      if (!text.includes('Orders 24h:')) {
        tipped = true;
        expect(text).toContain('Computers:');
        expect(text).toContain('Pool:');
        expect(text).toContain('Task:');
        expect(text.split('\n').at(-1)).toBe(`BLOCKED on: ${'y'.repeat(m)}`);
        expect(text.length).toBeLessThanOrEqual(900);
      }
    }
    expect(tipped).toBe(true);
  });

  it('never lets a home path inside a source string reach the reply', () => {
    const v = handBuilt({
      orders: {
        asOf: 'captured /Users/someone/x', windowHours: 24,
        counts: { VERIFIED: 1 }, total: 1,
        reasons: ['orders: prompts degraded at /Users/someone/x'],
      },
    });
    const reply = formatRecheckReply(v);
    expect(reply).toContain('Orders 24h:');
    expect(reply).not.toContain('/Users/');
    expect(reply).not.toContain('someone');
  });
});
