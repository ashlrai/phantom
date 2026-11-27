import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { parseJobLedger as cliParseJobLedger } from '../src/cli/disk.js';
import {
  probeFreeBytes, readJobsLedgerSource, readKeptWorktreesSafe, TEMP_WORKTREE_PATTERN,
} from '../src/core/disk-maint/plan.js';
import { isInsideRoot, realPathOrNull } from '../src/core/disk-maint/protect.js';
import { bytesToGb, round1 } from '../src/core/disk-maint/removal-plan.js';
import { hardenedGitEnv, sanitizedGitProcessEnv } from '../src/core/disk-maint/worktree-evidence.js';
import { isPlainRecord, parseJobLedger } from '../src/core/disk-maint/worktrees.js';

const temps: string[] = [];
const makeTemp = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'phm-disk-maint-helpers-'));
  temps.push(dir);
  return dir;
};

afterEach(() => {
  while (temps.length) rmSync(temps.pop()!, { recursive: true, force: true });
});

describe('disk-maint shared helpers', () => {
  it('rounds numbers and converts decimal bytes to GB consistently', () => {
    expect(round1(1.24)).toBe(1.2);
    expect(round1(1.25)).toBe(1.3);
    expect(bytesToGb(0)).toBe(0);
    expect(bytesToGb(49_999_999)).toBe(0);
    expect(bytesToGb(50_000_000)).toBe(0.1);
    expect(bytesToGb(123_450_000_000)).toBe(123.5);
  });

  it('checks root containment without sibling-prefix false positives', () => {
    expect(isInsideRoot('/tmp/wt', '/tmp/wt')).toBe(true);
    expect(isInsideRoot('/tmp/wt', '/tmp/wt/RQ-1')).toBe(true);
    expect(isInsideRoot('/tmp/wt', '/tmp/wt/RQ-1/nested')).toBe(true);
    expect(isInsideRoot('/tmp/wt', '/tmp/wt-other')).toBe(false);
    expect(isInsideRoot('/tmp/wt', '/tmp')).toBe(false);
    expect(isInsideRoot('/', '/tmp/wt')).toBe(true);
  });

  it('resolves physical paths and returns null for missing paths', () => {
    const dir = makeTemp();
    const target = join(dir, 'target.txt');
    const link = join(dir, 'link.txt');
    writeFileSync(target, 'ok');
    symlinkSync(target, link);

    expect(realPathOrNull(link)).toBe(realpathSync.native(target));
    expect(realPathOrNull(join(dir, 'missing.txt'))).toBeNull();
  });

  it('strips inherited GIT_* variables and applies hardened git defaults', () => {
    const base = {
      PATH: '/usr/bin',
      HOME: '/tmp/home',
      GIT_DIR: '/evil/.git',
      GIT_WORK_TREE: '/evil',
      GIT_CONFIG_PARAMETERS: "'core.sshCommand=evil'",
    };

    const stripped = sanitizedGitProcessEnv(base);
    expect(stripped['PATH']).toBe('/usr/bin');
    expect(stripped['HOME']).toBe('/tmp/home');
    expect(Object.keys(stripped).some(key => key.startsWith('GIT_'))).toBe(false);

    const hardened = hardenedGitEnv(base);
    expect(hardened['PATH']).toBe('/usr/bin');
    expect(hardened['GIT_DIR']).toBeUndefined();
    expect(hardened['GIT_WORK_TREE']).toBeUndefined();
    expect(hardened['GIT_TERMINAL_PROMPT']).toBe('0');
    expect(hardened['GIT_NO_LAZY_FETCH']).toBe('1');
    expect(hardened['GIT_NO_REPLACE_OBJECTS']).toBe('1');
  });

  it('validates plain JSON records and exposes parseJobLedger from core and cli', () => {
    expect(isPlainRecord({})).toBe(true);
    expect(isPlainRecord({ job: 'RQ-1' })).toBe(true);
    expect(isPlainRecord(null)).toBe(false);
    expect(isPlainRecord([])).toBe(false);
    expect(isPlainRecord('text')).toBe(false);
    expect(isPlainRecord(42)).toBe(false);

    expect(cliParseJobLedger).toBe(parseJobLedger);
    const finishTs = '2026-10-01T00:00:00Z';
    const ledger = parseJobLedger([
      'not-json',
      '["array-row"]',
      JSON.stringify({ job: 'RQ-1', event: 'finish', ts: finishTs, empty: false }),
      JSON.stringify({ job: 'RQ-1', event: 'outcome', state: 'MERGED', ts: '2026-10-01T00:05:00Z' }),
      JSON.stringify({ job: 'RQ-2', event: 'outcome', state: 'MERGED', ts: finishTs }),
      JSON.stringify({ job: 'RQ-2', event: 'launch', ts: '2026-10-01T00:05:00Z' }),
    ].join('\n'));
    expect(ledger.get('RQ-1')).toEqual({ state: 'merged', finishMs: Date.parse(finishTs), finishEmpty: false });
    expect(ledger.has('RQ-2')).toBe(false);
  });

  it('probes free bytes fail-closed and never turns errors into 0', async () => {
    expect(await probeFreeBytes('/tmp', () => 0)).toBe(0);
    expect(await probeFreeBytes('/tmp', async () => 42_000_000_000)).toBe(42_000_000_000);
    expect(await probeFreeBytes('/tmp', () => -1)).toBeNull();
    expect(await probeFreeBytes('/tmp', () => Number.NaN)).toBeNull();
    expect(await probeFreeBytes('/tmp', () => Number.POSITIVE_INFINITY)).toBeNull();
    expect(await probeFreeBytes('/tmp', () => null)).toBeNull();
    expect(await probeFreeBytes('/tmp', () => { throw new Error('EACCES'); })).toBeNull();
  });

  it('reads jobs ledger and kept-worktree pins fail-closed on errors', async () => {
    const dir = makeTemp();
    expect(await readJobsLedgerSource(dir, () => ({ state: 'healthy', text: '{}' }))).toEqual({
      state: 'healthy',
      text: '{}',
    });
    expect(await readJobsLedgerSource(dir, () => { throw new Error('EIO'); })).toEqual({
      state: 'degraded',
      text: '',
    });

    expect(await readKeptWorktreesSafe(() => ({ paths: ['/tmp/wt/RQ-1'], valid: true }))).toEqual({
      paths: ['/tmp/wt/RQ-1'],
      valid: true,
    });
    expect(await readKeptWorktreesSafe(() => { throw new Error('EACCES'); })).toEqual({
      paths: [],
      valid: false,
    });

    expect(TEMP_WORKTREE_PATTERN.test('vwt-deadbeef')).toBe(true);
    expect(TEMP_WORKTREE_PATTERN.test('RQ-123')).toBe(false);
  });
});
