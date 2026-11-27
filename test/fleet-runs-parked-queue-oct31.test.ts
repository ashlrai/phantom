import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseParkedState, parsePrecheckSkips, readFleetQueue } from '../src/core/fleet/runs-parked-queue.js';

import { cmdFleetRunsRead } from '../src/cli/fleet-runs-read.js';

const fixture = resolve('test/fixtures/runs-parked-queue');
const now = new Date(2026, 9, 31, 12).getTime();

describe('fleet parked queue', () => {
  it('projects counts, groups and skips without paths', async () => {
    const result = await readFleetQueue({ runsDir: fixture, now: () => now, limit: 2 });
    expect(result).toMatchObject({ v: 1, total: 6, ready: 2, parked: 4, malformed: 1,
      sources: { ready: 'degraded', skips: 'healthy' }, skipsLast24h: 3, unmetDeps: [] });
    expect(result.byLane).toEqual([
      { lane: 'codex-local', ready: 1, parked: 2, phantom: 0, other: 1, otherRepos: [] },
      { lane: 'codex-personal', ready: 1, parked: 2, phantom: 0, other: 1, otherRepos: [] },
    ]);
    expect(result.groups).toEqual([
      { reason: 'MERGERATE', lane: 'codex-personal', count: 2, jobs: ['JOB-MERGE-1', 'JOB-MERGE-2'] },
      { reason: 'INVALID', lane: 'codex-local', count: 1, jobs: ['JOB-INVALID'] },
      { reason: 'SPLIT', lane: 'codex-local', count: 1, jobs: ['JOB-SPLIT'] },
    ]);
    expect(result.skips.map((row) => row.job)).toEqual(['JOB-RECENT-3', 'JOB-RECENT-1']);
    expect(result.skips[0]!.at).toMatch(/^2026-10-31T08:00:00[+-]\d\d:\d\d$/);
    expect(JSON.stringify(result)).not.toContain('/Users/');
    expect(JSON.stringify(result)).not.toContain('prompts/');
  });
  it('reports repeated RESTOCK skips before display limits, keeping reasons and windows separate', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'queue-health-'));
    try {
      await mkdir(join(dir, 'queue'));
      const ready = 'READY\tJOB-STATUS\tcodex-personal\tmid\tphantom\n' +
        'JOB-READY\tphantom\tcodex-personal\tmid\tprompt.md\n' +
        'JOB-PARKED\tphantom\tPARKED-DEP.codex-personal\tmid\tprompt.md\n';
      const skips = [
        '2026-10-31 08:00:00\tRESTOCK\t13\tbusy',
        '2026-10-31 10:00:00\tRESTOCK\t13\tbusy',
        '2026-10-31 09:00:00\tRESTOCK\t13\tbusy',
        '2026-10-31 11:00:00\tRESTOCK\t13\theld',
        '2026-10-31 11:00:00\tRESTOCK\t14\tbusy',
        '2026-10-29 10:00:00\tRESTOCK\t13\tbusy',
        '2026-11-01 10:00:00\tRESTOCK\t13\tbusy',
        'bad time\tRESTOCK\t13\tbusy',
        '2026-10-31 10:00:00\tRESTOCK\t13\t/private/path',
      ].join('\n');
      await writeFile(join(dir, 'queue/ready.tsv'), ready);
      await writeFile(join(dir, 'queue/precheck-skips.tsv'), skips);
      const result = await readFleetQueue({ runsDir: dir, now: () => now, limit: 1 });
      expect(result.skips).toHaveLength(1);
      expect(result.health).toEqual({ schema: 'fleet.queue-health.v1', windowHours: 24,
        counts: { ready: 2, parked: 1, skips: 5, repeatedSkipGroups: 1 },
        repeatedSkips: [{ job: 'RESTOCK', code: '13', reason: 'busy', count: 3,
          lastAt: expect.stringMatching(/^2026-10-31T10:00:00[+-]\d\d:\d\d$/) }] });
      const output = vi.spyOn(console, 'log').mockImplementation(() => {});
      try {
        const unavailable = async (): Promise<never> => { throw new Error('unused'); };
        const deps = { parked: async () => result, runs: unavailable, journal: unavailable };
        expect(await cmdFleetRunsRead('parked', ['--json'], deps)).toBe(0);
        expect(JSON.parse(String(output.mock.calls[0]?.[0])).health).toEqual(result.health);
        output.mockClear();
        expect(await cmdFleetRunsRead('parked', [], deps)).toBe(0);
        expect(output.mock.calls.flat().join('\n')).toContain('RESTOCK: skipped 3 times (13: busy)');
        output.mockClear();
        expect(await cmdFleetRunsRead('parked', ['--json', '--lane', 'codex-personal'], deps)).toBe(0);
        expect(JSON.parse(String(output.mock.calls[0]?.[0])).health.repeatedSkips).toEqual([]);
      } finally { output.mockRestore(); }
      expect(JSON.stringify(result.health)).not.toContain('/private');
      expect(await readFile(join(dir, 'queue/ready.tsv'), 'utf8')).toBe(ready);
      expect(await readFile(join(dir, 'queue/precheck-skips.tsv'), 'utf8')).toBe(skips);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('keeps unavailable queue health unknown and measured empty evidence at zero', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'queue-health-'));
    try {
      expect((await readFleetQueue({ runsDir: dir, now: () => now })).health?.counts)
        .toEqual({ ready: null, parked: null, skips: null, repeatedSkipGroups: null });
      await mkdir(join(dir, 'queue'));
      await writeFile(join(dir, 'queue/ready.tsv'), '');
      await writeFile(join(dir, 'queue/precheck-skips.tsv'), '');
      expect((await readFleetQueue({ runsDir: dir, now: () => now })).health?.counts)
        .toEqual({ ready: 0, parked: 0, skips: 0, repeatedSkipGroups: 0 });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('recognizes states and handles unparseable timestamps and unsafe skip fields', () => {
    expect(parseParkedState('PARKED-BYHAND.codex-local')).toEqual({ parked: true, reason: 'BYHAND', lane: 'codex-local' });
    expect(parseParkedState('READY')).toEqual({ parked: false, reason: null, lane: null });
    const result = parsePrecheckSkips('bad time\tJOB-1\t13\treason\n2026-10-31 08:00:00\tJOB-2\t13\t/Users/example\n', now);
    expect(result).toEqual({ skips: [{ at: 'bad time', job: 'JOB-1', code: '13', reason: 'reason' }], last24h: 0 });
  });
  it('caps and sorts jobs, handles headers, and clamps skip limits', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-queue-'));
    try {
      await mkdir(join(dir, 'queue'));
      const rows = Array.from({ length: 12 }, (_, i) => `PARKED-BYHAND.codex-local\tJOB-${String(11 - i).padStart(2, '0')}\tcodex-local`);
      await writeFile(join(dir, 'queue/ready.tsv'), ['status\tid\tlane', ...rows].join('\n'));
      await writeFile(join(dir, 'queue/precheck-skips.tsv'), Array.from({ length: 205 }, (_, i) => `2026-10-31 08:00:00\tJOB-${i}\t13\treason`).join('\n'));
      const result = await readFleetQueue({ runsDir: dir, now: () => now, limit: 500 });
      expect(result.groups[0]).toEqual({ reason: 'BYHAND', lane: 'codex-local', count: 12, jobs: Array.from({ length: 8 }, (_, i) => `JOB-${String(i).padStart(2, '0')}`) });
      expect(result.skips).toHaveLength(200);
      expect(result.skipsLast24h).toBe(205);
      expect((await readFleetQueue({ runsDir: dir, now: () => now, limit: -5 })).skips).toHaveLength(1);
      expect((await readFleetQueue({ runsDir: dir, now: () => now })).skips).toHaveLength(25);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('reports missing sources and refuses symlinks and oversized ready files', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-queue-'));
    try {
      expect(await readFleetQueue({ runsDir: dir, now: () => now })).toMatchObject({ sources: { ready: 'missing', skips: 'missing' }, total: 0, skips: [], skipsLast24h: 0 });
      await mkdir(join(dir, 'queue'));
      await symlink(join(fixture, 'queue/precheck-skips.tsv'), join(dir, 'queue/precheck-skips.tsv'));
      await writeFile(join(dir, 'queue/ready.tsv'), Buffer.alloc(2 * 1024 * 1024 + 1));
      expect((await readFleetQueue({ runsDir: dir, now: () => now })).sources).toEqual({ ready: 'degraded', skips: 'degraded' });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('reads only complete rows from the bounded tail', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-queue-'));
    try {
      await mkdir(join(dir, 'queue'));
      await writeFile(join(dir, 'queue/precheck-skips.tsv'), `${'x'.repeat(256 * 1024)}\n2026-10-31 08:00:00\tJOB-TAIL\t13\treason\n`);
      const result = await readFleetQueue({ runsDir: dir, now: () => now });
      expect(result.skips.map((row) => row.job)).toEqual(['JOB-TAIL']);
      expect(result.skipsLast24h).toBe(1);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('counts each parked job once at its first parked row', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-queue-'));
    try {
      await mkdir(join(dir, 'queue'));
      await writeFile(join(dir, 'queue/ready.tsv'), [
        'PARKED-DEP.devin\tJOB-DUP\tdevin\twork\tphantom\tprompt.md',
        'PARKED-DEP.devin\tJOB-DUP\tdevin\twork\tphantom\tprompt.md',
        'PARKED-HOLD.devin\tJOB-DUP\tdevin\twork\tphantom\tprompt.md',
        'JOB-LC\tphantom\tPARKED-DEP.devin\twork\tprompt.md',
        'READY\tJOB-READY\tdevin\tmid\tphantom',
      ].join('\n'));
      const result = await readFleetQueue({ runsDir: dir, now: () => now });
      expect(result.ready).toBe(1);
      expect(result.parked).toBe(2);
      expect(result.total).toBe(3);
      expect(result.byLane).toEqual([
        { lane: 'devin', ready: 1, parked: 2, phantom: 1, other: 0, otherRepos: [] },
      ]);
      expect(result.groups).toEqual([
        { reason: 'DEP', lane: 'devin', count: 2, jobs: ['JOB-DUP', 'JOB-LC'] },
      ]);
      expect(result.health?.counts.parked).toBe(2);
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
  it('honors ASHLR_RUNS_DIR when no runsDir is passed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fleet-queue-env-'));
    const previous = process.env.ASHLR_RUNS_DIR;
    try {
      await mkdir(join(dir, 'queue'));
      await writeFile(join(dir, 'queue/ready.tsv'), ['status\tid\tlane', 'PARKED-BYHAND.codex-local\tJOB-ENV\tcodex-local'].join('\n'));
      await writeFile(join(dir, 'queue/precheck-skips.tsv'), '');
      process.env.ASHLR_RUNS_DIR = dir;
      const result = await readFleetQueue({ now: () => now });
      expect(result.sources.ready).toBe('healthy');
      expect(result.groups).toEqual([{ reason: 'BYHAND', lane: 'codex-local', count: 1, jobs: ['JOB-ENV'] }]);
    } finally {
      if (previous === undefined) delete process.env.ASHLR_RUNS_DIR; else process.env.ASHLR_RUNS_DIR = previous;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
