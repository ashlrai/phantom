import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  escapeRegExp,
  isMissingFileError,
  isQueueRecord,
  nonNegativeFinite,
  nonNegativeSafeInt,
  parseReadyLineEnq,
  pickQueueString,
  trimNonEmpty,
} from '../src/core/queue/schema.js';
import { writeQueueFileAtomic } from '../src/core/queue/store.js';

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe('queue shared helpers', () => {
  it('isQueueRecord accepts plain objects and rejects null, arrays, and primitives', () => {
    expect(isQueueRecord({})).toBe(true);
    expect(isQueueRecord({ a: 1 })).toBe(true);
    expect(isQueueRecord(Object.create(null))).toBe(true);
    expect(isQueueRecord(null)).toBe(false);
    expect(isQueueRecord(undefined)).toBe(false);
    expect(isQueueRecord([])).toBe(false);
    expect(isQueueRecord('text')).toBe(false);
    expect(isQueueRecord(42)).toBe(false);
    expect(isQueueRecord(true)).toBe(false);
  });

  it('trimNonEmpty and pickQueueString trim strings, skip blanks and non-strings, and honour key order', () => {
    expect(trimNonEmpty('  RQ-1  ')).toBe('RQ-1');
    expect(trimNonEmpty('')).toBeNull();
    expect(trimNonEmpty('   \t\n ')).toBeNull();
    expect(trimNonEmpty(123)).toBeNull();
    expect(trimNonEmpty(null)).toBeNull();

    expect(pickQueueString({ job: '  ', job_id: 9, jobId: ' RQ-42 ', id: 'RQ-99' }, ['job', 'job_id', 'jobId', 'id'])).toBe('RQ-42');
    expect(pickQueueString({ job: 'RQ-1', jobId: 'RQ-2' }, ['job', 'jobId'])).toBe('RQ-1');
    expect(pickQueueString({ job: '', other: 'x' }, ['job', 'jobId'])).toBeNull();
  });

  it('nonNegativeFinite and nonNegativeSafeInt enforce finite non-negative and safe integer bounds', () => {
    expect(nonNegativeFinite(0)).toBe(0);
    expect(nonNegativeFinite(3.5)).toBe(3.5);
    expect(nonNegativeFinite(-0.001)).toBeNull();
    expect(nonNegativeFinite(Number.NaN)).toBeNull();
    expect(nonNegativeFinite(Number.POSITIVE_INFINITY)).toBeNull();
    expect(nonNegativeFinite('5')).toBeNull();

    expect(nonNegativeSafeInt(0)).toBe(0);
    expect(nonNegativeSafeInt(12)).toBe(12);
    expect(nonNegativeSafeInt(3.5)).toBeNull();
    expect(nonNegativeSafeInt(-1)).toBeNull();
    expect(nonNegativeSafeInt(Number.MAX_SAFE_INTEGER + 1)).toBeNull();
    expect(nonNegativeSafeInt('12')).toBeNull();
  });

  it('isMissingFileError matches ENOENT errors without throwing on primitives', () => {
    expect(isMissingFileError(Object.assign(new Error('missing'), { code: 'ENOENT' }))).toBe(true);
    expect(isMissingFileError({ code: 'ENOENT' })).toBe(true);
    expect(isMissingFileError({ code: 'EACCES' })).toBe(false);
    expect(isMissingFileError(new Error('other'))).toBe(false);
    expect(isMissingFileError(null)).toBe(false);
    expect(isMissingFileError(undefined)).toBe(false);
    expect(isMissingFileError('ENOENT')).toBe(false);
  });

  it('escapeRegExp neutralizes every regex metacharacter', () => {
    const literal = 'RQ-1.2+a*b?^$()[]{}|\\';
    const re = new RegExp(`^${escapeRegExp(literal)}$`);
    expect(re.test(literal)).toBe(true);
    expect(re.test('RQ-1X2')).toBe(false);
  });

  it('parseReadyLineEnq parses READY job ids and optional enq timestamps', () => {
    expect(parseReadyLineEnq('- READY RQ-TEST-1 (P1, pool=codex, enq=1700000000): goal')).toEqual({
      id: 'RQ-TEST-1',
      enqMs: 1_700_000_000_000,
    });
    expect(parseReadyLineEnq('- READY RQ-TEST-2 (P2, pool=claude): goal')).toEqual({
      id: 'RQ-TEST-2',
      enqMs: null,
    });
    expect(parseReadyLineEnq('- READY RQ-TEST-3 enq=1700000001')).toEqual({
      id: 'RQ-TEST-3',
      enqMs: 1_700_000_001_000,
    });
    expect(parseReadyLineEnq('- CLAIMED 12:00 worker RQ-TEST-4 (enq=1700000000): goal')).toBeNull();
    expect(parseReadyLineEnq('  - READY RQ-INDENTED (P1)')).toBeNull();
    expect(parseReadyLineEnq('- READY')).toBeNull();
  });

  it('writeQueueFileAtomic replaces files atomically with the requested mode and cleans up on error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'queue-shared-helpers-'));
    tempDirs.push(dir);
    const target = join(dir, 'queue.v1.json');

    await writeQueueFileAtomic(target, '{"v":1}\n', 0o600);
    expect(await readFile(target, 'utf8')).toBe('{"v":1}\n');
    expect((await stat(target)).mode & 0o777).toBe(0o600);
    expect(await readdir(dir)).toEqual(['queue.v1.json']);

    await writeQueueFileAtomic(target, '{"v":2}\n', 0o644);
    expect(await readFile(target, 'utf8')).toBe('{"v":2}\n');
    expect((await stat(target)).mode & 0o777).toBe(0o644);
    expect(await readdir(dir)).toEqual(['queue.v1.json']);

    // Writing to a directory path fails on rename and removes the temporary sibling.
    await expect(writeQueueFileAtomic(dir, 'bad\n', 0o600)).rejects.toThrow();
    expect(await readdir(dir)).toEqual(['queue.v1.json']);
  });
});
