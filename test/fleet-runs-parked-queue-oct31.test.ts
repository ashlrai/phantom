import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseParkedState, parsePrecheckSkips, readFleetQueue } from '../src/core/fleet/runs-parked-queue.js';

const fixture = resolve('test/fixtures/runs-parked-queue');
const now = new Date(2026, 9, 31, 12).getTime();

describe('fleet parked queue', () => {
  it('projects counts, groups and skips without paths', async () => {
    const result = await readFleetQueue({ runsDir: fixture, now: () => now, limit: 2 });
    expect(result).toMatchObject({ v: 1, total: 6, ready: 2, parked: 4, malformed: 1,
      sources: { ready: 'degraded', skips: 'healthy' }, skipsLast24h: 3 });
    expect(result.byLane).toEqual([{ lane: 'codex-local', ready: 1, parked: 2 }, { lane: 'codex-personal', ready: 1, parked: 2 }]);
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
});
