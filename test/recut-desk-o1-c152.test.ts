import { describe, expect, it } from 'vitest';
import { cosMemoryRows, narrowCosMemory } from '../src/web-ui/routes/verse/library/cos-memory-model.js';

describe('Library Leader memory', () => {
  it('displays the latest saved entries with their source and age', () => {
    const entries = narrowCosMemory({ v: 1, entries: [
      { id: 'old', kind: 'fact', text: 'Older fake note', source: 'desktop', updated: '2026-01-01T00:00:00Z' },
      { id: 'new', kind: 'fact', text: 'Newer fake note', source: 'desktop', updated: '2026-01-02T00:00:00Z' },
    ] });
    expect(entries).not.toBeNull();
    const rows = cosMemoryRows(entries!, Date.parse('2026-01-03T00:00:00Z'));
    expect(rows.map((row) => row.text)).toEqual(['Newer fake note', 'Older fake note']);
    expect(rows[0]).toMatchObject({ source: 'desktop', age: '1 d ago' });
  });
});
