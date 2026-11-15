import { describe, expect, it } from 'vitest';
import { worldLaneRows } from '../resources/world-lane-rows.js';
import { worldLaneNote } from './world-lane-note.js';

const now = Date.parse('2026-11-09T08:00:00Z');
const field = (value: number, freshness = 'fresh') => ({ value, freshness, source: 'sensor', observedAt: new Date(now - 60_000).toISOString() });
const lane = (name: string, freshness = 'fresh') => ({ lane: name, used: field(34, freshness), remaining: field(66, freshness), unit: { ...field(0), value: 'percent' } });
const rows = (...lanes: ReturnType<typeof lane>[]) => worldLaneRows({ sensors: { lanes } }, now);

describe('worldLaneNote', () => {
  it('includes fresh usage, remaining, source and age', () => {
    expect(worldLaneNote(['codex-personal'], rows(lane('codex-personal')))).toBe('Lane capacity from the world model: Codex personal 34% used, 66% left, from sensor, 1m ago.');
  });
  it('ignores stale rows', () => {
    expect(worldLaneNote(['codex-personal'], rows(lane('codex-personal', 'stale')))).toBeNull();
  });
  it('ignores unknown lanes', () => {
    expect(worldLaneNote(['missing'], rows(lane('codex-personal')))).toBeNull();
  });
  it('joins two lanes in one sentence', () => {
    expect(worldLaneNote(['codex-personal', 'devin'], rows(lane('codex-personal'), lane('devin')))).toBe('Lane capacity from the world model: Codex personal 34% used, 66% left, from sensor, 1m ago; Devin 34% used, 66% left, from sensor, 1m ago.');
  });
});
