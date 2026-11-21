/** Fixture tests for pools.spenddown.v1 (`phm pools spenddown`): synthetic ledger rows, no real home. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdPools } from '../src/cli/pools.js';
import { buildPoolsView } from '../src/core/fleet/pools-view.js';
import { buildSpendDown, formatSpendDownText, queuedHours, SPENDDOWN_SCHEMA, type SpendDownExtras } from '../src/core/fleet/pools-spenddown.js';
import type { ResourceLaneRow, ResourceLedgerV1 } from '../src/core/fleet/runs-resource-ledger.js';

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
const chart = (...lanes: ResourceLaneRow[]) => buildSpendDown(buildPoolsView(ledger(...lanes), NOW));
const only = (row: ResourceLaneRow) => chart(row).pools[0]!;

describe('buildSpendDown', () => {
  it('on pace: used, even pace and projected line up and the verdict says so', () => {
    // 50% used, 84 h left of 168 h (even pace 50%), burning 0.6 %/h: 50 + 50.4 lands at 100%.
    expect(only(lane('claude', { usedPct: 50, burnPctPerHour: 0.6 }))).toMatchObject({
      id: 'claude', label: 'Claude', state: 'on-pace', used_frac: 0.5, even_pace_frac: 0.5, projected_at_reset: 1,
      reset_at: at(84), verdict: 'spending on pace', reason: null,
    });
  });

  it('writes one plain sentence per pool: on pace, behind, spent and unknown', () => {
    expect(only(lane('claude', { usedPct: 50, burnPctPerHour: 0.35, resetAt: at(144) })).sentence).toBe('Claude: 50% used, 6 days left, on pace');
    expect(only(lane('claude', { usedPct: 50, burnPctPerHour: 0.1 })).sentence).toMatch(/^Claude: 50% used, 4 days left, behind: will leave \d+% unused$/);
    expect(only(lane('zai', { usedPct: 100, resetAt: at(5) })).sentence).toMatch(/^Zai: 100% used, 5 hours left, spent until \w{3} \d{1,2} [AP]M$/);
    expect(only(lane('grok', { usedPct: null, observation: null as never })).sentence).toBe('Grok: unknown');
  });

  it('under-spending: says how much will be left and to add work', () => {
    // 72% used with 31 h left, burning 0.3 %/h: ends near 81%, 19% unused.
    const row = only(lane('claude', { usedPct: 72, resetAt: at(31), burnPctPerHour: 0.3 }));
    expect(row).toMatchObject({ state: 'under', used_frac: 0.72, even_pace_frac: 0.815, projected_at_reset: 0.813, verdict: 'behind: will waste ~19%' });
  });

  it('over-spending: names the day and hour it runs dry', () => {
    const row = only(lane('codex-cmp', { usedPct: 70, resetAt: at(100), burnPctPerHour: 3.6 }));
    expect(row.state).toBe('over');
    expect(row.verdict).toMatch(/^will run out about \w{3} \d{1,2} [AP]M: slow down$/);
    expect(row.projected_empty_at).toBe(at(30 / 3.6));
  });

  it('drained: fully used reads empty until the reset', () => {
    const row = only(lane('claude', { usedPct: 100, resetAt: at(20) }));
    expect(row).toMatchObject({ state: 'drained', used_frac: 1, projected_at_reset: 1, reset_at: at(20) });
    expect(row.verdict).toMatch(/^exhausted until \w{3} \d{1,2} [AP]M$/);
  });

  it('unknown: no reading is "no reading", never zero', () => {
    expect(only(lane('zai', { usedPct: null }))).toMatchObject({
      state: 'unknown', used_frac: null, even_pace_frac: null, projected_at_reset: null, verdict: 'unknown: no reading', reason: 'no reading',
    });
    // A reading with no burn to project from keeps the used share and says why there is no marker.
    expect(only(lane('grok', { usedPct: 40 }))).toMatchObject({
      state: 'unknown', used_frac: 0.4, projected_at_reset: null, verdict: 'unknown: not enough readings for a pace',
    });
  });

  it('stale reading: says unknown with the reading age, never a stale number', () => {
    const row = only(lane('claude', { usedPct: 60, observation: { source: 'claude-native-usage' as const, asOf: at(-3) } }));
    expect(row).toMatchObject({ state: 'unknown', used_frac: null, reading_age_min: 180, verdict: 'unknown: no fresh reading (3 h old)' });
  });

  it('says when it resets, in hours', () => {
    expect(only(lane('claude', { usedPct: 50, resetAt: at(22), burnPctPerHour: 0.6 })).resets_in_h).toBe(22);
    expect(only(lane('zai', { usedPct: null, resetAt: null })).resets_in_h).toBeNull();
  });

  it('keeps pools.v1 order and prints one plain line per pool', () => {
    const data = chart(lane('claude', { usedPct: 50, burnPctPerHour: 0.6 }), lane('zai', { usedPct: null }));
    expect(data.schema).toBe(SPENDDOWN_SCHEMA);
    expect(data.generated_at).toBe(at(0));
    expect(formatSpendDownText(data).split('\n')).toEqual(['Claude: 50% used, even pace 50%, ends near 100%: spending on pace; 1 running of 2 slots, queue unknown; queued: unknown', 'Zai: unknown: no reading; 1 running of 2 slots, queue unknown; queued: unknown']);
    expect(formatSpendDownText({ ...data, pools: [] })).toBe('No plans reported.');
  });
});

const withExtras = (extras: SpendDownExtras, ...lanes: ResourceLaneRow[]) => buildSpendDown(buildPoolsView(ledger(...lanes), NOW), extras);
const supply = (id: string, ready: number | null): NonNullable<SpendDownExtras['supply']> => ({ pools: [{ id, ready } as never] });

describe('queued_hours', () => {
  it('known: queued jobs times the median job time, one decimal', () => {
    const row = withExtras({ supply: supply('claude', 7), medianJobMinByLane: { claude: 30 } }, lane('claude', { burnPctPerHour: 0.6 })).pools[0]!;
    expect(row.queued_hours).toBe(3.5);
    expect(formatSpendDownText({ schema: SPENDDOWN_SCHEMA, generated_at: at(0), pools: [row] })).toMatch(/; 3\.5 h queued$/);
  });

  it('an empty queue is 0, not unknown', () => {
    expect(queuedHours(0, null)).toBe(0);
  });

  it('unknown: no job times, no queue read, or nothing passed at all', () => {
    expect(withExtras({ supply: supply('claude', 4), medianJobMinByLane: {} }, lane('claude')).pools[0]!.queued_hours).toBeNull();
    expect(withExtras({ supply: supply('claude', null), medianJobMinByLane: { claude: 30 } }, lane('claude')).pools[0]!.queued_hours).toBeNull();
    const bare = only(lane('claude'));
    expect(bare.queued_hours).toBeNull();
    expect(formatSpendDownText({ schema: SPENDDOWN_SCHEMA, generated_at: at(0), pools: [bare] })).toMatch(/; queued: unknown$/);
  });
});

describe('blocked: sign-in', () => {
  const held = lane('gemini', { held: true, usedPct: 20 });
  it('says blocked: sign-in with the one step when the lane is held for a sign-in', () => {
    const row = withExtras({ heldReasons: { gemini: 'Gemini logged out' } }, held).pools[0]!;
    expect(row).toMatchObject({ verdict: 'blocked: sign-in', blocked: 'sign-in', blocked_fix: 'sign in to Gemini once: run gemini in a terminal' });
  });

  it('a lane held for another reason, or an unheld lane, is not blocked', () => {
    expect(withExtras({ heldReasons: { gemini: 'paused by hand' } }, held).pools[0]).toMatchObject({ blocked: null, blocked_fix: null });
    expect(withExtras({ heldReasons: { gemini: 'logged out' } }, lane('gemini', { usedPct: 20 })).pools[0]!.blocked).toBeNull();
  });
});

describe('refilled, lane idle', () => {
  const ready = (n: number | null) => ({ supply: supply('claude', n) });
  // 5% used, 160 h left of 168 h (4.8% elapsed): the pool just refilled.
  const fresh = (patch: Partial<ResourceLaneRow> = {}) => lane('claude', { usedPct: 5, resetAt: at(160), burnPctPerHour: 0.5, running: 0, target: 2, ...patch });

  it('a pool at 5% with 0 running and 5 queued is refilled, lane idle', () => {
    const row = withExtras(ready(5), fresh()).pools[0]!;
    expect(row).toMatchObject({ state: 'idle', verdict: 'refilled, lane idle', used_frac: 0.05, running: 0, target: 2, queued_rows: 5 });
    expect(formatSpendDownText({ schema: SPENDDOWN_SCHEMA, generated_at: at(0), pools: [row] })).toContain('0 running of 2 slots, 5 queued');
  });

  it('is not idle when something runs, nothing is queued, the lane is held, or a figure is unreported', () => {
    expect(withExtras(ready(5), fresh({ running: 1 })).pools[0]!.state).not.toBe('idle');
    expect(withExtras(ready(0), fresh()).pools[0]!.state).not.toBe('idle');
    expect(withExtras(ready(5), fresh({ held: true })).pools[0]!.state).not.toBe('idle');
    expect(withExtras(ready(null), fresh()).pools[0]!.state).not.toBe('idle');
    expect(withExtras(ready(5), fresh({ running: null })).pools[0]!.state).not.toBe('idle');
    expect(withExtras({}, fresh()).pools[0]!.queued_rows).toBeNull();
  });

  it('an idle lane deep into the window is behind, not refilled', () => {
    // 40% used with 20 h left, nothing running, rows waiting.
    const row = withExtras(ready(5), lane('claude', { usedPct: 40, resetAt: at(20), burnPctPerHour: 0.2, running: 0 })).pools[0]!;
    expect(row.state).toBe('under');
    expect(row.verdict).toMatch(/^behind: will waste ~\d+%$/);
  });

  it('a drained pool stays exhausted even with rows queued and nothing running', () => {
    expect(withExtras(ready(5), lane('claude', { usedPct: 100, resetAt: at(20), running: 0 })).pools[0]!.state).toBe('drained');
  });
});

describe('phm pools spenddown', () => {
  afterEach(() => vi.restoreAllMocks());
  it('--help names the subcommand and a stray flag exits 2', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await cmdPools(['spenddown', '--help'])).toBe(0);
    expect(String(log.mock.calls[0]![0])).toContain('phm pools spenddown');
    expect(await cmdPools(['spenddown', '--nope'])).toBe(2);
    expect(err).toHaveBeenCalled();
  });
});
