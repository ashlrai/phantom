import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { nextBacklogItem } from '../src/core/cloud/backlog.js';
import { CLOUD_REPO_PATTERN as STORE_CLOUD_REPO_PATTERN, readCloudJsonFile } from '../src/core/cloud/store.js';
import {
  CLOUD_IMPROVE_MAX_COUNT,
  CLOUD_REPORT_STATUSES,
  CLOUD_REPO_PATTERN,
  CLOUD_SHA1_PATTERN,
  CLOUD_TASK_ORIGINS,
  canonicalCloudPrUrl,
  clipCloudText,
  flattenControlWhitespace,
  isCanonicalCloudPrUrl,
  isCloudRecord,
  isValidIsoTimestamp,
  pad2,
  pluralize,
  roundCents,
  sameCloudRepo,
} from '../src/core/cloud/types.js';

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('cloud shared pure helpers (types.ts)', () => {
  it('shares canonical repo, SHA-1, origin, report-status, and improve-limit constants', () => {
    expect(STORE_CLOUD_REPO_PATTERN).toBe(CLOUD_REPO_PATTERN);
    expect(CLOUD_REPO_PATTERN.test('ashlrai/phantom')).toBe(true);
    expect(CLOUD_REPO_PATTERN.test('not a repo')).toBe(false);
    expect(CLOUD_SHA1_PATTERN.test('a'.repeat(40))).toBe(true);
    expect(CLOUD_SHA1_PATTERN.test('A'.repeat(40))).toBe(false);
    expect(CLOUD_SHA1_PATTERN.test('a'.repeat(39))).toBe(false);
    expect(CLOUD_IMPROVE_MAX_COUNT).toBe(5);
    expect(CLOUD_TASK_ORIGINS).toEqual(['chat', 'operator', 'leader', 'self-improve', 'cli']);
    expect(CLOUD_REPORT_STATUSES).toEqual(['done', 'partial', 'blocked', 'no-change']);
  });

  it('validates plain records and ISO timestamps', () => {
    expect(isCloudRecord({ a: 1 })).toBe(true);
    expect(isCloudRecord(null)).toBe(false);
    expect(isCloudRecord([])).toBe(false);
    expect(isCloudRecord('text')).toBe(false);

    expect(isValidIsoTimestamp('2026-11-26T16:00:00.000Z')).toBe(true);
    expect(isValidIsoTimestamp('not-a-timestamp')).toBe(false);
    expect(isValidIsoTimestamp(12345)).toBe(false);
    expect(isValidIsoTimestamp(null)).toBe(false);
  });

  it('rounds cents, zero-pads digits, compares repos, and formats canonical PR URLs', () => {
    expect(roundCents(1.236)).toBe(1.24);
    expect(roundCents(12.344)).toBe(12.34);
    expect(pad2(0)).toBe('00');
    expect(pad2(7)).toBe('07');
    expect(pad2(12)).toBe('12');

    expect(sameCloudRepo('AshlrAI/Phantom', 'ashlrai/phantom')).toBe(true);
    expect(sameCloudRepo('ashlrai/phantom', 'ashlrai/locus')).toBe(false);

    expect(canonicalCloudPrUrl('ashlrai/phantom', 42)).toBe('https://github.com/ashlrai/phantom/pull/42');
    expect(isCanonicalCloudPrUrl('HTTPS://GitHub.com/AshlrAI/Phantom/pull/42', 'ashlrai/phantom', 42)).toBe(true);
    expect(isCanonicalCloudPrUrl('https://github.com/ashlrai/phantom/pull/43', 'ashlrai/phantom', 42)).toBe(false);
  });

  it('flattens control whitespace, clips text cleanly, and pluralizes counts', () => {
    expect(flattenControlWhitespace('  hello\u0000\n\tworld\u2028!  ')).toBe('hello world !');
    expect(clipCloudText('short', 10)).toBe('short');
    expect(clipCloudText('hello world   ', 8)).toBe('hello w…');
    expect(clipCloudText('hello   world', 7)).toBe('hello…');
    expect(pluralize(1, 'task', 'tasks')).toBe('task');
    expect(pluralize(0, 'task', 'tasks')).toBe('tasks');
    expect(pluralize(2, 'PR is', 'PRs are')).toBe('PRs are');
  });
});

describe('cloud shared store and backlog helpers', () => {
  it('readCloudJsonFile parses bounded regular JSON files and rejects corrupt, oversized, or symlinked files', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cloud-shared-json-'));
    dirs.push(dir);

    const okPath = join(dir, 'ok.json');
    writeFileSync(okPath, JSON.stringify({ hello: 'world' }), { mode: 0o600 });
    expect(readCloudJsonFile(okPath, 1024)).toEqual({ hello: 'world' });

    expect(readCloudJsonFile(join(dir, 'missing.json'), 1024)).toBeUndefined();

    const corruptPath = join(dir, 'corrupt.json');
    writeFileSync(corruptPath, '{bad json', { mode: 0o600 });
    expect(readCloudJsonFile(corruptPath, 1024)).toBeUndefined();

    const bigPath = join(dir, 'big.json');
    writeFileSync(bigPath, JSON.stringify({ data: 'x'.repeat(200) }), { mode: 0o600 });
    expect(readCloudJsonFile(bigPath, 64)).toBeUndefined();

    const linkPath = join(dir, 'link.json');
    symlinkSync(okPath, linkPath);
    expect(readCloudJsonFile(linkPath, 1024)).toBeUndefined();
  });

  it('nextBacklogItem filters by repo case-insensitively and honours exclusions', () => {
    const now = new Date('2026-11-26T16:00:00.000Z');
    const first = nextBacklogItem([], 'ASHLRAI/PHANTOM', now);
    expect(first).not.toBeNull();
    const second = nextBacklogItem([], 'ashlrai/phantom', now, new Set([first!.id]));
    expect(second?.id).not.toBe(first!.id);
  });
});
