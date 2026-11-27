import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { cleanDevinTurnText } from '../src/core/devin/chat-runner.js';
import { readDevinJsonFile } from '../src/core/devin/store.js';
import {
  DEVIN_GITHUB_PR_URL_PATTERN,
  formatDevinAcu,
  isDevinRecord,
  isValidDevinAcu,
  redactDevinKeys,
  roundDevinAcu,
} from '../src/core/devin/types.js';
import { FAKE_KEY } from './helpers/fake-devin.js';

describe('devin shared helpers', () => {
  it('guards plain records while rejecting null, primitives, and arrays', () => {
    expect(isDevinRecord({})).toBe(true);
    expect(isDevinRecord({ a: 1 })).toBe(true);
    expect(isDevinRecord(null)).toBe(false);
    expect(isDevinRecord(undefined)).toBe(false);
    expect(isDevinRecord([])).toBe(false);
    expect(isDevinRecord('text')).toBe(false);
    expect(isDevinRecord(42)).toBe(false);
  });

  it('validates, rounds, and formats ACU values fail-closed', () => {
    expect(isValidDevinAcu(0)).toBe(true);
    expect(isValidDevinAcu(3.25)).toBe(true);
    expect(isValidDevinAcu(-0.1)).toBe(false);
    expect(isValidDevinAcu(Number.NaN)).toBe(false);
    expect(isValidDevinAcu(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isValidDevinAcu('3')).toBe(false);
    expect(isValidDevinAcu(null)).toBe(false);

    expect(roundDevinAcu(1.236)).toBe(1.24);
    expect(formatDevinAcu(1)).toBe('1 ACU');
    expect(formatDevinAcu(1.004)).toBe('1 ACU');
    expect(formatDevinAcu(0)).toBe('0 ACUs');
    expect(formatDevinAcu(2.345)).toBe('2.35 ACUs');
  });

  it('redacts Devin key tokens and bounds turn text consistently', () => {
    expect(redactDevinKeys(`token=${FAKE_KEY} ok`)).toBe('token=[REDACTED] ok');
    expect(redactDevinKeys(`token=${FAKE_KEY} ok`, '')).toBe('token= ok');
    expect(cleanDevinTurnText(`key ${FAKE_KEY}`)).toBe('key [REDACTED]');
    expect(cleanDevinTurnText('abcdef', 5)).toBe('abcd…');
  });

  it('matches canonical GitHub PR URLs only', () => {
    expect(DEVIN_GITHUB_PR_URL_PATTERN.test('https://github.com/ashlrai/phantom/pull/42')).toBe(true);
    expect(DEVIN_GITHUB_PR_URL_PATTERN.test('https://github.com/ashlrai/phantom/issues/42')).toBe(false);
    expect(DEVIN_GITHUB_PR_URL_PATTERN.test('http://github.com/ashlrai/phantom/pull/42')).toBe(false);
    expect(DEVIN_GITHUB_PR_URL_PATTERN.test('https://github.com/ashlrai/phantom/pull/42/files')).toBe(false);
  });

  it('reads private capped JSON files and returns undefined on missing, corrupt, or oversized input', () => {
    const dir = mkdtempSync(join(tmpdir(), 'devin-json-helper-'));
    try {
      const valid = join(dir, 'ok.json');
      writeFileSync(valid, JSON.stringify({ v: 1, ok: true }), { mode: 0o600 });
      expect(readDevinJsonFile(valid, 1024)).toEqual({ v: 1, ok: true });
      expect(readDevinJsonFile(valid, 5)).toBeUndefined();

      const broken = join(dir, 'broken.json');
      writeFileSync(broken, '{not json', { mode: 0o600 });
      expect(readDevinJsonFile(broken, 1024)).toBeUndefined();

      expect(readDevinJsonFile(join(dir, 'missing.json'), 1024)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
