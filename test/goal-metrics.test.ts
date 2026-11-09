import { describe, expect, it } from 'vitest';
import { bindGoalMetrics, GOAL_METRIC_STALE_MS } from '../src/core/fleet/goal-metrics.js';

const NOW = Date.parse('2026-11-09T12:00:00Z');
const goal = { id: 'g1', objective: 'Raise merge throughput' };
const at = (minAgo: number) => NOW - minAgo * 60_000;

describe('bindGoalMetrics', () => {
  it('is live for a fresh reading', () => {
    const m = bindGoalMetrics([goal], { 'merges-per-hour': { value: 6, observedAt: at(5) } }, NOW).g1!;
    expect(m).toMatchObject({ metric: 'merges-per-hour', value: 6, unit: '/h', state: 'live', observedAt: at(5) });
  });
  it('is stale past 30 minutes, live at exactly 30', () => {
    expect(GOAL_METRIC_STALE_MS).toBe(30 * 60_000);
    expect(bindGoalMetrics([goal], { 'merges-per-hour': { value: 6, observedAt: at(30) } }, NOW).g1!.state).toBe('live');
    const stale = bindGoalMetrics([goal], { 'merges-per-hour': { value: 6, observedAt: at(31) } }, NOW).g1!;
    expect(stale.state).toBe('stale');
    expect(stale.value).toBe(6);
  });
  it('is unknown, not 0, with no reading or a null value', () => {
    for (const readings of [{}, { 'merges-per-hour': { value: null, observedAt: at(1) } }]) {
      const m = bindGoalMetrics([goal], readings, NOW).g1!;
      expect(m).toMatchObject({ state: 'unknown', value: null, delta24h: null, reason: 'no reading yet' });
    }
  });
  it('is unknown with a reason when no metric is mapped', () => {
    const m = bindGoalMetrics([{ id: 'g2', objective: 'Write the vision doc' }], { 'merges-per-hour': { value: 3, observedAt: at(1) } }, NOW).g2!;
    expect(m).toMatchObject({ metric: null, state: 'unknown', value: null });
    expect(m.reason).toMatch(/no metric/);
  });
  it('is unknown for an unparseable or future timestamp', () => {
    expect(bindGoalMetrics([goal], { 'merges-per-hour': { value: 2, observedAt: 'nope' } }, NOW).g1!.state).toBe('unknown');
    expect(bindGoalMetrics([goal], { 'merges-per-hour': { value: 2, observedAt: NOW + 60_000 } }, NOW).g1!.state).toBe('unknown');
  });
  it('signs the 24h delta and leaves it null without a baseline', () => {
    const dirty = { id: 'g3', objective: 'Drain the dirty PR backlog' };
    const read = (previous24h?: number | null) => bindGoalMetrics([dirty], { 'open-dirty-prs': { value: 4, observedAt: at(1), previous24h } }, NOW).g3!.delta24h;
    expect(read(10)).toBe(-6);
    expect(read(1)).toBe(3);
    expect(read(4)).toBe(0);
    expect(read(undefined)).toBeNull();
    expect(read(null)).toBeNull();
  });
});
