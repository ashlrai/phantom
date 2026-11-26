/** Fixture tests for queue.supply.v1 (`phm queue supply`) and the digest's supply_low line: synthetic ledger, ready rows and launch log, no real home. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdQueueSupply } from '../src/cli/queue-supply.js';
import { buildPoolsView } from '../src/core/fleet/pools-view.js';
import { buildQueueSupply, countReady, countStarts, formatQueueSupplyText, QUEUE_SUPPLY_SCHEMA, readQueueSupply, supplyLowLine } from '../src/core/fleet/queue-supply.js';
import type { ResourceLaneRow, ResourceLedgerV1 } from '../src/core/fleet/runs-resource-ledger.js';
import { buildStatusDigest, type StatusDigestInput } from '../src/core/leader/status-digest.js';

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const at = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();
const localTime = (hoursAgo: number) => {
  const d = new Date(NOW - hoursAgo * 3_600_000);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
const lane = (name: string, patch: Partial<ResourceLaneRow> = {}): ResourceLaneRow => ({
  lane: name, running: 1, target: 2, held: false, window: 'weekly', usedPct: 50, creditsRemaining: null, resetAt: at(84),
  burnPctPerHour: null, tokensPerHour6h: null, projectedExhaustion: null, source: null, deadSignal: null,
  observation: { source: 'claude-native-usage' as const, asOf: at(-0.1) }, ...patch,
});
const ledger = (...lanes: ResourceLaneRow[]): ResourceLedgerV1 => ({
  v: 1, generatedAt: at(0), sources: { status: 'healthy', apiSpend: 'missing', jobs: 'missing' }, asOf: at(0), lanes, apiSpend: null, jobsMalformedRows: null,
});
const supply = (lanes: ResourceLaneRow[], ready: Record<string, number> | null, starts: Record<string, number> | null) =>
  buildQueueSupply({ view: buildPoolsView(ledger(...lanes), NOW), readyByLane: ready, startsByLane: starts });
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
    expect(noQueue.gaps[0]).toBe('The ready queue could not be read.');
    const noLog = supply([lane('claude')], { claude: 4 }, null);
    expect(row(noLog, 'claude')).toMatchObject({ state: 'unknown', ready: 4, starts_per_hour: null, hours_queued: null, supply_low: false });
    expect(row(noLog, 'claude').reason).toBe('launch window unavailable');
  });

  it('keeps observed zero starts distinct from an unknown queue duration', () => {
    const data = supply([lane('claude', { usedPct: 72, resetAt: at(31), burnPctPerHour: 0.3 })], { claude: 4 }, {});
    expect(row(data, 'claude')).toMatchObject({
      state: 'unknown', at_risk: true, ready: 4, starts_per_hour: 0, hours_queued: null, supply_low: false,
    });
    expect(supplyLowLine(data)).toBeNull();
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

  it('uses observed counts for queue coverage on both sides of the one-hour threshold', () => {
    const pools = [lane('claude', { usedPct: 72, resetAt: at(31), burnPctPerHour: 0.3 })];
    const short = supply(pools, { claude: 6 }, { claude: 37 });
    expect(row(short, 'claude')).toMatchObject({
      state: 'low', supply_low: true, starts_per_hour: 37 / 6, hours_queued: 36 / 37,
    });
    expect(supplyLowLine(short)).toBe('supply_low: Claude (6 queued, about 58 min of work, 28% left): add work');

    const exact = supply(pools, { claude: 6 }, { claude: 36 });
    expect(row(exact, 'claude')).toMatchObject({ state: 'healthy', supply_low: false, hours_queued: 1 });
    expect(supplyLowLine(exact)).toBeNull();

    const above = supply(pools, { claude: 6 }, { claude: 35 });
    expect(row(above, 'claude')).toMatchObject({ state: 'healthy', supply_low: false, hours_queued: 36 / 35 });
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
  it('raises a supply alert only after observing an empty ready queue', async () => {
    const runsDir = await mkdtemp(join(tmpdir(), 'phantom-queue-supply-'));
    try {
      const queue = join(runsDir, 'queue');
      const pool = 'codex-supply-test';
      await mkdir(queue);
      await writeFile(join(queue, 'status.json'), JSON.stringify({
        last_tick: at(0), lanes: { [pool]: { running: 0, target: 2 } },
        budget: { [pool]: { weekly_used_pct: 72, observed_at: at(-0.01), reset_at: at(31), burn_pct_per_hour: 0.3 } },
      }));
      await writeFile(join(runsDir, 'dispatch-events.log'), '');
      const opts = { runsDir, now: () => NOW };

      const missing = await readQueueSupply(opts);
      expect(row(missing, pool)).toMatchObject({ state: 'unknown', at_risk: true, ready: null, hours_queued: null, supply_low: false });
      expect(supplyLowLine(missing)).toBeNull();

      await writeFile(join(queue, 'ready.tsv'), '');
      const empty = await readQueueSupply(opts);
      expect(row(empty, pool)).toMatchObject({ state: 'empty', ready: 0, starts_per_hour: 0, hours_queued: 0, supply_low: true });
      expect(supplyLowLine(empty)).toContain('0 queued');
    } finally {
      await rm(runsDir, { recursive: true, force: true });
    }
  });

  it('uses a truncated dispatch log only when its retained events cover the launch window', async () => {
    const runsDir = await mkdtemp(join(tmpdir(), 'phantom-queue-supply-'));
    try {
      const queue = join(runsDir, 'queue');
      const pool = 'codex-supply-test';
      await mkdir(queue);
      await writeFile(join(queue, 'status.json'), JSON.stringify({
        last_tick: at(0), lanes: { [pool]: { running: 0, target: 2 } },
        budget: { [pool]: { weekly_used_pct: 72, observed_at: at(-0.01), reset_at: at(31), burn_pct_per_hour: 0.3 } },
      }));
      await writeFile(join(queue, 'ready.tsv'), `RQ-A\tphantom\t${pool}\twork\t/p/a\n`);
      const log = join(runsDir, 'dispatch-events.log');
      const launch = `${localTime(1)} LAUNCH RQ-B phantom ${pool} work\n`;
      const padding = 'x'.repeat(2 * 1024 * 1024);
      const opts = { runsDir, now: () => NOW };

      await writeFile(log, `${localTime(6)} EVENT ${padding}\n${localTime(6)} DONE RQ-C\n${launch}`);
      expect(row(await readQueueSupply(opts), pool)).toMatchObject({
        ready: 1, starts_per_hour: null, hours_queued: null, supply_low: false,
        reason: 'launch window unavailable',
      });

      await writeFile(log, `${localTime(7)} EVENT ${padding}\n${localTime(7)} DONE RQ-C\n${launch}`);
      expect(row(await readQueueSupply(opts), pool)).toMatchObject({
        ready: 1, starts_per_hour: 1 / 6, hours_queued: 6,
      });
    } finally {
      await rm(runsDir, { recursive: true, force: true });
    }
  });

  it('counts ready jobs by lane and leaves parked rows out', () => {
    const tsv = ['RQ-A\tphantom\tclaude\twork\t/p/a', 'RQ-B\tphantom\tclaude\twork\t/p/b', 'RQ-C\tphantom\tPARKED-BYHAND.codex-local\twork\t/p/c', ''].join('\n');
    expect(countReady(tsv)).toEqual({ claude: 2 });
  });

  it('counts ready jobs by the lane the market resolves, not the lane column', () => {
    const spec = (lane: string | null) => JSON.stringify({ preferred_lane: lane });
    const tsv = [
      'RQ-A\tphantom\tcodex\twork\t/p/a\t' + spec('claude'),                    // spec preferred_lane wins over the column
      'RQ-B\tphantom\tclaude\twork\t/p/b\t' + spec(null),                       // open hint: the market places it anywhere
      'RQ-C\tphantom\tclaude\twork\t/p/c\t' + spec('claude'),
      'RQ-D\tphantom\tclaude\twork\t/p/d\t{"preferred_lane":"Not A Lane"}',    // invalid spec: the market drops the row
      'PARKED-DEP.after\tRQ-E\tclaude\twork\tphantom\t/p/e\t' + spec('claude'), // status-first parked row
      'READY\tRQ-F\tclaude\twork\tphantom\t/p/f',                              // status-first ready: not a dispatcher job
      'READY\tRQ-G\tclaude\twork\tphantom',                                    // five-cell status-first: still not a job
    ].join('\n');
    expect(countReady(tsv)).toEqual({ claude: 2 });
  });

  it('resolves spec-less ready rows through their router-queue.md envelope', () => {
    const tsv = 'RQ-H\tphantom\tcodex\twork\t/p/h\nRQ-I\tphantom\tclaude\twork\t/p/i';
    const routerQueue = '- READY RQ-H (P1, preferred_lane=claude): hinted work\n- READY RQ-I (P2): no lane in attrs';
    // RQ-H takes the envelope's preferred_lane; RQ-I's envelope names no lane, so the row is open.
    expect(countReady(tsv, routerQueue)).toEqual({ claude: 1 });
    // Without the queue text the lane column stands, exactly like the market's fallback.
    expect(countReady(tsv)).toEqual({ codex: 1, claude: 1 });
  });

  it('counts each job once using its first valid row and preserves low-supply alerts', () => {
    const tsv = [
      'RQ-A\tphantom\tclaude\twork\t/p/a',
      'RQ-A\tphantom\tclaude\twork\t/p/a',
      'RQ-A\tphantom\tcodex\twork\t/p/a',
      'RQ-B\tphantom\t\twork\t/p/b',
      'RQ-B\tphantom\tclaude\twork\t/p/b',
      'RQ-C\tphantom\tclaude\tinvalid\t/p/c',
      'RQ-C\tphantom\tclaude\twork\t/p/c',
    ].join('\n');
    const ready = countReady(tsv);
    expect(ready).toEqual({ claude: 2 });
    const data = supply([lane('claude', { usedPct: 72, resetAt: at(31), burnPctPerHour: 0.3 })], ready, { claude: 18 });
    expect(row(data, 'claude')).toMatchObject({ state: 'low', ready: 2, supply_low: true });
  });

  it('counts LAUNCH lines per lane inside the window only', () => {
    const log = [`${localTime(1)} LAUNCH RQ-A phantom claude mid`, `${localTime(5)} LAUNCH RQ-B phantom claude mid`, `${localTime(7)} LAUNCH RQ-C phantom claude mid`, `${localTime(2)} DONE RQ-A`].join('\n');
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
