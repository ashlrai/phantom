import { afterEach, describe, expect, it, vi } from 'vitest';
import { hasQueueHelpFlag, reportQueueCliError } from '../src/cli/queue.js';
import { flagNouns } from '../src/core/queue/dupcheck.js';
import {
  asQueueRecord, escapeQueueRegExp, isEnoentError, isNonNegativeFinite, isNonNegativeSafeInt,
  isQueueRecord, nonEmptyQueueString, parseReadyQueueLine, QUEUE_BOUNDED_JOB_ID_RE, QUEUE_LEDGER_PHASE_KEYS,
} from '../src/core/queue/schema.js';

describe('queue shared helpers', () => {
  afterEach(() => vi.restoreAllMocks());

  it('guards plain records, strings, and non-negative numbers', () => {
    expect(isQueueRecord({ a: 1 })).toBe(true);
    for (const bad of [null, undefined, [], 'x', 42]) expect(isQueueRecord(bad)).toBe(false);
    expect(asQueueRecord({ a: 1 })).toEqual({ a: 1 });
    expect(asQueueRecord([1])).toEqual({});
    expect(nonEmptyQueueString('  ok  ')).toBe('ok');
    for (const bad of ['', '   ', null, 1]) expect(nonEmptyQueueString(bad)).toBeNull();
    expect([0, 1.5].every(isNonNegativeFinite)).toBe(true);
    expect([-1, NaN, Infinity, '0'].some(isNonNegativeFinite)).toBe(false);
    expect([0, 7].every(isNonNegativeSafeInt)).toBe(true);
    expect([-1, 1.5, Number.MAX_SAFE_INTEGER + 1, '0'].some(isNonNegativeSafeInt)).toBe(false);
  });

  it('detects ENOENT, escapes regexps, validates ids, and parses READY lines and flags', () => {
    expect(isEnoentError({ code: 'ENOENT' })).toBe(true);
    expect(isEnoentError({ code: 'EACCES' })).toBe(false);
    expect(isEnoentError(null)).toBe(false);
    expect(new RegExp(`^${escapeQueueRegExp('a.b+c(d)?[e]$')}$`).test('a.b+c(d)?[e]$')).toBe(true);
    expect(QUEUE_BOUNDED_JOB_ID_RE.test('RQ-TEST_1.2')).toBe(true);
    expect(QUEUE_BOUNDED_JOB_ID_RE.test('../bad')).toBe(false);
    expect(QUEUE_LEDGER_PHASE_KEYS).toEqual(['state', 'outcome', 'status', 'phase', 'result', 'conclusion']);
    expect(parseReadyQueueLine('- READY RQ-1 (P1, enq=1700000000): goal')).toEqual({ id: 'RQ-1', enqMs: 1_700_000_000_000 });
    expect(parseReadyQueueLine('- READY RQ-2 (P1): goal')).toEqual({ id: 'RQ-2', enqMs: null });
    expect(parseReadyQueueLine('- CLAIMED RQ-3 (P1): goal')).toBeNull();
    expect(flagNouns('Add --json and --dry-run (repeat --json) not foo--bar')).toEqual(['--json', '--dry-run']);
  });

  it('handles shared queue CLI help and error formatting', () => {
    expect(hasQueueHelpFlag(['--json', '-h'])).toBe(true);
    expect(hasQueueHelpFlag(['--help'])).toBe(true);
    expect(hasQueueHelpFlag(['--json'])).toBe(false);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(reportQueueCliError('Queue missing.', true, { code: 'queue-missing' }, 2)).toBe(2);
    expect(log).toHaveBeenCalledWith(JSON.stringify({ error: 'Queue missing.', code: 'queue-missing' }));
    expect(reportQueueCliError('Queue missing.', false)).toBe(1);
    expect(err).toHaveBeenCalledWith('Queue missing.');
  });
});
