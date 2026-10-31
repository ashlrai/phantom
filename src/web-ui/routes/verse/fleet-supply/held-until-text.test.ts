/**
 * routes/verse/fleet-supply/held-until-text.test.ts — unit tests for
 * heldUntilText. nowMs is fixed so every duration and clock is deterministic.
 */
import { describe, expect, it } from 'vitest';
import { heldUntilText } from './held-until-text.js';

const NOW = Date.parse('2026-10-31T15:00:00Z');

describe('heldUntilText', () => {
  it('reads Held for a missing or blank reason', () => {
    expect(heldUntilText(null, NOW)).toBe('Held');
    expect(heldUntilText(undefined, NOW)).toBe('Held');
    expect(heldUntilText('   ', NOW)).toBe('Held');
  });

  it('shows the local back-time and countdown for a future until', () => {
    expect(heldUntilText('out of usage until 2026-11-01 05:22', NOW))
      .toBe('Out of usage · back Nov 1 01:22 ET, in 14 h');
  });

  it('reads was due back for a past until', () => {
    expect(heldUntilText('out of usage until 2026-10-31 02:11', NOW))
      .toBe('Out of usage · was due back Oct 30 22:11 ET');
  });

  it('shows since + ago for a timestamp without until', () => {
    const text = heldUntilText('token rejected 2026-10-31 14:08:58', NOW);
    expect(text).toContain('since Oct 31 10:08 ET');
    expect(text).toContain('52 min ago');
  });

  it('returns the raw reason when it has no timestamp', () => {
    expect(heldUntilText('Quota exhausted', NOW)).toBe('Quota exhausted');
  });
});
