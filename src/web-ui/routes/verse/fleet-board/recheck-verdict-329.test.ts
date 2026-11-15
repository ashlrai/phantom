import { describe, expect, it } from 'vitest';
import { deriveRecheckLine } from './recheck-verdict-query.js';

const NOW = Date.parse('2026-11-14T12:00:00Z');
const asOf = new Date(NOW - 5 * 60_000).toISOString();
const mk = (state: unknown, missing?: unknown) =>
  ({ recheck: { asOf, overall: { state, missing } } }) as never;

describe('deriveRecheckLine', () => {
  it('loading', () => {
    expect(deriveRecheckLine(undefined, NOW)).toEqual({ text: 'Server recheck · loading', ok: 'unknown' });
  });
  it('404 (null) and network error say not on this build', () => {
    const want = { text: 'Server recheck · not on this build', ok: 'unknown' };
    expect(deriveRecheckLine(null, NOW)).toEqual(want);
    expect(deriveRecheckLine('error', NOW)).toEqual(want);
  });
  it('VERIFIED', () => {
    expect(deriveRecheckLine(mk('VERIFIED', []), NOW)).toEqual({ text: 'Server recheck · VERIFIED · as of 5m ago', ok: true });
  });
  it('BLOCKED shows first missing entry', () => {
    expect(deriveRecheckLine(mk('BLOCKED', ['fake inbox down', 'second']), NOW))
      .toEqual({ text: 'Server recheck · BLOCKED · fake inbox down · as of 5m ago', ok: false });
  });
  it('UNKNOWN is unknown, not false', () => {
    expect(deriveRecheckLine(mk('UNKNOWN', ['no fake receipt']), NOW))
      .toEqual({ text: 'Server recheck · UNKNOWN · no fake receipt · as of 5m ago', ok: 'unknown' });
  });
  it('non-VERIFIED with empty missing omits the reason', () => {
    expect(deriveRecheckLine(mk('BLOCKED', []), NOW).text).toBe('Server recheck · BLOCKED · as of 5m ago');
  });
  it('truncates the reason at 120 chars', () => {
    const line = deriveRecheckLine(mk('BLOCKED', ['x'.repeat(300)]), NOW);
    expect(line.text).toBe(`Server recheck · BLOCKED · ${'x'.repeat(120)} · as of 5m ago`);
    expect(deriveRecheckLine(mk('BLOCKED', ['y'.repeat(120)]), NOW).text).toContain('y'.repeat(120));
  });
  it('malformed payloads are unreadable and not ok', () => {
    const want = { text: 'Server recheck · unreadable', ok: false };
    expect(deriveRecheckLine({} as never, NOW)).toEqual(want);
    expect(deriveRecheckLine({ recheck: {} } as never, NOW)).toEqual(want);
    expect(deriveRecheckLine({ recheck: { overall: {} } } as never, NOW)).toEqual(want);
    expect(deriveRecheckLine(mk('MAYBE'), NOW)).toEqual(want);
    expect(deriveRecheckLine(mk(7), NOW)).toEqual(want);
  });
});
