/**
 * World-model JSON → resource-bar rows. Unknown and stale stay unknown.
 */
import { describe, expect, it } from 'vitest';
import { USAGE_SENSOR_STALE_MS } from '../../../../core/usage/sensor-reading.js';
import { WORLD_LANE_STALE_MS, worldLaneRows, type LaneFreshness } from './world-lane-rows.js';

const NOW = Date.parse('2026-11-09T12:00:00.000Z');
const RECENT = new Date(NOW - 2 * 60_000).toISOString();

function field(value: unknown, freshness: LaneFreshness = 'fresh', observedAt: string | null = RECENT, source = 'claude-usage') {
  return { value, source, observedAt, freshness };
}

function model(lanes: unknown[], windows?: unknown[]) {
  return {
    schema: 'ashlr.world-model/v1',
    sensors: { lanes },
    ...(windows ? { views: { observe: { usage: { windows } } } } : {}),
  };
}

const CANONICAL = ['claude-max', 'claude-api', 'codex-personal', 'devin', 'dot', 'grok-ultra', 'cursor-cloud', 'local'];

describe('world lane rows', () => {
  it('uses the usage-sensor staleness window', () => {
    expect(WORLD_LANE_STALE_MS).toBe(USAGE_SENSOR_STALE_MS);
    expect(WORLD_LANE_STALE_MS).toBe(15 * 60_000);
  });

  it('maps a fresh lane to usage, remaining, reset, burn, forecast, source and age', () => {
    const resetAt = new Date(NOW + 10 * 3_600_000).toISOString();
    const exhaustAt = new Date(NOW + 4 * 3_600_000).toISOString();
    const rows = worldLaneRows(model([
      {
        lane: 'claude-max',
        used: field(42),
        limit: field(100),
        remaining: field(58),
        burnRate: field(1.25),
        unit: field('percent'),
        resetAt: field(resetAt),
        forecastExhaustAt: field(exhaustAt),
        forecastVsReset: field('early'),
      },
    ]), NOW);
    expect(rows.map((row) => row.lane)).toEqual([...CANONICAL]);
    expect(rows[0]).toMatchObject({
      label: 'Claude subscription',
      engine: 'claude',
      usage: '42%',
      remaining: '58%',
      reset: 'Nov 9, 10:00 PM UTC',
      resetAt,
      burn: '1.25%/h',
      forecast: 'early',
      forecastText: 'exhausts before reset',
      exhaustFraction: 0.4,
      source: 'claude-usage',
      observedAt: RECENT,
      freshness: 'fresh',
      age: '2m ago',
    });
    expect(rows[0]!.summary).toContain('Source claude-usage');
    expect(rows[1]).toMatchObject({ lane: 'claude-api', usage: 'unknown', remaining: 'unknown', reset: 'unknown', burn: 'unknown', forecast: 'unknown', freshness: 'unknown', source: 'unknown' });
  });

  it('keeps a measured zero and does not turn a null into zero', () => {
    const rows = worldLaneRows(model([
      { lane: 'codex-personal', used: field(0), remaining: field(0), burnRate: field(0), unit: field('percent') },
      { lane: 'dot', used: field(null), remaining: field(null), burnRate: field(null), unit: field('percent') },
    ]), NOW);
    const codex = rows.find((row) => row.lane === 'codex-personal')!;
    const dot = rows.find((row) => row.lane === 'dot')!;
    expect(codex).toMatchObject({ usage: '0%', remaining: '0%', burn: '0%/h', freshness: 'fresh' });
    expect(dot).toMatchObject({ usage: 'unknown', remaining: 'unknown', burn: 'unknown', freshness: 'unknown' });
  });

  it('shows unknown for fields the snapshot does not carry', () => {
    const rows = worldLaneRows(model([
      { lane: 'devin', used: field(3), limit: field(10), unit: field('acu') },
    ]), NOW);
    const devin = rows.find((row) => row.lane === 'devin')!;
    expect(devin).toMatchObject({
      usage: '3 of 10 ACU',
      remaining: 'unknown',
      reset: 'unknown',
      burn: 'unknown',
      forecast: 'unknown',
      forecastText: 'unknown',
      exhaustFraction: null,
      source: 'claude-usage',
    });
  });

  it('styles a stale field as unknown and keeps the observation time', () => {
    const observedAt = new Date(NOW - 20 * 60_000).toISOString();
    const rows = worldLaneRows(model([
      {
        lane: 'grok-ultra',
        used: field(80, 'stale', observedAt, 'grok-status'),
        remaining: field(20, 'stale', observedAt, 'grok-status'),
        burnRate: field(4, 'stale', observedAt, 'grok-status'),
        unit: field('percent', 'stale', observedAt, 'grok-status'),
        resetAt: field(new Date(NOW + 3_600_000).toISOString(), 'stale', observedAt, 'grok-status'),
        forecastVsReset: field('underuse', 'stale', observedAt, 'grok-status'),
      },
    ]), NOW);
    expect(rows.find((row) => row.label === 'Grok')).toMatchObject({
      usage: 'unknown',
      remaining: 'unknown',
      reset: 'unknown',
      burn: 'unknown',
      forecast: 'unknown',
      exhaustFraction: null,
      source: 'grok-status',
      observedAt,
      freshness: 'stale',
      age: '20m ago',
    });
  });

  it('turns a fresh value stale once it passes the staleness window', () => {
    const inside = new Date(NOW - WORLD_LANE_STALE_MS + 1).toISOString();
    const onTheLine = new Date(NOW - WORLD_LANE_STALE_MS).toISOString();
    const fresh = worldLaneRows(model([{ lane: 'cursor-cloud', used: field(10, 'fresh', inside, 'cursor-status'), unit: field('percent', 'fresh', inside, 'cursor-status') }]), NOW);
    const stale = worldLaneRows(model([{ lane: 'cursor-cloud', used: field(10, 'fresh', onTheLine, 'cursor-status'), unit: field('percent', 'fresh', onTheLine, 'cursor-status') }]), NOW);
    expect(fresh.find((row) => row.lane === 'cursor-cloud')).toMatchObject({ usage: '10%', freshness: 'fresh' });
    expect(stale.find((row) => row.lane === 'cursor-cloud')).toMatchObject({ usage: 'unknown', freshness: 'stale', observedAt: onTheLine });
  });

  it('reads reset and forecast from the observe window when the lane does not have them', () => {
    const resetAt = new Date(NOW + 5 * 3_600_000).toISOString();
    const exhaustAt = new Date(NOW + 5 * 3_600_000).toISOString();
    const staleAfter = new Date(NOW + 10 * 60_000).toISOString();
    const rows = worldLaneRows(model(
      [{ lane: 'claude-max', used: field(20), remaining: field(80), burnRate: field(2), unit: field('percent') }],
      [{
        lane: 'claude-max', status: 'fresh', source: 'claude-usage', observedAt: RECENT, staleAfter, unit: 'percent',
        resetAt, forecastExhaustAt: exhaustAt, forecastVsReset: 'on-pace', burnRate: 99,
      }],
    ), NOW);
    expect(rows[0]).toMatchObject({
      reset: 'Nov 9, 5:00 PM UTC',
      resetAt,
      forecast: 'on-pace',
      forecastText: 'meets reset',
      exhaustFraction: 1,
      burn: '2%/h',
    });
  });

  it('does not replace an explicit unknown burn rate with a window value', () => {
    const rows = worldLaneRows(model(
      [{ lane: 'dot', used: field(1, 'fresh', RECENT, 'dot-status'), burnRate: field(null, 'unknown', RECENT, 'dot-status'), unit: field('percent', 'fresh', RECENT, 'dot-status') }],
      [{ lane: 'dot', status: 'fresh', observedAt: RECENT, staleAfter: new Date(NOW + 60_000).toISOString(), source: 'dot-status', burnRate: 9, unit: 'percent' }],
    ), NOW);
    expect(rows.find((row) => row.lane === 'dot')).toMatchObject({ usage: '1%', burn: 'unknown', source: 'dot-status' });
  });

  it('keeps every listed lane, including ones outside the canonical set', () => {
    const rows = worldLaneRows(model([
      { lane: 'grok-ultra', used: field(12), unit: field('percent') },
      { lane: 'grok-bot', used: field(4), unit: field('percent') },
      { lane: 'terra', used: field(1), remaining: field(2) },
      { lane: 'omlx', used: field(7) },
      { lane: 'local', used: field(8) },
    ]), NOW);
    expect(rows.find((row) => row.lane === 'grok-ultra')!.label).toBe('Grok');
    expect(rows.find((row) => row.lane === 'grok-bot')).toMatchObject({ label: 'Grok Bot', engine: 'grok', usage: '4%' });
    expect(rows.find((row) => row.lane === 'terra')).toMatchObject({ label: 'Terra', engine: 'other', usage: '1 used', remaining: '2' });
    expect(rows.find((row) => row.lane === 'local')).toMatchObject({ label: 'Local / oMLX', usage: '8 used' });
    expect(rows.filter((row) => row.lane === 'omlx')).toEqual([expect.objectContaining({ label: 'oMLX', usage: '7 used' })]);
    expect(rows.map((row) => row.lane).filter((lane) => !CANONICAL.includes(lane))).toEqual(['grok-bot', 'terra', 'omlx']);
  });

  it('uses a lone oMLX reading for the local row', () => {
    const rows = worldLaneRows(model([{ lane: 'omlx', used: field(6), unit: field('percent') }]), NOW);
    expect(rows.filter((row) => row.label === 'Local / oMLX')).toHaveLength(1);
    expect(rows.find((row) => row.label === 'Local / oMLX')).toMatchObject({ lane: 'omlx', usage: '6%', engine: 'local' });
    expect(rows.some((row) => row.label === 'oMLX')).toBe(false);
  });

  it('returns the canonical unknown rows for a document that is not a world snapshot', () => {
    expect(worldLaneRows(null, NOW).map((row) => row.lane)).toEqual(CANONICAL);
    expect(worldLaneRows({ sensors: { lanes: 'nope' } }, NOW).every((row) => row.usage === 'unknown' && row.freshness === 'unknown')).toBe(true);
    expect(worldLaneRows({ sensors: { lanes: [{ used: field(1) }, null, { lane: '' }] } }, NOW)).toHaveLength(8);
  });
});
