/** The Pools board's words: counts, the next reset, time spans and each row's labelled readings, built from real pools.v1 rows. */
import { describe, expect, it } from 'vitest';
import { buildPoolsView } from '../../../../core/fleet/pools-view.js';
import type { ResourceLaneRow, ResourceLedgerV1 } from '../../../../core/fleet/runs-resource-ledger.js';
import { hoursUntil, nextReset, poolBar, poolCounts, poolFacts, poolGroup, poolsHeadline, projectedEndPct, scopeLine, scopeName, span } from './pools-board-model.js';

const NOW = Date.parse('2026-11-17T12:00:00.000Z');
const at = (hours: number) => new Date(NOW + hours * 3_600_000).toISOString();
const lane = (name: string, patch: Partial<ResourceLaneRow>, asOfHours = -0.1): ResourceLaneRow => ({
  lane: name, running: 1, target: 2, held: false, window: 'weekly', usedPct: 50, creditsRemaining: null, resetAt: at(84),
  burnPctPerHour: null, tokensPerHour6h: null, projectedExhaustion: null, source: null, deadSignal: null,
  observation: { source: 'claude-native-usage', asOf: at(asOfHours) }, ...patch,
});
const view = (...lanes: ResourceLaneRow[]) => buildPoolsView({ v: 1, generatedAt: at(0), asOf: at(0), lanes, apiSpend: null, jobsMalformedRows: null,
  sources: { status: 'healthy', apiSpend: 'missing', jobs: 'missing' } } satisfies ResourceLedgerV1, NOW);
const facts = (row: ResourceLaneRow) => { const built = view(row); return Object.fromEntries(poolFacts(built.pools[0]!, built, iso => `local ${iso}`).map(fact => [fact.label, fact])); };

