import { describe, expect, it } from 'vitest';
import { launchPulse } from './leader-passes-model.js';

const now = Date.parse('2026-10-31T12:00:00Z');
const snapshot = { workers: [], events: [], mergesLastHour: { count: 0 }, paused: false };

describe('launchPulse', () => {
  it('reports a stall using the youngest worker at the 30-minute boundary', () => {
    expect(launchPulse({ ...snapshot, workers: [{ ageSeconds: 2520 }, { ageSeconds: 1800 }] }, now)).toEqual({
      state: 'stalled', minutesSinceStart: 30, mergedLastHour: 0,
      text: 'Stalled: nothing launched in 30 min, nothing merged',
    });
    expect(launchPulse(snapshot, now).state).toBe('stalled');
  });

  it('reports the newest worker and recent merges', () => {
    expect(launchPulse({ ...snapshot, workers: [{ ageSeconds: 2520 }, { ageSeconds: 180 }], mergesLastHour: { count: 2 } }, now)).toEqual({
      state: 'launching', minutesSinceStart: 3, mergedLastHour: 2,
      text: 'Launching · newest worker 3 min old · 2 merged in the last hour',
    });
    expect(launchPulse({ ...snapshot, workers: [{ ageSeconds: 1800 }], mergesLastHour: { count: 1 } }, now).state).toBe('launching');
  });

  it('reports paused even when the fleet would otherwise be stalled', () => {
    expect(launchPulse({ ...snapshot, paused: true }, now).state).toBe('paused');
  });

  it('uses the newest start or launch event when workers have no age', () => {
    const events = [{ kind: 'start', at: new Date(now - 180_000).toISOString() }, { kind: 'other', at: new Date(now).toISOString() }];
    expect(launchPulse({ ...snapshot, events }, now)).toEqual({
      state: 'launching', minutesSinceStart: 3, mergedLastHour: 0, text: 'Launching · latest start 3 min old',
    });
  });

  it('reports unknown for missing or incomplete data', () => {
    expect(launchPulse(undefined, now)).toEqual({ state: 'unknown', minutesSinceStart: null, mergedLastHour: null, text: 'No launch data' });
    expect(launchPulse({ ...snapshot, mergesLastHour: { count: null } }, now).state).toBe('unknown');
    expect(launchPulse({ ...snapshot, workers: [{ ageSeconds: -1 }] }, now).state).toBe('unknown');
  });
});
