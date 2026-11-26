/** Fixture tests for queue.supply.v1 (`phm queue supply`) and the digest's supply_low line: synthetic ledger, ready rows and launch log, no real home. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdQueueSupply } from '../src/cli/queue-supply.js';
import { buildPoolsView } from '../src/core/fleet/pools-view.js';
import { buildQueueSupply, countReady, countStarts, formatQueueSupplyText, QUEUE_SUPPLY_SCHEMA, supplyLowLine } from '../src/core/fleet/queue-supply.js';
import type { ResourceLaneRow, ResourceLedgerV1 } from '../src/core/fleet/runs-resource-ledger.js';
import { buildStatusDigest, type StatusDigestInput } from '../src/core/leader/status-digest.js';

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const at = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();
const lane = (name: string, patch: Partial<ResourceLaneRow> = {}): ResourceLaneRow => ({
  lane: name, running: 1, target: 2, held: false, window: 'weekly', usedPct: 50, creditsRemaining: null, resetAt: at(84),
  burnPctPerHour: null, tokensPerHour6h: null, projectedExhaustion: null, source: null, deadSignal: null,
  observation: { source: 'claude-native-usage' as const, asOf: at(-0.1) }, ...patch,
});
const ledger = (...lanes: ResourceLaneRow[]): ResourceLedgerV1 => ({
  v: 1, generatedAt: at(0), sources: { status: 'healthy', apiSpend: 'missing', jobs: 'missing' }, asOf: at(0), lanes, apiSpend: null, jobsMalformedRows: null,
});
const supply = (lanes: ResourceLaneRow[], ready: Record<string, number> | null, starts: Record<string, number> | null, openRows = 0) =>
  buildQueueSupply({
    view: buildPoolsView(ledger(...lanes), NOW), readyByLane: ready,
    openRows: ready === null ? null : openRows, invalidRows: ready === null ? null : 0, startsByLane: starts,
  });
const row = (data: ReturnType<typeof supply>, id: string) => data.pools.find(p => p.id === id)!;

afterEach(() => vi.restoreAllMocks());

describe('buildQueueSupply', () => {
  it('empty pool with usage left: says how long the usage sits idle', () => {
    // 84% used, 16% left, 21 h to reset, burning 5 %/h: 3.2 h of usage; 12 launches in 6 h is 2 per hour.
    const data = supply([lane('claude', { usedPct: 84, resetAt: at(21), burnPctPerHour: 5 })], {}, { claude: 12 });
    expect(data.schema).toBe(QUEUE_SUPPLY_SCHEMA);
    expect(row(data, 'claude')).toMatchObject({
      state: 'empty', ready: 0, starts_per_hour: 2, hours_queued: 0, left_pct: 16, resets_in_h: 21, idle_hours: 3.2,
      verdict: 'Claude: 0 jobs queued, 16% left, about 3 hours of usage idle',
    });
  });

  it('used-up pool with a full queue: the plan is out until the reset', () => {
    const data = supply([lane('codex-personal', { usedPct: 100, resetAt: at(20.5) })], { 'codex-personal': 104 }, { 'codex-personal': 0 });
    const r = row(data, 'codex-personal');
    expect(r).toMatchObject({ state: 'used-up', ready: 104, left_pct: 0, supply_low: false });
    expect(r.verdict).toMatch(/^[\w -]+: 104 jobs queued, plan used up until \w{3} \d{1,2}(:30)? [AP]M$/);
  });

  it('healthy pool: hours of work queued is ready over starts per hour', () => {
    const data = supply([lane('claude', { usedPct: 40, burnPctPerHour: 0.6 })], { claude: 12 }, { claude: 18 });
    expect(row(data, 'claude')).toMatchObject({ state: 'healthy', ready: 12, starts_per_hour: 3, hours_queued: 4, supply_low: false, reason: null,
      verdict: 'Claude: 12 jobs queued, about 4 hours of work, 60% left' });
  });

  it('unknown usage stays unknown and is never read as zero or as full', () => {
    const data = supply([lane('zai', { usedPct: null })], { zai: 3 }, { zai: 6 });
    expect(row(data, 'zai')).toMatchObject({ state: 'unknown', used_pct: null, left_pct: null, idle_hours: null, supply_low: false, ready: 3 });
    expect(row(data, 'zai').verdict).toMatch(/^Zai: usage unknown \(.+\), 3 jobs queued$/);
  });

  it('an unreadable queue or launch log is unknown, not zero', () => {
    const noQueue = supply([lane('claude')], null, { claude: 6 });
    expect(row(noQueue, 'claude')).toMatchObject({ state: 'unknown', ready: null, hours_queued: null, supply_low: false });
    expect(noQueue.open_rows).toBeNull();
    expect(noQueue.invalid_rows).toBeNull();
    expect(noQueue.gaps[0]).toBe('The ready queue could not be read.');
    const noLog = supply([lane('claude')], { claude: 4 }, null);
    expect(row(noLog, 'claude')).toMatchObject({ state: 'healthy', ready: 4, starts_per_hour: null, hours_queued: null });
    expect(row(noLog, 'claude').reason).toBe('launch log not readable');
  });

  it('lane-open rows are shared supply: a pool with none hinted still has work it can take', () => {
    // 12 launches in 6 h is 2 starts an hour; 24 lane-open rows is 12 hours of work for every pool.
    const data = supply([lane('claude', { usedPct: 40, burnPctPerHour: 0.6 })], {}, { claude: 12 }, 24);
    expect(data.open_rows).toBe(24);
    expect(row(data, 'claude')).toMatchObject({
      state: 'healthy', ready: 0, starts_per_hour: 2, hours_queued: 12, supply_low: false,
      verdict: 'Claude: 0 jobs queued for it, 24 lane-open rows shared, about 12 hours of work, 60% left',
    });
    expect(supplyLowLine(data)).toBeNull();
  });

  it('supply_low still fires when the only work left is a trickle of lane-open rows', () => {
    // Same behind-pool fixture as the supply_low test; one lane-open row is about 30 min of work.
    const data = supply([lane('claude', { usedPct: 72, resetAt: at(31), burnPctPerHour: 0.3 })], {}, { claude: 12 }, 1);
    const r = row(data, 'claude');
    expect(r).toMatchObject({ state: 'low', supply_low: true, ready: 0, hours_queued: 0.5 });
    expect(r.verdict).toMatch(/^Claude: 0 jobs queued for it, 1 lane-open row shared, about 30 min of work, 28% left/);
    expect(supplyLowLine(data)).toBe('supply_low: Claude (1 queued, about 30 min of work, 28% left): add work');
  });

  it('under an hour of work on a pool that is behind is supply_low and named in the digest line', () => {
    // 72% used, 31 h left, burning 0.3 %/h: about 19% would go unused, so the pool is behind.
    const data = supply([lane('claude', { usedPct: 72, resetAt: at(31), burnPctPerHour: 0.3 }), lane('grok', { usedPct: 40, burnPctPerHour: 0.6 })],
      { claude: 1, grok: 0 }, { claude: 12, grok: 12 });
    expect(row(data, 'claude')).toMatchObject({ state: 'low', at_risk: true, supply_low: true, hours_queued: 0.5 });
    expect(row(data, 'claude').verdict).toMatch(/^Claude: 1 job queued, about 30 min of work, 28% left/);
    expect(supplyLowLine(data)).toBe('supply_low: Claude (1 queued, about 30 min of work, 28% left): add work');
    // grok is empty too, but on pace, so it does not raise the line.
    expect(row(data, 'grok')).toMatchObject({ state: 'empty', at_risk: false, supply_low: false });
  });

  it('puts pools that need work first and renders one line each', () => {
    const data = supply([lane('a-healthy', { usedPct: 40, burnPctPerHour: 0.6 }), lane('b-empty', { usedPct: 72, resetAt: at(31), burnPctPerHour: 0.3 })],
      { 'a-healthy': 8, 'b-empty': 0 }, { 'a-healthy': 6, 'b-empty': 6 });
    expect(data.pools.map(p => p.id)).toEqual(['b-empty', 'a-healthy']);
    expect(formatQueueSupplyText(data).split('\n')).toHaveLength(2);
    expect(supplyLowLine(supply([lane('x', { usedPct: 40, burnPctPerHour: 0.6 })], { x: 5 }, { x: 6 }))).toBeNull();
  });
});

describe('readers', () => {
  it('counts ready jobs by the lane hint the market resolves and leaves parked rows out', () => {
    const tsv = [
      'RQ-A\tphantom\tclaude\twork\t/p/a',
      // The requirements cell's preferred_lane beats the lane column.
      'RQ-B\tphantom\tclaude\twork\t/p/b\t{"preferred_lane":"codex-personal"}',
      'RQ-C\tphantom\tPARKED-BYHAND.codex-local\twork\t/p/c',
      // An empty lane cell with no hint is lane-open shared supply.
      'RQ-D\tphantom\t\twork\t/p/d',
      // A lane cell that is not a lane id fails the market's checks: dead work.
      'RQ-E\tphantom\tnot_a_lane!\twork\t/p/e',
      '',
    ].join('\n');
    expect(countReady(tsv)).toEqual({ byLane: { claude: 1, 'codex-personal': 1 }, openRows: 1, invalidRows: 1 });
  });

  it('resolves spec-less rows from the router-queue.md envelope like the dispatcher', () => {
    const routerQueue = [
      '- READY RQ-ENV (P1, pool=gemini): envelope hinted row',
      '- READY RQ-OPEN (P1): envelope with no lane attr stays open',
    ].join('\n');
    const tsv = [
      'RQ-ENV\tphantom\tclaude\twork\t/p/env',
      'RQ-OPEN\tphantom\t\twork\t/p/open',
      'RQ-RAW\tphantom\tclaude\twork\t/p/raw',
    ].join('\n');
    expect(countReady(tsv, routerQueue)).toEqual({ byLane: { gemini: 1, claude: 1 }, openRows: 1, invalidRows: 0 });
  });

  it('counts an explicit null preferred_lane as lane-open supply', () => {
    const tsv = 'RQ-NULL\tphantom\tclaude\twork\t/p/n\t{"preferred_lane":null}';
    expect(countReady(tsv)).toEqual({ byLane: {}, openRows: 1, invalidRows: 0 });
  });

  it('reports lane-open and dead rows at the top level, never as pool supply', () => {
    const counts = countReady([
      'RQ-A\tphantom\tclaude\twork\t/p/a',
      'RQ-D\tphantom\t\twork\t/p/d',
      'RQ-E\tphantom\tnot_a_lane!\twork\t/p/e',
    ].join('\n'));
    const data = buildQueueSupply({
      view: buildPoolsView(ledger(lane('claude', { usedPct: 40, burnPctPerHour: 0.6 })), NOW),
      readyByLane: counts.byLane, openRows: counts.openRows, invalidRows: counts.invalidRows,
      startsByLane: { claude: 12 },
    });
    expect(data.open_rows).toBe(1);
    expect(data.invalid_rows).toBe(1);
    expect(data.gaps.some(g => g.includes('never launch'))).toBe(true);
    // The pool's own count stays the hinted row; the lane-open row is shared supply.
    expect(row(data, 'claude').ready).toBe(1);
    expect(row(data, 'claude').hours_queued).toBe(1);
  });

  it('counts LAUNCH lines per lane inside the window only', () => {
    const local = (hoursAgo: number) => { const d = new Date(NOW - hoursAgo * 3_600_000); const p = (n: number) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`; };
    const log = [`${local(1)} LAUNCH RQ-A phantom claude mid`, `${local(5)} LAUNCH RQ-B phantom claude mid`, `${local(7)} LAUNCH RQ-C phantom claude mid`, `${local(2)} DONE RQ-A`].join('\n');
    expect(countStarts(log, NOW)).toEqual({ claude: 2 });
  });
});

describe('digest', () => {
  const base: StatusDigestInput = {
    installedVersion: { ok: true, value: '1.0.0' }, publishedVersion: { ok: true, value: '1.0.0' }, updatePending: false,
    mergesLastHour: { ok: true, value: 1 }, mergesLast24h: { ok: true, value: 5 }, lanes: { ok: true, value: [] },
    needsMason: { ok: true, value: 0 }, topP0: { ok: true, value: null },
  };
  it('adds the supply_low line only when there is one', () => {
    expect(buildStatusDigest(base).some(l => l.startsWith('supply_low'))).toBe(false);
    expect(buildStatusDigest({ ...base, supplyLine: 'supply_low: Claude (0 queued, 16% left): add work' })).toContain('supply_low: Claude (0 queued, 16% left): add work');
  });
});

describe('phm queue supply', () => {
  it('rejects unknown flags and prints usage for --help', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdQueueSupply(['--nope'])).toBe(2);
    expect(err).toHaveBeenCalled();
    expect(await cmdQueueSupply(['--help'])).toBe(0);
    expect(String(out.mock.calls[0]![0])).toContain('phm queue supply');
  });
});
