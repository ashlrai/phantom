import { describe, expect, it } from 'vitest';
import type { MemoryEntry } from '../../../../core/cos/memory.js';
import { cosMemoryOutcome, cosMemoryRows, narrowCosMemory } from './cos-memory-model.js';

const NOW = Date.parse('2026-11-09T12:00:00Z');
const entry = (over: Partial<MemoryEntry> = {}): MemoryEntry =>
  ({ id: 'a1', kind: 'fact', source: 'desktop', updated: '2026-11-09T09:00:00Z', text: 'Likes tea', ...over });

describe('narrowCosMemory', () => {
  it('accepts the wire shape and drops malformed rows', () => {
    const out = narrowCosMemory({ v: 1, entries: [entry(), { id: 'x' }, null, entry({ kind: 'mood' as never }), entry({ id: '' })] });
    expect(out).toEqual([entry()]);
  });
  it('rejects bodies that are not {v:1, entries[]}', () => {
    for (const bad of [null, 'x', [], {}, { v: 2, entries: [] }, { v: 1 }, { v: 1, entries: 'no' }]) expect(narrowCosMemory(bad)).toBeNull();
  });
  it('accepts an empty list', () => expect(narrowCosMemory({ v: 1, entries: [] })).toEqual([]));
});

describe('cosMemoryRows', () => {
  it('groups doctrine, preference, fact and sorts newest first with an age', () => {
    const rows = cosMemoryRows([
      entry({ id: 'f1', kind: 'fact' }),
      entry({ id: 'p-old', kind: 'preference', updated: '2026-11-08T12:00:00Z' }),
      entry({ id: 'p-new', kind: 'preference', updated: '2026-11-09T11:00:00Z' }),
      entry({ id: 'd1', kind: 'doctrine' }),
    ], NOW);
    expect(rows.map((r) => r.id)).toEqual(['d1', 'p-new', 'p-old', 'f1']);
    expect(rows[0]?.age).toBe('3 h ago');
    expect(rows[3]?.age).toBe('3 h ago');
    expect(rows[2]?.age).toBe('1 d ago');
  });
  it('does not mutate its input and tolerates a bad date', () => {
    const input = [entry({ id: 'b', updated: 'nope' }), entry({ id: 'c' })];
    const rows = cosMemoryRows(input, NOW);
    expect(input[0]?.id).toBe('b');
    expect(rows.map((r) => r.id)).toEqual(['c', 'b']);
    expect(rows[1]?.age).toBe('unknown age');
  });
});

describe('cosMemoryOutcome', () => {
  it('maps every branch to one sentence', () => {
    expect(cosMemoryOutcome(201)).toBe('Remembered.');
    expect(cosMemoryOutcome(200)).toBe('Remembered.');
    expect(cosMemoryOutcome(401)).toBe('Unlock to change memory.');
    expect(cosMemoryOutcome(403)).toBe('Unlock to change memory.');
    expect(cosMemoryOutcome(404)).toBe('This Phantom build cannot change memory from the app.');
    expect(cosMemoryOutcome(422, 'Refused: fixed text.')).toBe('Refused: fixed text.');
    expect(cosMemoryOutcome(422)).toBe('Could not save. Try again.');
    expect(cosMemoryOutcome(500)).toBe('Could not save. Try again.');
    expect(cosMemoryOutcome(0)).toBe('Could not save. Try again.');
  });
});
