/**
 * RQ-PHX-ORDERMCPHELDPARITY369S — fleet_order_state held-lane parity: the MCP
 * projection now performs the same fresh readLaneTargets (queue/slots.json)
 * read the CLI and the desktop API already do, so a queued order whose every
 * job sits on a held lane reports BLOCKED with the sanitized lane dependency,
 * slots.json evidence and the lane snapshot's timestamp. Hermetic: the trace
 * rows are typed fixtures (the fixture boundary — readOrderTrace itself is
 * not exercised), the live snapshot is injected, and slots.json lives under a
 * temp runs root. Never reads the real ~/.ashlr-runs, process table or home.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFleetOrderState } from '../src/mcp/fleet-order-state.js';
import type { OrderTraceJob, OrderTraceV1 } from '../src/core/fleet/order-trace.js';
import type { LiveWorkersSnapshot } from '../src/core/fleet/runs-live-workers.js';
import { readLaneTargets } from '../src/core/fleet/runs-lane-targets.js';

const NOW = new Date('2026-11-14T10:00:00.000Z');
const LANES_AT = '2026-11-14T09:59:30.000Z';
const HELD_UNTIL = '2026-11-15T00:00:00.000Z';
const PR = 'https://github.com/ashlrai/phantom/pull/77';
const SENTINEL = 'SENTINEL-private-hold-metadata';

const job = (id: string, state: OrderTraceJob['state'], lane: string | null, url: string | null = null): OrderTraceJob =>
  ({ id, lane, state, url });

const trace = (orders: OrderTraceV1['orders']): OrderTraceV1 => ({
  v: 1,
  generatedAt: NOW.toISOString(),
  sources: { inbox: 'healthy', prompts: 'healthy', publishes: 'healthy' },
  orders,
});

const order = (key: string, jobs: OrderTraceJob[]): OrderTraceV1['orders'][number] =>
  ({ at: '2026-11-13 22:29 ET', source: 'mason', key, jobs });

const liveSnap = (jobIds: string[] = []): LiveWorkersSnapshot => ({
  v: 1, generatedAt: '2026-11-14T09:59:45.000Z', sourceState: 'healthy',
  workers: jobIds.map((j, i) => ({ pid: 7000 + i, job: j, repo: 'phantom', lane: 'devin', tier: 'work', ageSeconds: 60 })),
  leaders: [], orchestratorAgents: 0,
});

interface Body {
  v: number; asOf: string; lanes?: string; live?: string;
  orders: Array<Record<string, unknown>>; status?: string; reason?: string;
}
const call = (deps: Parameters<typeof readFleetOrderState>[0] = {}): Promise<Body> =>
  readFleetOrderState({ now: () => NOW.getTime(), live: async () => liveSnap(), ...deps }) as Promise<Body>;

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

/** A fresh fake runs root; slots.json is rewritten between calls to prove
 * the lane evidence is re-read every invocation, never cached. */
function runsRoot(slots: unknown): { runsDir: string; writeSlots: (next: unknown) => void } {
  const runsDir = mkdtempSync(join(tmpdir(), 'mcp-held-parity-'));
  roots.push(runsDir);
  mkdirSync(join(runsDir, 'queue'));
  const writeSlots = (next: unknown) =>
    writeFileSync(join(runsDir, 'queue', 'slots.json'), `${JSON.stringify(next, null, 1)}\n`, 'utf8');
  writeSlots(slots);
  return { runsDir, writeSlots };
}

const lane = (over: Record<string, unknown> = {}) => ({
  target: 2, floor: 0, ceiling: 4, held: true,
  held_reason: SENTINEL, held_until: HELD_UNTIL, held_by: `agent ${SENTINEL}`,
  last_change: Math.floor(Date.parse(LANES_AT) / 1000), changed_by: `agent ${SENTINEL} ${LANES_AT}`,
  ...over,
});
const slots = (lanes: Record<string, unknown>) => lanes;
const lanesRead = (runsDir: string) => vi.fn(() => readLaneTargets({ runsDir, now: () => new Date(LANES_AT) }));

