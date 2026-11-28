import { describe, expect, it } from 'vitest';
import {
  RELEASE_DAY_MS,
  asReleaseRecord,
  gitReleaseState,
  isNonNegativeInt,
  isReleaseRecord,
  isValidReleaseDate,
  parseReleaseIso,
  parseWholeNumber,
  releaseCount,
  stripReleaseOwner,
} from '../src/core/release/cadence.js';
import { releaseRepo } from '../src/core/release/autonomy-audit.js';
import { escapeReleaseMarkdown } from '../src/core/release/notes.js';

describe('release shared helpers', () => {
  it('narrows plain records and rejects primitives and arrays', () => {
    const obj = { ok: true };
    expect(isReleaseRecord(obj)).toBe(true);
    expect(asReleaseRecord(obj)).toBe(obj);
    for (const value of [null, undefined, 'x', 1, true, []]) {
      expect(isReleaseRecord(value)).toBe(false);
      expect(asReleaseRecord(value)).toBeNull();
    }
  });

  it('validates and canonicalizes release dates', () => {
    expect(isValidReleaseDate('2026-11-20T12:00:00Z')).toBe(true);
    expect(parseReleaseIso('2026-11-20T12:00:00+02:00')).toBe('2026-11-20T10:00:00.000Z');
    for (const bad of ['', 'not-a-date', null, undefined, 123]) {
      expect(isValidReleaseDate(bad)).toBe(false);
      expect(parseReleaseIso(bad)).toBeNull();
    }
  });

  it('validates non-negative integers and parses whole-number strings', () => {
    expect(isNonNegativeInt(0)).toBe(true);
    expect(isNonNegativeInt(42)).toBe(true);
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, '1', null]) {
      expect(isNonNegativeInt(bad)).toBe(false);
    }
    expect(parseWholeNumber('0')).toBe(0);
    expect(parseWholeNumber('128')).toBe(128);
    for (const bad of ['', '-1', '1.5', '12a', '99999999999999999999', null, undefined]) {
      expect(parseWholeNumber(bad)).toBeNull();
    }
  });

  it('formats plural counts, strips owners, resolves enrolled repos, and escapes markdown', () => {
    expect(releaseCount(1, 'PR')).toBe('1 PR');
    expect(releaseCount(0, 'day')).toBe('0 days');
    expect(releaseCount(3, 'commit')).toBe('3 commits');
    expect(stripReleaseOwner('ashlrai/phantom')).toBe('phantom');
    expect(stripReleaseOwner('locus')).toBe('locus');
    expect(releaseRepo('ashlrai/phantom')).toBe('phantom');
    expect(releaseRepo('lexicon')).toBe('lexicon');
    expect(releaseRepo('other/phantom')).toBeNull();
    expect(releaseRepo('unknown')).toBeNull();
    expect(escapeReleaseMarkdown('a_b *c* [d] <e> `f` \\g')).toBe('a\\_b \\*c\\* \\[d\\] \\<e\\> \\`f\\` \\\\g');
  });

  it('applies the shared git-tag backlog due threshold', () => {
    const now = Date.parse('2026-11-20T00:00:00Z');
    const fresh = new Date(now - 7 * RELEASE_DAY_MS).toISOString();
    const old = new Date(now - 7 * RELEASE_DAY_MS - 1).toISOString();
    expect(gitReleaseState(20, fresh, now)).toBe('ok');
    expect(gitReleaseState(21, fresh, now)).toBe('due');
    expect(gitReleaseState(0, old, now)).toBe('due');
  });
});
