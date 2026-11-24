import { describe, expect, it } from 'vitest';
import { worldReadingFor } from './world-card-reading.js';
import type { LaneEngine, LaneFreshness, WorldLaneRow } from './world-lane-rows.js';

function row(key: string, engine: LaneEngine, freshness: LaneFreshness = 'fresh', lane = key): WorldLaneRow {
  return {
    history: null,
    key, lane, label: key, engine, usage: 'Used 40%', remaining: 'left 60%', reset: 'unknown', resetAt: null, resetIn: null, burn: 'unknown',
    forecast: 'unknown', forecastText: 'unknown', bar: { used: 40, more: null, unused: null, ending: 'open', figure: '40%', note: 'not projected', text: '40% used; nothing projected' }, source: 'claude-usage', observedAt: null, freshness, age: '2m ago', summary: '',
  };
}

describe('worldReadingFor', () => {
  it('matches a seat by canonical alias', () => {
    const rows = [row('claude-max', 'claude'), row('devin', 'devin')];
    expect(worldReadingFor('claude', 'claude', rows)?.key).toBe('claude-max');
    expect(worldReadingFor('claude-subscription', 'claude', rows)?.key).toBe('claude-max');
  });
  it('matches the engine when exactly one row has it', () => {
    expect(worldReadingFor('seat-xyz', 'devin', [row('claude-max', 'claude'), row('devin', 'devin')])?.key).toBe('devin');
  });
  it('refuses an engine-only match when two rows share the engine', () => {
    expect(worldReadingFor('seat-xyz', 'claude', [row('claude-max', 'claude'), row('claude-api', 'claude')])).toBeNull();
  });
  it('returns null for a stale or unknown row', () => {
    expect(worldReadingFor('claude-max', 'claude', [row('claude-max', 'claude', 'stale')])).toBeNull();
    expect(worldReadingFor('claude-max', 'claude', [row('claude-max', 'claude', 'unknown')])).toBeNull();
  });
});
