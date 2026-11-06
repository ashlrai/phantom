import { describe, expect, it } from 'vitest';
import { parseSuperseded, supersededCounts, supersededLabel } from './superseded-rows-model.js';

const dirty = { open: 2, openTitle: 'Fake old change', openState: 'DIRTY', mergedBy: 20, mergedTitle: 'Fake merged change', jobId: 'RQ-FAKE-ONE' };
const clean = { open: 1, openTitle: 'Fake old clean change', openState: 'CLEAN', mergedBy: 21, mergedTitle: 'Fake merged clean change', jobId: 'RQ-FAKE-TWO' };
const fixture = { v: 1, generatedAt: '2026-11-01T00:00:00Z', source: 'ok', openDirty: 4, pairs: [dirty, clean] };

describe('superseded rows', () => {
  it('accepts the pinned shape and drops malformed or duplicate pairs', () => {
    expect(parseSuperseded({ ...fixture, pairs: [dirty, { ...clean, open: 1.5 }, dirty, clean] })).toEqual(fixture);
  });

  it('treats unknown versions and malformed responses as unavailable', () => {
    for (const raw of [{ ...fixture, v: 2 }, null, { ...fixture, pairs: null }]) {
      expect(parseSuperseded(raw)).toMatchObject({ source: 'unavailable', pairs: [] });
    }
  });

  it('labels the merged replacement and counts only dirty pairs against the backlog', () => {
    const view = parseSuperseded(fixture);
    expect(supersededLabel(view.pairs[0]!)).toBe('superseded by #20 (merged)');
    expect(supersededCounts(view, 4)).toEqual({ superseded: 2, liveDirty: 3 });
    expect(supersededCounts(view, null)).toEqual({ superseded: 2, liveDirty: null });
  });
});
