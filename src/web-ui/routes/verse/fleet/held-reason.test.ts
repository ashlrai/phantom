/**
 * routes/verse/fleet/held-reason.test.ts — unit tests for parseHeldReason.
 */
import { describe, expect, it } from 'vitest';
import { parseHeldReason } from './held-reason.js';

describe('parseHeldReason', () => {
  it('handles null, undefined, and whitespace-only input', () => {
    expect(parseHeldReason(null)).toBeNull();
    expect(parseHeldReason(undefined)).toBeNull();
    expect(parseHeldReason('')).toBeNull();
    expect(parseHeldReason('   ')).toBeNull();
  });

  it('parses "token rejected 2026-10-31 02:11:29" (space-separated, with seconds)', () => {
    const result = parseHeldReason('token rejected 2026-10-31 02:11:29');
    expect(result).toEqual({
      label: 'Token rejected',
      at: '2026-10-31T02:11:29Z',
      until: false,
    });
  });

  it('parses "out of usage until 2026-11-01 01:22" (no seconds, "until" before timestamp)', () => {
    const result = parseHeldReason('out of usage until 2026-11-01 01:22');
    expect(result).toEqual({
      label: 'Out of usage',
      at: '2026-11-01T01:22:00Z',
      until: true,
    });
  });

  it('parses an ISO timestamp with Z suffix', () => {
    const result = parseHeldReason('rate limit reached 2026-10-31T02:11:29Z');
    expect(result).toEqual({
      label: 'Rate limit reached',
      at: '2026-10-31T02:11:29Z',
      until: false,
    });
  });

  it('handles missing seconds, padding with :00', () => {
    const result = parseHeldReason('abuse flagged 2026-11-01 01:22');
    expect(result).toEqual({
      label: 'Abuse flagged',
      at: '2026-11-01T01:22:00Z',
      until: false,
    });
  });

  it('marks until: true when "until" appears before the timestamp', () => {
    const result = parseHeldReason('token suspended until 2026-10-31 02:11:29');
    expect(result).toEqual({
      label: 'Token suspended',
      at: '2026-10-31T02:11:29Z',
      until: true,
    });
  });

  it('marks until: false when "until" appears after the timestamp', () => {
    const result = parseHeldReason('token suspended 2026-10-31 02:11:29 until review');
    expect(result).toEqual({
      label: 'Token suspended until review',
      at: '2026-10-31T02:11:29Z',
      until: false,
    });
  });

  it('caps label at 60 chars with ellipsis when no timestamp', () => {
    const longLabel =
      'a'.repeat(60) + 'b'.repeat(20); // 80 chars
    const result = parseHeldReason(longLabel);
    expect(result).not.toBeNull();
    expect(result!.at).toBeNull();
    expect(result!.until).toBe(false);
    expect(result!.label).toHaveLength(60);
    expect(result!.label.endsWith('…')).toBe(true);
  });

  it('normalises multiple spaces into one and capitalises', () => {
    const result = parseHeldReason('  token    rejected   2026-10-31 02:11 ');
    expect(result).toEqual({
      label: 'Token rejected',
      at: '2026-10-31T02:11:00Z',
      until: false,
    });
  });
});
