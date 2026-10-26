import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  daemonActivityDirectory,
  daemonActivityPath,
  readDaemonActivity,
  selectCompactedDaemonActivityRows,
  writeDaemonActivity,
  type DaemonActivityPhase,
  type DaemonActivityRowV1,
} from '../src/core/daemon/activity.js';
import {
  closeLocalWorkObservation,
  startLocalWorkObservation,
} from '../src/core/daemon/local-work-observation.js';

const MAX_ROWS = 5_000;
const instanceId = '123e4567-e89b-42d3-a456-426614174000';
const previousInstanceId = '223e4567-e89b-42d3-a456-426614174000';
const daemonStartedAt = '2026-10-16T00:00:00.000Z';
const dayStart = Date.parse(daemonStartedAt);

function row(index: number, phase: DaemonActivityPhase, id = instanceId): DaemonActivityRowV1 {
  return {
    schemaVersion: 1,
    observedAt: new Date(dayStart + index * 1_000).toISOString(),
    authority: 'none',
    instanceId: id,
    pid: process.pid,
    processStartRef: null,
    daemonStartedAt,
    phase,
    activeChildren: null,
  };
}

/** Seed a full partition directly; per-row appends would make the test slow. */
function seedPartition(rows: DaemonActivityRowV1[]): string {
  mkdirSync(daemonActivityDirectory(), { recursive: true, mode: 0o700 });
  const path = daemonActivityPath('2026-10-16');
  writeFileSync(path, rows.map((value) => `${JSON.stringify(value)}\n`).join(''), { mode: 0o600 });
  return path;
}

function fullDay(): DaemonActivityRowV1[] {
  const rows: DaemonActivityRowV1[] = [row(0, 'starting', previousInstanceId), row(1, 'stopping', previousInstanceId), row(2, 'starting')];
  while (rows.length < MAX_ROWS) rows.push(row(rows.length, rows.length % 2 === 0 ? 'tick' : 'idle'));
  return rows;
}

function journalLines(path: string): DaemonActivityRowV1[] {
  return readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line) as DaemonActivityRowV1);
}

