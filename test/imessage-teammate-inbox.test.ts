/**
 * RQ-PHX-TEAMMATETEXTS25: local teammate inbox under <runs>/imessage.
 *
 * Hermetic: runsDir is a tmp dir, handles are placeholders, nothing is sent.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  markTeammateTextsAnswered, readTeammateTexts, recordTeammateText, senderIdFor,
} from '../src/core/comms/imessage-teammate-inbox.js';

const HANDLE = '+15550000002';
const NOW = new Date('2026-11-04T23:46:00Z');
const NOW_MS = NOW.getTime();

let runsDir = '';
const dir = () => join(runsDir, 'imessage');
const file = () => join(dir(), 'teammates.jsonl');
const lines = () => readFileSync(file(), 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Record<string, unknown>);

beforeEach(() => { runsDir = mkdtempSync(join(tmpdir(), 'imsg-team-')); });
afterEach(() => { rmSync(runsDir, { recursive: true, force: true }); });

describe('recordTeammateText', () => {
  it('appends one scrubbed line with a hashed sender id, dir 0700 file 0600', () => {
    expect(recordTeammateText({ rowid: 7, handle: ` ${HANDLE} `, text: 'gate is red' }, runsDir, NOW)).toBe(true);
    expect(lines()).toEqual([{ v: 1, at: NOW.toISOString(), rowid: 7, senderId: senderIdFor(HANDLE), text: 'gate is red' }]);
    expect(statSync(file()).mode & 0o777).toBe(0o600);
    expect(statSync(dir()).mode & 0o777).toBe(0o700);
  });

  it('never stores the raw handle', () => {
    recordTeammateText({ rowid: 1, handle: HANDLE, text: 'hi from a teammate' }, runsDir, NOW);
    const raw = readFileSync(file(), 'utf8');
    expect(raw).not.toContain(HANDLE);
    expect(raw).toContain(senderIdFor(HANDLE));
  });

  it('dedupes on rowid so a retry writes no second line', () => {
    const msg = { rowid: 9, handle: HANDLE, text: 'same text' };
    expect(recordTeammateText(msg, runsDir, NOW)).toBe(true);
    expect(recordTeammateText(msg, runsDir, new Date(NOW_MS + 60_000))).toBe(true);
    expect(lines()).toHaveLength(1);
  });

  it('scrubs a secret-shaped value before storing', () => {
    recordTeammateText({ rowid: 2, handle: HANDLE, text: 'use key sk-test-FAKEFAKEFAKE please' }, runsDir, NOW);
    const stored = readFileSync(file(), 'utf8');
    expect(stored).not.toContain('sk-test-FAKEFAKEFAKE');
    expect(stored).toContain('[REDACTED]');
  });

  it('caps stored text at 2000 chars', () => {
    recordTeammateText({ rowid: 3, handle: HANDLE, text: 'x'.repeat(3_000) }, runsDir, NOW);
    expect((lines()[0]!.text as string).length).toBe(2_000);
  });

  it('returns false on a bad record instead of throwing', () => {
    expect(recordTeammateText({ rowid: 0, handle: HANDLE, text: 'x' }, runsDir, NOW)).toBe(false);
    expect(recordTeammateText({ rowid: 4, handle: ' ', text: 'x' }, runsDir, NOW)).toBe(false);
    expect(recordTeammateText({ rowid: 5, handle: HANDLE, text: 5 as unknown as string }, runsDir, NOW)).toBe(false);
  });
});

describe('readTeammateTexts', () => {
  it('is missing without a file and healthy with good lines, newest last', () => {
    expect(readTeammateTexts({ runsDir })).toEqual({ sourceState: 'missing', texts: [] });
    recordTeammateText({ rowid: 2, handle: HANDLE, text: 'second' }, runsDir, new Date(NOW_MS - 5 * 60_000));
    recordTeammateText({ rowid: 1, handle: HANDLE, text: 'first' }, runsDir, new Date(NOW_MS - 30 * 60_000));
    const got = readTeammateTexts({ runsDir, now: () => NOW_MS });
    expect(got.sourceState).toBe('healthy');
    expect(got.texts.map((t) => t.rowid)).toEqual([1, 2]);
    expect(got.texts[0]).toMatchObject({ senderId: senderIdFor(HANDLE), text: 'first', ageMinutes: 30 });
    expect(got.texts[1]!.ageMinutes).toBe(5);
  });

  it('skips malformed lines and reports degraded', () => {
    recordTeammateText({ rowid: 1, handle: HANDLE, text: 'fine' }, runsDir, NOW);
    appendFileSync(file(), 'this is not json\n{"v":1,"rowid":"oops"}\n');
    const got = readTeammateTexts({ runsDir, now: () => NOW_MS });
    expect(got.sourceState).toBe('degraded');
    expect(got.texts.map((t) => t.rowid)).toEqual([1]);
  });

  it('filters by sinceMs against now', () => {
    recordTeammateText({ rowid: 1, handle: HANDLE, text: 'old' }, runsDir, new Date(NOW_MS - 30 * 60_000));
    recordTeammateText({ rowid: 2, handle: HANDLE, text: 'new' }, runsDir, new Date(NOW_MS - 2 * 60_000));
    const got = readTeammateTexts({ runsDir, sinceMs: 10 * 60_000, now: () => NOW_MS });
    expect(got.texts.map((t) => t.rowid)).toEqual([2]);
  });
});

describe('markTeammateTextsAnswered', () => {
  it('hides answered rowids unless includeAnswered is set', () => {
    recordTeammateText({ rowid: 1, handle: HANDLE, text: 'one' }, runsDir, NOW);
    recordTeammateText({ rowid: 2, handle: HANDLE, text: 'two' }, runsDir, NOW);
    expect(markTeammateTextsAnswered([1], runsDir, NOW)).toBe(1);
    expect(readTeammateTexts({ runsDir, now: () => NOW_MS }).texts.map((t) => t.rowid)).toEqual([2]);
    expect(readTeammateTexts({ runsDir, includeAnswered: true, now: () => NOW_MS }).texts.map((t) => t.rowid)).toEqual([1, 2]);
  });

  it('counts only recorded, still-unanswered rowids', () => {
    recordTeammateText({ rowid: 1, handle: HANDLE, text: 'one' }, runsDir, NOW);
    expect(markTeammateTextsAnswered([1, 999, -3], runsDir, NOW)).toBe(1);
    expect(markTeammateTextsAnswered([1], runsDir, NOW)).toBe(0);
    expect(lines()).toHaveLength(2);
  });

  it('creates the file with private modes on an empty inbox', () => {
    mkdirSync(dir());
    writeFileSync(file(), '');
    expect(markTeammateTextsAnswered([], runsDir, NOW)).toBe(0);
    recordTeammateText({ rowid: 8, handle: HANDLE, text: 'x' }, runsDir, NOW);
    expect(markTeammateTextsAnswered([8], runsDir, NOW)).toBe(1);
    expect(statSync(file()).mode & 0o777).toBe(0o600);
  });
});