describe('pools board model', () => {
  it('counts rows by state and words the headline', () => {
    const mixed = view(lane('behind', { usedPct: 20, resetAt: at(24), burnPctPerHour: 0.5 }), lane('pace', { usedPct: 60, resetAt: at(60), burnPctPerHour: 0.7 }), lane('none', { usedPct: null }));
    expect(poolCounts(mixed.pools)).toEqual({ all: 3, fast: 0, behind: 1, pace: 1, unknown: 1 });
    expect(poolsHeadline(mixed.pools)).toBe('1 behind, 1 unknown.');
    expect(poolsHeadline(view(lane('pace', { usedPct: 60, resetAt: at(60), burnPctPerHour: 0.7 })).pools)).toBe('Nothing is behind.');
    expect(poolsHeadline(view(lane('none', { usedPct: null })).pools)).toBe('No current reading for any resource. Nothing here is known to be on pace.');
    expect(poolsHeadline([])).toBe('No resources reported.');
  });

  it('writes a span in its two largest units', () => {
    expect([0.001, 0.5, 5, 5.5, 24, 60.4, 167.99].map(span)).toEqual(['1 min', '30 min', '5 h', '5 h 30 min', '1 d', '2 d 12 h', '6 d 23 h']);
  });

  it('names the soonest reset still ahead, even for a pool whose usage reading is stale, and none when no reset is known', () => {
    const built = view(lane('later', { resetAt: at(60) }), lane('stale-soon', { resetAt: at(2) }, -2), lane('passed', { resetAt: at(-3) }), lane('devin', { window: 'credits', resetAt: null }));
    expect(nextReset(built)).toEqual({ id: 'stale-soon', hours: 2 });
    expect(nextReset(view(lane('passed', { resetAt: at(-3) }), lane('none', { resetAt: null })))).toBeNull();
    expect(hoursUntil(null, built)).toBeNull();
    expect(hoursUntil(at(3), { generatedAt: 'not a time' })).toBeNull();
  });

  it('ends the projection where the burn ends, never short of what is already used', () => {
    expect(projectedEndPct(view(lane('behind', { usedPct: 20, resetAt: at(24), burnPctPerHour: 0.5 })).pools[0]!)).toBe(32);
    expect(projectedEndPct(view(lane('pace', { usedPct: 60, resetAt: at(60), burnPctPerHour: 0.7 })).pools[0]!)).toBe(100);
    expect(projectedEndPct(view(lane('held', { usedPct: 30, held: true })).pools[0]!)).toBe(30);
    expect(projectedEndPct(view(lane('none', { usedPct: null })).pools[0]!)).toBeNull();
  });

  it('groups a pool that runs empty before reset as too fast, not on pace', () => {
    const fast = view(lane('fast', { usedPct: 70, resetAt: at(40), burnPctPerHour: 3.5 })).pools[0]!;
    expect(fast).toMatchObject({ verdict: 'slow down', wasteRisk: 'low' });
    expect(poolGroup(fast)).toBe('fast');
    expect(poolsHeadline([fast])).toBe('1 too fast.');
    expect(facts(lane('fast', { usedPct: 70, resetAt: at(40), burnPctPerHour: 3.5 })).Empty!.value).not.toBe('not before reset');
  });

  it('lists a plan pool with every reading, its basis, its reader and its jobs', () => {
    expect(facts(lane('claude', { usedPct: 20, resetAt: at(60.5), burnPctPerHour: 0.5, running: 3, target: 4 }))).toEqual({
      Used: { label: 'Used', value: '20%' }, Left: { label: 'Left', value: '80%' },
      Resets: { label: 'Resets', value: 'in 2 d 12 h', note: `local ${at(60.5)}` },
      Burn: { label: 'Burn', value: '0.5%/h', note: 'reported' }, 'Unused at reset': { label: 'Unused at reset', value: '49.8%' },
      Empty: { label: 'Empty', value: 'not before reset' },
      Jobs: { label: 'Jobs', value: '3 of 4 running' }, Read: { label: 'Read', value: '6 min ago', note: 'claude-native-usage' },
    });
    // No reported burn and no recent readings: the window average is not a burn, so it reads unknown.
    expect(facts(lane('average', { usedPct: 40, running: 2, target: null })).Burn).toEqual({ label: 'Burn', value: null, note: undefined });
    expect(facts(lane('average', { usedPct: 40, running: 2, target: null })).Jobs!.value).toBe('2 running');
    expect(facts(lane('held', { usedPct: 30, held: true })).Burn).toEqual({ label: 'Burn', value: '0%/h', note: 'lane is held' });
  });

  it('leaves a missing reading unknown (null), never zero, and says a passed reset has passed', () => {
    const stale = facts(lane('stale', { usedPct: 10, resetAt: at(2), running: null }, -2));
    expect([stale.Used!.value, stale.Left!.value, stale.Burn!.value, stale['Unused at reset']!.value, stale.Jobs!.value]).toEqual([null, null, null, null, null]);
    expect(stale.Resets!.value).toBe('in 2 h');
    expect(stale.Read!.value).toBe('2 h ago');
    expect(facts(lane('expired', { usedPct: 90, resetAt: at(-3) })).Resets).toEqual({ label: 'Resets', value: 'passed', note: `local ${at(-3)}` });
    expect(facts(lane('no-reset', { resetAt: null })).Resets).toEqual({ label: 'Resets', value: null, note: undefined });
    expect(facts(lane('future', {}, 1)).Read!.value).toBeNull();
  });

  it('shows a credits pool as a balance and an unmetered lane as its jobs only', () => {
    expect(Object.values(facts(lane('devin', { window: 'credits', usedPct: null, creditsRemaining: 1234.56, resetAt: null }))).map(fact => [fact.label, fact.value]))
      .toEqual([['Balance', '1,234.6 credits'], ['Jobs', '1 of 2 running'], ['Read', '6 min ago']]);
    expect(facts(lane('devin', { window: 'credits', usedPct: null, creditsRemaining: null, resetAt: null })).Balance!.value).toBeNull();
    expect(Object.keys(facts(lane('local', { window: 'none', usedPct: null, resetAt: null })))).toEqual(['Jobs']);
  });

  it('names and words a per-model window', () => {
    expect([scopeName('seven_day_fable'), scopeName('opus'), scopeName('seven_day_sonnet_long')]).toEqual(['Fable', 'Opus', 'Sonnet long']);
    expect(scopeLine({ id: 'a', usedPct: 41.3, resetAt: at(30), hoursLeft: 30 })).toBe('41.3% used, resets in 1 d 6 h');
    expect(scopeLine({ id: 'a', usedPct: 100, resetAt: null, hoursLeft: null })).toBe('100% used, reset unknown');
    expect(scopeLine({ id: 'a', usedPct: null, resetAt: at(-1), hoursLeft: null })).toBe('unknown: its window reset and there is no new reading');
  });

  it('splits a card\'s bar into the shares the row holds, and projects nothing the row does not', () => {
    const bar = (row: ResourceLaneRow) => poolBar(view(row).pools[0]!);
    // 20% used and 0.5%/h for 24 h ends at 32%: 12 more, 68 left unused.
    expect(bar(lane('behind', { usedPct: 20, resetAt: at(24), burnPctPerHour: 0.5 })))
      .toEqual({ more: 12, unused: 68, ending: 'unused', words: '20% used, 85.7% of the window elapsed, 32% by reset at this burn, 68% left unused' });
    // 2%/h empties the last 40% in 20 h, 40 h before the reset: the view says slow down, so the bar is the dry one.
    const fast = bar(lane('fast', { usedPct: 60, resetAt: at(60), burnPctPerHour: 2 }));
    expect([fast.more, fast.unused, fast.ending]).toEqual([40, 0, 'dry']);
    expect(fast.words).toBe('60% used, 64.3% of the window elapsed, 100% by reset at this burn');
    // No burn: used so far is drawn and nothing after it.
    expect(bar(lane('still', { usedPct: 50, resetAt: at(84) }))).toEqual({ more: null, unused: null, ending: 'unprojected', words: '50% used, 50% of the window elapsed' });
    expect(bar(lane('none', { usedPct: null }))).toEqual({ more: null, unused: null, ending: 'unread', words: 'usage unknown' });
  });
});
