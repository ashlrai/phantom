import { describe, expect, it } from 'vitest';

import { flagNouns } from '../src/core/queue/dupcheck.js';
import {
  compareLexical,
  escapeRegExp,
  isEnoent,
  isIsoTimestamp,
  isNonEmptyString,
  isNonNegativeFinite,
  isNonNegativeInt,
  isPlainRecord,
  LEDGER_EVENT_KEYS,
  LEDGER_JOB_KEYS,
  LEDGER_PHASE_KEYS,
  LEDGER_TS_KEYS,
  nonEmptyString,
  parseEpochOrIsoMs,
  parseReadyLineEnq,
  pickTrimmedString,
  QUEUE_ID_PATTERN,
  QUEUE_JOB_ID_PATTERN,
  QUEUE_TIERS,
} from '../src/core/queue/schema.js';

describe('queue shared helpers', () => {
  it('guards plain records, strings, and non-negative numbers consistently', () => {
    expect(isPlainRecord({ a: 1 })).toBe(true);
    expect(isPlainRecord(null)).toBe(false);
    expect(isPlainRecord([])).toBe(false);
    expect(isPlainRecord('text')).toBe(false);

    expect(isNonEmptyString('ok')).toBe(true);
    expect(isNonEmptyString('  ')).toBe(false);
    expect(isNonEmptyString(42)).toBe(false);
    expect(nonEmptyString('  trimmed  ')).toBe('trimmed');
    expect(nonEmptyString('   ')).toBeNull();
    expect(nonEmptyString(undefined)).toBeNull();

    expect(isNonNegativeFinite(0)).toBe(true);
    expect(isNonNegativeFinite(1.5)).toBe(true);
    expect(isNonNegativeFinite(-0.1)).toBe(false);
    expect(isNonNegativeFinite(Number.NaN)).toBe(false);
    expect(isNonNegativeFinite(Number.POSITIVE_INFINITY)).toBe(false);

    expect(isNonNegativeInt(0)).toBe(true);
    expect(isNonNegativeInt(42)).toBe(true);
    expect(isNonNegativeInt(1.5)).toBe(false);
    expect(isNonNegativeInt(-1)).toBe(false);
    expect(isNonNegativeInt(Number.MAX_SAFE_INTEGER + 1)).toBe(false);
  });

  it('validates timestamps, errno codes, ids, regex escaping, and lexical ordering', () => {
    expect(isIsoTimestamp('2026-11-05T14:00:00Z')).toBe(true);
    expect(isIsoTimestamp('2026-11-05')).toBe(false);
    expect(isIsoTimestamp('not-a-date')).toBe(false);

    expect(parseEpochOrIsoMs(1_700_000_000)).toBe(1_700_000_000_000);
    expect(parseEpochOrIsoMs('2026-11-05T14:00:00Z')).toBe(Date.parse('2026-11-05T14:00:00Z'));
    expect(Number.isNaN(parseEpochOrIsoMs(Number.POSITIVE_INFINITY))).toBe(true);
    expect(Number.isNaN(parseEpochOrIsoMs(null))).toBe(true);

    expect(isEnoent(Object.assign(new Error('missing'), { code: 'ENOENT' }))).toBe(true);
    expect(isEnoent(Object.assign(new Error('denied'), { code: 'EACCES' }))).toBe(false);
    expect(isEnoent(null)).toBe(false);

    expect(QUEUE_TIERS).toEqual(['fast', 'mid', 'work', 'frontier']);
    expect(QUEUE_ID_PATTERN.test('RQ-123.a_b')).toBe(true);
    expect(QUEUE_ID_PATTERN.test('-bad')).toBe(false);
    expect(QUEUE_JOB_ID_PATTERN.test('A'.repeat(128))).toBe(true);
    expect(QUEUE_JOB_ID_PATTERN.test('A'.repeat(129))).toBe(false);

    expect(escapeRegExp('a.b+c?(d)[e]')).toBe('a\\.b\\+c\\?\\(d\\)\\[e\\]');
    expect(['b', 'a', 'c'].sort(compareLexical)).toEqual(['a', 'b', 'c']);
  });

  it('resolves jobs.jsonl dialect keys, READY enq lines, and dupcheck flag nouns', () => {
    expect(pickTrimmedString({ job: ' ', job_id: ' RQ-1 ', id: 'RQ-2' }, LEDGER_JOB_KEYS)).toBe('RQ-1');
    expect(pickTrimmedString({ type: 'launch' }, LEDGER_EVENT_KEYS)).toBe('launch');
    expect(pickTrimmedString({ outcome: 'MERGED', state: 'CLOSED' }, LEDGER_PHASE_KEYS)).toBe('CLOSED');
    expect(LEDGER_TS_KEYS[0]).toBe('ts');

    expect(parseReadyLineEnq('- READY RQ-TEST (P1, enq=1700000000): goal')).toEqual({
      id: 'RQ-TEST',
      enqueuedAtMs: 1_700_000_000_000,
    });
    expect(parseReadyLineEnq('- READY RQ-NOENQ (P1): goal')).toEqual({
      id: 'RQ-NOENQ',
      enqueuedAtMs: null,
    });
    expect(parseReadyLineEnq('- CLAIMED RQ-OTHER: goal')).toBeNull();

    expect(flagNouns('Add --json, --apply and --json to phm queue stats (ignore foo--bar)')).toEqual([
      '--json',
      '--apply',
    ]);
  });
});
