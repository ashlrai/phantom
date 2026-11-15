import { describe, expect, it } from 'vitest';
import { MAX_STALE_INTENT_SPOTS, projectWorldModel, type IntentWorldReading } from '../src/core/world/project.js';

const NOW_MS = Date.parse('2026-11-10T12:00:00.000Z');

function base(intents?: IntentWorldReading | null) {
  return {
    nowMs: NOW_MS,
    sensors: null,
    roster: null,
    claims: null,
    busReadable: null,
    queue: null,
    ci: null,
    updatePhase: null,
    bottlenecks: null,
    bottlenecksObservedAt: null,
    stepsRemaining: null,
    stepsObservedAt: null,
    outcomes: null,
    intents,
  };
}

function reading(over: Partial<IntentWorldReading> = {}): IntentWorldReading {
  return {
    sourceQuality: 'readable', countQuality: 'observed',
    items: 3, tracked: 2, merged: 1, shipped: 0, verified: 0, stale: 1, partial: 0,
    staleItems: [{ id: 'directive-secret-title' }],
    ...over,
  };
}

describe('projectWorldModel intents (recut of #4412)', () => {
  it('reports observed ledger counts as fresh and never promotes merged to shipped', () => {
    const model = projectWorldModel(base(reading()));
    expect(model.intents.items).toMatchObject({ value: 3, freshness: 'fresh', source: 'ashlr.intent-ledger/v1' });
    expect(model.intents.merged.value).toBe(1);
    expect(model.intents.shipped.value).toBe(0);
    expect(model.intents.stale.value).toBe(1);
  });

  it('emits opaque stale blind spots with the intent-sweep hint and no directive text', () => {
    const model = projectWorldModel(base(reading({ stale: 2, staleItems: [{ id: 'a-one' }, { id: 'a-two' }, { id: 'a-one' }] })));
    const spots = model.blindSpots.filter((s) => s.path.startsWith('intents.stale.'));
    expect(spots).toHaveLength(2);
    for (const spot of spots) {
      expect(spot.freshness).toBe('stale');
      expect(spot.need).toContain('phm fleet intent-sweep');
      expect(spot.path).toMatch(/^intents\.stale\.i-[0-9a-f]{10}$/);
    }
    expect(JSON.stringify(model)).not.toContain('a-one');
  });

  it.each([
    ['absent', undefined],
    ['unreadable', reading({ sourceQuality: 'unavailable', countQuality: 'unknown' })],
  ])('keeps every intents field unknown when the reading is %s', (_name, intents) => {
    const model = projectWorldModel(base(intents ?? null));
    for (const field of Object.values(model.intents)) {
      expect(field).toMatchObject({ value: null, freshness: 'unknown' });
    }
    expect(model.blindSpots.some((s) => s.path === 'intents.items')).toBe(true);
    expect(model.blindSpots.filter((s) => s.path.startsWith('intents.stale.'))).toEqual([]);
  });

  it('bounds stale blind spots while the count stays exact', () => {
    const staleItems = Array.from({ length: MAX_STALE_INTENT_SPOTS + 7 }, (_, n) => ({ id: `d-${n}` }));
    const model = projectWorldModel(base(reading({ stale: staleItems.length, staleItems })));
    expect(model.intents.stale.value).toBe(MAX_STALE_INTENT_SPOTS + 7);
    expect(model.blindSpots.filter((s) => s.path.startsWith('intents.stale.'))).toHaveLength(MAX_STALE_INTENT_SPOTS);
  });
});
