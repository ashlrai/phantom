import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { runNodeWatchCommand } from '../src/cli/node-watch.js';
import { isPlainRecord, validNodeJobFilenameId } from '../src/core/drive/nodes/state.js';
import { isFiniteNumber } from '../src/core/drive/nodes/capacity-model.js';
import { readHomeFreeDiskBytes } from '../src/core/drive/nodes/capacity.js';
import { securityPinnedPath as queuegenSecurityPinnedPath } from '../src/core/drive/queuegen.js';
import {
  pruneOldestKeys,
  repoShortName,
  securityPinnedPath as refixSecurityPinnedPath,
} from '../src/core/drive/refix-loop.js';

describe('drive shared helpers', () => {
  it('detects plain records and rejects primitives, null, and arrays', () => {
    expect(isPlainRecord({})).toBe(true);
    expect(isPlainRecord({ a: 1 })).toBe(true);
    expect(isPlainRecord(Object.create(null))).toBe(true);
    expect(isPlainRecord(null)).toBe(false);
    expect(isPlainRecord(undefined)).toBe(false);
    expect(isPlainRecord([])).toBe(false);
    expect(isPlainRecord('str')).toBe(false);
    expect(isPlainRecord(42)).toBe(false);
  });

  it('validates single-component node job filename ids', () => {
    expect(validNodeJobFilenameId('job-123_a.b')).toBe(true);
    expect(validNodeJobFilenameId('A')).toBe(true);
    expect(validNodeJobFilenameId('a'.repeat(120))).toBe(true);
    expect(validNodeJobFilenameId('a'.repeat(121))).toBe(false);
    expect(validNodeJobFilenameId('../escape')).toBe(false);
    expect(validNodeJobFilenameId('sub/dir')).toBe(false);
    expect(validNodeJobFilenameId('-leading-dash')).toBe(false);
    expect(validNodeJobFilenameId('')).toBe(false);
    expect(validNodeJobFilenameId(123)).toBe(false);
  });

  it('checks finite numbers strictly', () => {
    expect(isFiniteNumber(0)).toBe(true);
    expect(isFiniteNumber(-12.5)).toBe(true);
    expect(isFiniteNumber(NaN)).toBe(false);
    expect(isFiniteNumber(Infinity)).toBe(false);
    expect(isFiniteNumber(-Infinity)).toBe(false);
    expect(isFiniteNumber('1')).toBe(false);
    expect(isFiniteNumber(null)).toBe(false);
  });

  it('extracts repo short names and shares one canonical securityPinnedPath', () => {
    expect(repoShortName('ashlrai/phantom')).toBe('phantom');
    expect(repoShortName('phantom')).toBe('phantom');
    expect(repoShortName('org/sub/repo')).toBe('repo');
    expect(queuegenSecurityPinnedPath).toBe(refixSecurityPinnedPath);
    expect(refixSecurityPinnedPath('.github/workflows/ci.yml')).toBe(true);
    expect(refixSecurityPinnedPath('scripts/publish.sh')).toBe(true);
    expect(refixSecurityPinnedPath('src/core/drive/supervisor.ts')).toBe(false);
  });

  it('evicts oldest keys when durable maps exceed cap', () => {
    const map: Record<string, { at: number }> = {
      b: { at: 200 },
      a: { at: 100 },
      d: { at: 400 },
      c: { at: 300 },
    };
    pruneOldestKeys(map, 2, (entry) => entry.at);
    expect(Object.keys(map).sort()).toEqual(['c', 'd']);

    pruneOldestKeys(map, 5, (entry) => entry.at);
    expect(Object.keys(map).sort()).toEqual(['c', 'd']);
  });

  it('reads free disk bytes for an existing directory and returns null when unreadable', () => {
    const dir = mkdtempSync(join(tmpdir(), 'drive-disk-'));
    try {
      const bytes = readHomeFreeDiskBytes(dir);
      expect(typeof bytes).toBe('number');
      expect(bytes!).toBeGreaterThanOrEqual(0);
      expect(readHomeFreeDiskBytes(join(dir, 'does-not-exist'))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('dispatches node watch commands with unified usage error reporting and loop execution', async () => {
    const logs: string[] = [];
    const errors: string[] = [];
    const badJson = await runNodeWatchCommand({
      command: 'beat',
      args: ['--watch', '--every', '999', '--json'],
      stoppedText: 'stopped',
      deps: { log: (l) => logs.push(l), error: (l) => errors.push(l) },
      defaultRun: async () => 0,
    });
    expect(badJson).toBe(2);
    expect(errors).toEqual([]);
    expect(JSON.parse(logs[0]!)).toMatchObject({
      schemaVersion: 1,
      command: 'beat',
      error: { code: 'usage', fix: 'Run: phm node beat --help' },
    });

    const badText = await runNodeWatchCommand({
      command: 'renew',
      args: ['--watch', '--every'],
      stoppedText: 'stopped',
      deps: { log: (l) => logs.push(l), error: (l) => errors.push(l) },
      defaultRun: async () => 0,
    });
    expect(badText).toBe(2);
    expect(errors[0]).toContain('Run: phm node renew --help');

    const ac = new AbortController();
    const seenArgs: string[][] = [];
    const okLogs: string[] = [];
    const code = await runNodeWatchCommand({
      command: 'renew',
      args: ['--watch', '--every', '2', '--job', 'j1'],
      stoppedText: 'stopped cleanly',
      deps: {
        signal: ac.signal,
        log: (l) => okLogs.push(l),
        run: async (a) => {
          seenArgs.push(a);
          ac.abort();
          return 0;
        },
        sleep: async () => undefined,
      },
      defaultRun: async () => 1,
      argsFor: (base) => [...base, '--extra'],
    });
    expect(code).toBe(0);
    expect(seenArgs).toEqual([['--job', 'j1', '--extra']]);
    expect(okLogs).toEqual(['stopped cleanly']);
  });
});
