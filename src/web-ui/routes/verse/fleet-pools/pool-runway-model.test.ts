/** The Pools board's Runway line: places, states and words, built from real pools.v1 rows. */
import { describe, expect, it } from 'vitest';
import { buildPoolsView } from '../../../../core/fleet/pools-view.js';
import type { ResourceLaneRow, ResourceLedgerV1 } from '../../../../core/fleet/runs-resource-ledger.js';
import { poolRunway } from './pool-runway-model.js';

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const at = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();
const lane = (name: string, patch: Partial<ResourceLaneRow>, asOfHours = -0.1): ResourceLaneRow => ({
  lane: name, running: 1, target: 2, held: false, window: 'weekly', usedPct: 50, creditsRemaining: null, resetAt: at(84),
  burnPctPerHour: null, tokensPerHour6h: null, projectedExhaustion: null, source: null, deadSignal: null,
  observation: { source: 'claude-native-usage', asOf: at(asOfHours) }, ...patch,
});
const view = (...lanes: ResourceLaneRow[]) => buildPoolsView({ v: 1, generatedAt: at(0), asOf: at(0), lanes, apiSpend: null, jobsMalformedRows: null,
  sources: { status: 'healthy', apiSpend: 'missing', jobs: 'missing' } } satisfies ResourceLedgerV1, NOW);
const runway = (...lanes: ResourceLaneRow[]) => poolRunway(view(...lanes), iso => `local ${iso}`);
const row = (built: ReturnType<typeof runway>, key: string) => built!.rows.find(item => item.key === key)!;

