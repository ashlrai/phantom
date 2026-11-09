import { describe, expect, it } from 'vitest';
import { readingAge } from './reading-age.js';
describe('reading age', () => {
  it('describes measured and unknown times in plain words', () => {
    const now = Date.parse('2026-11-09T12:00:00Z');
    expect(readingAge('2026-11-09T09:00:00Z', now)).toBe('read 3 h ago');
    expect(readingAge(null, now)).toBe('Reading age unknown');
    expect(readingAge('2026-11-09T13:00:00Z', now)).toBe('Reading age unknown');
  });
});