describe('daemon activity — partition compaction at the row cap', () => {
  let home: string;
  let previousAshlrHome: string | undefined;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'ashlr-daemon-activity-compaction-'));
    previousAshlrHome = process.env['ASHLR_HOME'];
    process.env['ASHLR_HOME'] = join(home, '.ashlr');
  });

  afterEach(() => {
    closeLocalWorkObservation();
    if (previousAshlrHome === undefined) delete process.env['ASHLR_HOME'];
    else process.env['ASHLR_HOME'] = previousAshlrHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('keeps accepting writes past the cap and stays fresh', () => {
    const seeded = fullDay();
    const path = seedPartition(seeded);
    const beforeInode = lstatSync(path).ino;
    let t = dayStart + MAX_ROWS * 1_000;
    for (let i = 0; i < 5; i++) {
      t += 5_000;
      expect(writeDaemonActivity({ instanceId, daemonStartedAt, phase: 'tick', now: new Date(t) })).toBe(true);
    }
    const read = readDaemonActivity({ nowMs: t + 1_000 });
    expect(read).toMatchObject({ sourceState: 'healthy', freshness: 'fresh', ageMs: 1_000 });
    expect(read.activity?.observedAt).toBe(new Date(t).toISOString());
    // The latest five appends are one contiguous tick run; phase start survives.
    expect(read.phaseStartedAt).toBe(new Date(t - 4 * 5_000).toISOString());

    const rows = journalLines(path);
    expect(lstatSync(path).ino).not.toBe(beforeInode);
    expect(rows.length).toBeLessThanOrEqual(MAX_ROWS / 2 + 10);
    expect(rows.length).toBeGreaterThan(MAX_ROWS / 4);
    // Lifecycle rows of earlier and current instances are retained.
    expect(rows.filter((value) => value.phase === 'starting').map((value) => value.instanceId).sort())
      .toEqual([instanceId, previousInstanceId].sort());
    expect(rows.some((value) => value.phase === 'stopping' && value.instanceId === previousInstanceId)).toBe(true);
    for (let i = 1; i < rows.length; i++) expect(rows[i]!.observedAt >= rows[i - 1]!.observedAt).toBe(true);
    if (process.platform !== 'win32') expect(lstatSync(path).mode & 0o777).toBe(0o600);
  });

  it('preserves phaseStartedAt when the current phase run predates the retained window', () => {
    const rows: DaemonActivityRowV1[] = [row(0, 'starting')];
    while (rows.length < MAX_ROWS) rows.push(row(rows.length, 'idle'));
    const kept = selectCompactedDaemonActivityRows(rows);
    expect(kept[0]).toEqual(rows[0]);
    expect(kept[1]).toEqual(rows[1]);
    expect(kept.at(-1)).toEqual(rows.at(-1));

    const path = seedPartition(rows);
    const t = dayStart + MAX_ROWS * 1_000;
    expect(writeDaemonActivity({ instanceId, daemonStartedAt, phase: 'idle', now: new Date(t) })).toBe(true);
    expect(journalLines(path).length).toBeLessThan(MAX_ROWS);
    expect(readDaemonActivity({ nowMs: t }).phaseStartedAt).toBe(rows[1]!.observedAt);
  });

  it('lets a same-day restart resolve the owner observer after compaction', async () => {
    // Real clock: seed today's partition with rows spread between midnight and now.
    const nowMs = Date.now();
    const midnight = Date.parse(`${new Date(nowMs).toISOString().slice(0, 10)}T00:00:00.000Z`);
    const todayStartedAt = new Date(midnight).toISOString();
    const rows = fullDay().map((value, index) => ({
      ...value,
      daemonStartedAt: todayStartedAt,
      observedAt: new Date(midnight + Math.floor((index * (nowMs - midnight)) / (MAX_ROWS + 1))).toISOString(),
    }));
    mkdirSync(daemonActivityDirectory(), { recursive: true, mode: 0o700 });
    const path = daemonActivityPath();
    writeFileSync(path, rows.map((value) => `${JSON.stringify(value)}\n`).join(''), { mode: 0o600 });
    expect(writeDaemonActivity({ instanceId, daemonStartedAt: todayStartedAt, phase: 'starting' })).toBe(true);
    expect(journalLines(path).length).toBeLessThan(MAX_ROWS);
    const read = readDaemonActivity();
    expect(read).toMatchObject({ sourceState: 'healthy', freshness: 'fresh' });
    expect(read.activity).toMatchObject({ pid: process.pid, phase: 'starting' });
    // A restricted host cannot prove process identity; no observation is invented.
    if (read.ownerState !== 'alive') return;
    startLocalWorkObservation();
    const file = join(daemonActivityDirectory(), 'local-work.json');
    await vi.waitFor(() => expect(JSON.parse(readFileSync(file, 'utf8'))).toMatchObject({
      instanceId, pid: process.pid, localRuns: 0,
    }));
  });

  it('rewrites crash-safely: partial temporaries are invisible to readers and cleaned up', () => {
    const path = seedPartition(fullDay());
    const partial = join(daemonActivityDirectory(), '.activity-compact-00000000-crash.tmp');
    writeFileSync(partial, '{"schemaVersion":1,"observedAt":"20', { mode: 0o600 });
    const t = dayStart + MAX_ROWS * 1_000;
    expect(readDaemonActivity({ nowMs: t }).sourceState).toBe('healthy');

    expect(writeDaemonActivity({ instanceId, daemonStartedAt, phase: 'idle', now: new Date(t) })).toBe(true);
    expect(existsSync(partial)).toBe(false);
    const leftovers = readdirSync(daemonActivityDirectory()).filter((name) => name.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
    const raw = readFileSync(path, 'utf8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(journalLines(path).at(-1)?.observedAt).toBe(new Date(t).toISOString());
    expect(readDaemonActivity({ nowMs: t })).toMatchObject({ sourceState: 'healthy', freshness: 'fresh' });
  });

  it('refuses to compact a partition it cannot parse', () => {
    const path = seedPartition(fullDay());
    writeFileSync(path, `${readFileSync(path, 'utf8')}not-json\n`, { mode: 0o600 });
    const before = readFileSync(path, 'utf8');
    expect(writeDaemonActivity({
      instanceId, daemonStartedAt, phase: 'idle', now: new Date(dayStart + MAX_ROWS * 1_000),
    })).toBe(false);
    expect(readFileSync(path, 'utf8')).toBe(before);
  });
});