describe('pool runway model', () => {
  it('places every plan pool at its reset, soonest first, with the furthest at the end of the line', () => {
    const built = runway(
      lane('claude', { usedPct: 60, resetAt: at(60), burnPctPerHour: 0.7 }),
      lane('codex-cmp', { usedPct: 10, resetAt: at(2) }, -2),
      lane('codex-personal', { usedPct: 20, resetAt: at(24), burnPctPerHour: 0.5 }),
    );
    expect(built!.rows.map(item => [item.key, item.resetPct, item.state])).toEqual([['codex-cmp', 3.3, 'unknown'], ['codex-personal', 40, 'lasts'], ['claude', 100, 'dry']]);
    expect(row(built, 'codex-personal')).toMatchObject({ emptyPct: null, flagged: false, when: `in 1 d · local ${at(24)}`, words: 'lasts to reset, 68% unused at this burn' });
    // A stale reading keeps its reported reset on the line and projects nothing.
    expect(row(built, 'codex-cmp')).toMatchObject({ emptyPct: null, words: 'usage unknown', when: `in 2 h · local ${at(2)}` });
    expect(built!.off).toEqual([]);
    expect(built!.ticks.length).toBeGreaterThan(0);
    expect(built!.ticks.every(tick => tick.leftPct > 0 && tick.leftPct < 100)).toBe(true);
  });

  it('draws the dry stretch from the view\'s own empty time, and flags it only when the view says slow down', () => {
    // 40% left at 0.7%/h is empty in 57.1 h, 2.9 h short of the reset: the view still calls it on pace.
    const near = runway(lane('claude', { usedPct: 60, resetAt: at(60), burnPctPerHour: 0.7 }));
    expect(row(near, 'claude')).toMatchObject({ state: 'dry', flagged: false, emptyPct: 95.2, resetPct: 100, words: 'empty in 2 d 9 h, then dry 2 h 51 min until reset' });
    expect(near!.summary).toBe('1 of 1 plan pool runs empty before reset.');
    // 20% left at 2%/h is empty in 10 h, 50 h short; 50% left at 10%/h is empty in 5 h, so it is the first to run out.
    const early = runway(lane('claude', { usedPct: 80, resetAt: at(60), burnPctPerHour: 2 }), lane('codex', { usedPct: 50, resetAt: at(30), burnPctPerHour: 10 }));
    expect(view(lane('claude', { usedPct: 80, resetAt: at(60), burnPctPerHour: 2 })).pools[0]!.verdict).toBe('slow down');
    expect(row(early, 'claude')).toMatchObject({ state: 'dry', flagged: true, emptyPct: 16.7, words: 'empty in 10 h, then dry 2 d 2 h until reset' });
    expect(row(early, 'codex')).toMatchObject({ state: 'dry', flagged: true, emptyPct: 8.3, resetPct: 50 });
    expect(early!.summary).toBe('2 of 2 plan pools run empty before reset, codex first.');
  });

  it('says fully used, held and burn unknown in words, and never projects them', () => {
    const built = runway(
      lane('full', { usedPct: 100, resetAt: at(12), burnPctPerHour: 1 }),
      lane('held', { usedPct: 30, resetAt: at(24), held: true }),
      lane('quiet', { usedPct: 30, resetAt: at(48) }),
    );
    expect(row(built, 'full')).toMatchObject({ state: 'dry', flagged: true, emptyPct: 0, words: 'fully used, dry 12 h until reset' });
    expect(row(built, 'held')).toMatchObject({ state: 'held', emptyPct: null, words: '70% left, lane held' });
    expect(row(built, 'quiet')).toMatchObject({ state: 'unknown', emptyPct: null, words: '70% left, burn unknown' });
    expect(built!.summary).toBe('1 of 3 plan pools runs empty before reset. 1 held, burning nothing. 1 cannot be projected: no usage or burn reading.');
  });

  it('counts the pools that last, and says so plainly when all of them do', () => {
    const lasting = lane('a', { usedPct: 20, resetAt: at(24), burnPctPerHour: 0.5 });
    expect(runway(lasting)!.summary).toBe('The plan pool lasts to its reset at this burn.');
    expect(runway(lasting, lane('b', { usedPct: 10, resetAt: at(30), burnPctPerHour: 1 }))!.summary).toBe('All 2 plan pools last to their reset at this burn.');
    expect(runway(lasting, lane('b', { usedPct: 10, resetAt: at(30) }))!.summary).toBe('1 of 2 plan pools lasts to reset at this burn. 1 cannot be projected: no usage or burn reading.');
  });

  it('puts a per-model window under its pool with its reset and usage, nothing projected', () => {
    const built = runway(
      lane('claude', { usedPct: 60, resetAt: at(60), burnPctPerHour: 0.7, quotaScopes: [{ id: 'seven_day_opus', usedPct: 90, resetAt: at(-1) }, { id: 'seven_day_fable', usedPct: 41.26, resetAt: at(30) }] }),
      lane('codex', { usedPct: 20, resetAt: at(40), burnPctPerHour: 0.5 }),
    );
    expect(built!.rows.map(item => item.key)).toEqual(['codex', 'claude', 'claude:seven_day_fable']);
    expect(row(built, 'claude:seven_day_fable')).toMatchObject({ pool: 'claude', name: 'Fable', scope: true, state: 'window', flagged: false, resetPct: 50, emptyPct: null, words: '41.3% used' });
    expect(built!.off).toEqual([{ key: 'claude:seven_day_opus', name: 'claude Opus', why: 'its reset has passed' }]);
  });

  it('names what has no place on the line with the reason, and draws nothing when no reset is ahead', () => {
    const built = runway(
      lane('claude', { usedPct: 60, resetAt: at(60), burnPctPerHour: 0.7 }),
      lane('devin', { window: 'credits', usedPct: null, creditsRemaining: 120, resetAt: null }),
      lane('gift', { window: 'credits', usedPct: null, creditsRemaining: 40, creditUnit: 'usd', resetAt: at(24 * 9 + 1) }),
      lane('codex-local', { window: 'none', usedPct: null, resetAt: null }),
      lane('norest', { usedPct: 40, resetAt: null }),
    );
    expect(built!.rows.map(item => item.key)).toEqual(['claude']);
    expect(Object.fromEntries(built!.off.map(item => [item.name, item.why]))).toEqual({
      devin: 'credit balance, no window', gift: 'credit balance, expires in 9 d', 'codex-local': 'no usage window', norest: 'no reset time reported',
    });
    expect(runway(lane('devin', { window: 'credits', usedPct: null, resetAt: null }), lane('none', { usedPct: null, resetAt: null }))).toBeNull();
    expect(runway()).toBeNull();
    expect(poolRunway({ generatedAt: 'not a time', pools: view(lane('claude', { resetAt: at(60) })).pools }, iso => iso)).toBeNull();
  });
});
