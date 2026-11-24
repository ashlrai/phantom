import { describe, expect, it } from 'vitest';
import { poolShareSnapshot } from '../../../../core/usage/runway.js';
import { agoWords, hoursWords, paceView } from './usage-pace-model.js';

const NOW = Date.parse('2026-11-21T12:00:00.000Z');
const asOf = new Date(NOW - 20_000).toISOString();
const read = (inputs: Parameters<typeof poolShareSnapshot>[0], pools: unknown[] = [], at = asOf) =>
  ({ pace: { v: 1, asOf: at, pools, shares: poolShareSnapshot(inputs, at) } });
const byPool = (view: ReturnType<typeof paceView>, pool: string) => view.rows.find(row => row.pool === pool)!;

describe('paceView', () => {
  it('splits new work across the pools with room and draws each bar from the row alone', () => {
    const view = paceView(read([
      { pool: 'claude', usedPercent: 20, burnPerHour: 0.5, hoursToReset: 40 },
      { pool: 'codex-personal', usedPercent: 50, burnPerHour: 0.5, hoursToReset: 20 },
      { pool: 'gemini', usedPercent: 60, burnPerHour: 2, hoursToReset: 30 },
      { pool: 'zai', usedPercent: null, burnPerHour: null, hoursToReset: null },
    ]), NOW);
    expect(view.state).toBe('live');
    expect(view.headline).toBe('Next job goes to Claude.');
    expect(view.note).toBeNull();
    // claude ends at 40% (room 60), codex-personal at 60% (room 40): shares 0.6 and 0.4.
    expect(view.split).toEqual([
      { pool: 'claude', name: 'Claude', pct: 60, slot: 0 },
      { pool: 'codex-personal', name: 'Codex personal', pct: 40, slot: 1 },
    ]);
    expect(byPool(view, 'claude')).toMatchObject({ state: 'wasting', verdict: 'Send work here', figure: '60% of new work', used: 20, more: 20, unused: 60, ending: 'unused',
      valueText: '20% used, 40% by the reset at this burn, 60% left unused' });
    // gemini: 40 left at 2%/h is 20 h of runway against 30 h to the reset.
    expect(byPool(view, 'gemini')).toMatchObject({ state: 'starving', verdict: 'Top priority only', figure: 'no ordinary work', sharePct: 0, used: 60, more: 40, unused: 0, ending: 'dry' });
    expect(byPool(view, 'gemini').facts).toEqual(['40% left', 'runs dry in 20 h', 'resets in 30 h', 'suggested running slots unknown']);
    expect(byPool(view, 'zai')).toMatchObject({ state: 'unknown', figure: 'share unknown', sharePct: null, used: null, more: null, unused: null, ending: 'unread' });
    expect(view.projected).toBe(true);
  });

  it('keeps a colour slot with its pool when the ranking changes', () => {
    const one = paceView(read([{ pool: 'claude', usedPercent: 20, burnPerHour: 0.5, hoursToReset: 40 }, { pool: 'codex-personal', usedPercent: 10, burnPerHour: 0.1, hoursToReset: 20 }]), NOW);
    const two = paceView(read([{ pool: 'claude', usedPercent: 20, burnPerHour: 0.5, hoursToReset: 40 }, { pool: 'codex-personal', usedPercent: 95, burnPerHour: 0.1, hoursToReset: 20 }]), NOW);
    expect(one.rows[0]!.pool).toBe('codex-personal');
    expect(two.rows[0]!.pool).toBe('claude');
    for (const pool of ['claude', 'codex-personal', 'gemini', 'zai']) expect(byPool(one, pool).slot).toBe(byPool(two, pool).slot);
  });

  it('draws the share used, and nothing projected, for a pool that has a reading but no burn yet', () => {
    const row = byPool(paceView(read([{ pool: 'claude', usedPercent: 42, burnPerHour: null, hoursToReset: 30 }]), NOW), 'claude');
    expect(row).toMatchObject({ state: 'unknown', used: 42, more: null, unused: null, ending: 'unprojected', figure: 'share unknown', valueText: '42% used, nothing projected' });
    expect(row.facts).toEqual(['58% left', 'no burn rate yet', 'suggested running slots unknown']);
  });

  it('says a window on pace is used up by its reset, and that no pool has room when none does', () => {
    const view = paceView(read([{ pool: 'claude', usedPercent: 50, burnPerHour: 2, hoursToReset: 28 }, { pool: 'gemini', usedPercent: 99, burnPerHour: 1, hoursToReset: 30 }],
      [{ pool: 'claude', projectedPercent: 100, hoursLeft: 28, recommendedSlots: 0 }]), NOW);
    expect(byPool(view, 'claude')).toMatchObject({ state: 'on_pace', verdict: 'On pace', more: 50, unused: 0, ending: 'even', valueText: '50% used, 100% by the reset at this burn' });
    expect(byPool(view, 'claude').facts).toEqual(['50% left', 'resets in 28 h', 'all of it used by the reset at this burn', 'suggested running slots 0']);
    const dry = paceView(read([{ pool: 'gemini', usedPercent: 99, burnPerHour: 1, hoursToReset: 30 }]), NOW);
    expect(dry.headline).toBe('No pool is known to have room for ordinary work.');
    expect(dry.split).toEqual([]);
  });

  it('reads nothing as current from an old, future-stamped, missing or malformed report', () => {
    const inputs = [{ pool: 'claude', usedPercent: 20, burnPerHour: 0.5, hoursToReset: 40 }];
    const old = paceView(read(inputs, [], new Date(NOW - 121_000).toISOString()), NOW);
    expect(old).toMatchObject({ state: 'stale', headline: 'Where to send work: unknown.', split: [], projected: false,
      note: 'The scheduler last reported 2 minutes ago. A report older than two minutes is not read as current.' });
    expect(old.rows.every(row => row.state === 'unknown' && row.used === null && row.facts[0] === 'no current scheduler report')).toBe(true);
    expect(paceView(read(inputs, [], new Date(NOW + 5_000).toISOString()), NOW).note).toBe('The scheduler report is stamped ahead of this clock, so it is not read as current.');
    for (const raw of [null, {}, { pace: null }, { pace: { v: 2, asOf } }, { pace: { v: 1, asOf: 'soon' } }]) {
      const view = paceView(raw, NOW);
      expect(view).toMatchObject({ state: 'none', asOf: null, note: 'This read holds no scheduler report.', split: [] });
      expect(view.rows.map(row => row.pool)).toEqual(['zai', 'gemini', 'claude', 'codex-personal']);
      expect(view.rows.every(row => row.facts[0] === 'no scheduler report')).toBe(true);
    }
    // A share row with a state this console does not know is not drawn as one.
    const odd = paceView({ pace: { v: 1, asOf, pools: [], shares: { next_pool: 'claude', pools: [{ pool: 'claude', state: 'plentiful', used_percent: 5, suggested_share: 1 }] } } }, NOW);
    expect(byPool(odd, 'claude')).toMatchObject({ state: 'unknown', used: null, sharePct: null });
    expect(odd.headline).toBe('No pool is known to have room for ordinary work.');
  });
});

it('words spans the way phm fleet pools does, without a zero', () => {
  expect([hoursWords(72.4), hoursWords(1), hoursWords(0.5), hoursWords(0.001)]).toEqual(['72 h', '1 h', '30 min', '1 min']);
  expect([agoWords(1_000), agoWords(20_400), agoWords(60_000), agoWords(5 * 60_000), agoWords(3 * 3_600_000)]).toEqual(['1 second ago', '20 seconds ago', '1 minute ago', '5 minutes ago', '3 hours ago']);
});