describe('readFleetOrderState — held lanes', () => {
  it('a queued order with every job on a held lane reports BLOCKED with slots.json evidence and a sanitized dependency', async () => {
    const { runsDir } = runsRoot(slots({ claude: lane(), zai: lane() }));
    const t = trace([order('11-13 22:29', [job('RQ-PHX-HELD1', 'queued', 'claude'), job('RQ-PHX-HELD2', 'queued', 'zai')])]);
    const lanes = lanesRead(runsDir);
    const body = await call({ read: async () => t, lanes });
    expect(body.lanes).toBe('healthy');
    expect(lanes).toHaveBeenCalledTimes(1);
    const o = body.orders[0]!;
    expect(o.state).toBe('BLOCKED');
    expect(o.evidenceSource).toBe('slots.json');
    expect(o.asOf).toBe(LANES_AT);
    expect(o.blocker).toBe(`lane claude held until ${HELD_UNTIL}, lane zai held until ${HELD_UNTIL}`);
    expect(o.owner).toEqual({ job: 'RQ-PHX-HELD1', lane: 'claude' });
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain(SENTINEL);
    expect(serialized).not.toContain('held_reason');
    expect(serialized).not.toContain('held_by');
    expect(serialized).not.toContain('changed_by');
    expect(serialized).not.toContain(runsDir);
  });

  it('re-reads slots.json on every call: lifting the hold clears BLOCKED on the same deps', async () => {
    const { runsDir, writeSlots } = runsRoot(slots({ claude: lane() }));
    const t = trace([order('held', [job('RQ-PHX-HELD3', 'queued', 'claude')])]);
    const lanes = lanesRead(runsDir);
    const first = await call({ read: async () => t, lanes });
    expect(first.orders[0]).toMatchObject({ state: 'BLOCKED', blocker: `lane claude held until ${HELD_UNTIL}` });
    writeSlots(slots({ claude: lane({ held: false, held_reason: null, held_until: null, held_by: null, changed_by: null }) }));
    const second = await call({ read: async () => t, lanes });
    expect(lanes).toHaveBeenCalledTimes(2);
    expect(second.lanes).toBe('healthy');
    expect(second.orders[0]!.state).not.toBe('BLOCKED');
    expect(second.orders[0]!.blocker).toBeNull();
  });

  it('mixed siblings keep their own states: runnable queued unblocked, live launched RUNNING, merged VERIFIED with owner and pr', async () => {
    const { runsDir } = runsRoot(slots({ claude: lane(), devin: lane({ held: false, held_reason: null, held_until: null, held_by: null, changed_by: null }) }));
    const t = trace([
      order('mixed', [job('RQ-PHX-MIX1', 'queued', 'claude'), job('RQ-PHX-MIX2', 'queued', 'devin')]),
      order('live', [job('RQ-PHX-LIVE1', 'queued', 'claude'), job('RQ-PHX-LIVE2', 'launched', 'devin')]),
      order('done', [job('RQ-PHX-DONE1', 'merged', 'devin', PR)]),
      order('unknown-lane', [job('RQ-PHX-UNKN1', 'queued', 'not-a-real-lane')]),
      order('no-jobs', []),
    ]);
    const body = await call({
      read: async () => t,
      lanes: lanesRead(runsDir),
      live: async () => liveSnap(['RQ-PHX-LIVE2']),
    });
    expect(body.lanes).toBe('healthy');
    const byKey = Object.fromEntries(body.orders.map((o) => [o.key, o]));
    expect(byKey['mixed']!.state).not.toBe('BLOCKED');
    expect(byKey['mixed']!.blocker).toBeNull();
    expect(byKey['live']!.state).toBe('RUNNING');
    expect(byKey['live']!.evidenceSource).toBe('live-worker RQ-PHX-LIVE2');
    expect(byKey['done']!.state).toBe('VERIFIED');
    expect(byKey['done']!.pr).toBe(PR);
    expect(byKey['done']!.owner).toEqual({ job: 'RQ-PHX-DONE1', lane: 'devin' });
    expect(byKey['unknown-lane']!.state).not.toBe('BLOCKED');
    expect(byKey['no-jobs']!.state).not.toBe('BLOCKED');
    expect(JSON.stringify(body)).not.toContain(SENTINEL);
  });

  it('a throwing lane reader degrades to unavailable, leaks nothing, then recovers on the next call', async () => {
    const { runsDir } = runsRoot(slots({ claude: lane() }));
    const t = trace([order('held', [job('RQ-PHX-HELD4', 'queued', 'claude')])]);
    let fail = true;
    const lanes = vi.fn(async () => {
      if (fail) throw new Error(`boom ${SENTINEL} ${runsDir}/queue/slots.json`);
      return readLaneTargets({ runsDir, now: () => new Date(LANES_AT) });
    });
    const bad = await call({ read: async () => t, lanes });
    expect(bad.lanes).toBe('unavailable');
    expect(bad.orders[0]!.state).not.toBe('BLOCKED');
    expect(bad.orders[0]!.blocker).toBeNull();
    const serialized = JSON.stringify(bad);
    expect(serialized).not.toContain(SENTINEL);
    expect(serialized).not.toContain(runsDir);
    expect(serialized).not.toContain('boom');
    fail = false;
    const good = await call({ read: async () => t, lanes });
    expect(lanes).toHaveBeenCalledTimes(2);
    expect(good.lanes).toBe('healthy');
    expect(good.orders[0]).toMatchObject({ state: 'BLOCKED' });
  });

  it('a lane read that hangs past the bound degrades to unavailable with no leaked timer, then recovers', async () => {
    const { runsDir } = runsRoot(slots({ claude: lane() }));
    const t = trace([order('held', [job('RQ-PHX-HELD5', 'queued', 'claude')])]);
    let hang = true;
    const lanes = vi.fn(() => hang
      ? new Promise<never>(() => {})
      : readLaneTargets({ runsDir, now: () => new Date(LANES_AT) }));
    vi.useFakeTimers();
    const pending = call({ read: async () => t, lanes, timeoutMs: 30 });
    await vi.advanceTimersByTimeAsync(60);
    const bad = await pending;
    expect(bad.lanes).toBe('unavailable');
    expect(bad.orders[0]!.state).not.toBe('BLOCKED');
    expect(vi.getTimerCount()).toBe(0);
    vi.useRealTimers();
    hang = false;
    const good = await call({ read: async () => t, lanes });
    expect(good.lanes).toBe('healthy');
    expect(good.orders[0]!.state).toBe('BLOCKED');
    expect(lanes).toHaveBeenCalledTimes(2);
  });

  it('a degraded slots.json read is unavailable, not healthy, and claims no BLOCKED', async () => {
    const { runsDir, writeSlots } = runsRoot(slots({ claude: lane() }));
    writeSlots({ claude: { target: 'not-a-number', floor: 0, ceiling: 4 } });
    const t = trace([order('held', [job('RQ-PHX-HELD6', 'queued', 'claude')])]);
    const body = await call({ read: async () => t, lanes: lanesRead(runsDir) });
    expect(body.lanes).toBe('unavailable');
    expect(body.orders[0]!.state).not.toBe('BLOCKED');
    expect(body.orders[0]!.blocker).toBeNull();
  });

  it('an invalid sinceHours and a failed trace read return early without a lane read', async () => {
    const lanes = vi.fn(async () => { throw new Error('must not be called'); });
    const invalid = await call({ sinceHours: 0, lanes });
    expect(invalid.status).toBe('invalid');
    const failed = await call({
      read: async () => { throw new Error('trace boom'); },
      lanes,
    });
    expect(failed.sources).toBe('unavailable');
    expect(failed.orders).toEqual([]);
    expect(lanes).not.toHaveBeenCalled();
  });
});
