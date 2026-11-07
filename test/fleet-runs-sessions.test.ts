/**
 * fleet-runs-sessions tests — hermetic coverage of readFleetSessions() in
 * src/core/fleet/runs-sessions.ts, the read-only dispatcher session projection
 * behind the TUI Sessions tab.
 *
 * Fixtures are built in mkdtemp dirs (never the real ~/.ashlr-runs); the
 * reader's `runsDir` + `now` seams keep every assertion deterministic. Every
 * marker mtime is pinned with utimes() relative to the fixed NOW so lifecycle
 * and freshness math never depends on the wall clock.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, readdir, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFleetSessions } from '../src/core/fleet/runs-sessions.js';
import type { FleetSession } from '../src/core/fleet/runs-sessions.js';

const NOW = Date.parse('2026-10-31T12:00:00.000Z');
const HOUR = 3_600_000;
const dirs: string[] = [];

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});

async function runsRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'fleet-sessions-'));
  dirs.push(dir);
  return dir;
}

const read = (runsDir: string) => readFleetSessions({ runsDir, now: () => NOW });
const byJob = (sessions: FleetSession[], job: string) => sessions.find((s) => s.job === job);

async function write(root: string, rel: string, content: string): Promise<string> {
  const path = join(root, rel);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content);
  return path;
}

/** Set an absolute mtime (ms epoch) on a path. */
async function mtime(path: string, ms: number): Promise<void> {
  const d = new Date(ms);
  await utimes(path, d, d);
}

/** A standard .line claim record: job \t repo \t lane \t tier \t prompt-path. */
function lineRecord(job: string, repo = 'phantom', lane = 'codex-personal', tier = 'work', prompt = `/prompts/${job}.md`): string {
  return `${job}\t${repo}\t${lane}\t${tier}\t${prompt}\n`;
}

interface ClaimOpts {
  line?: string | null;               // .line content; undefined → standard record, null → empty file
  lineMtimeMs?: number;               // default NOW - 1h (deterministic claim time)
  dispatched?: boolean;               // write .dispatched (default: absent)
  dispatchedEpochSec?: number;        // .dispatched content; default ≈ its mtime
  dispatchedContent?: string;         // raw .dispatched content override
  dispatchedMtimeMs?: number;         // default = line mtime
  rc?: string | null;                 // .rc content; undefined → absent
  rcMtimeMs?: number;
  timeout?: boolean;
  timeoutMtimeMs?: number;
  fin?: boolean;
  finMtimeMs?: number;
  reaping?: boolean;                  // directory marker, like dispatchd's os.mkdir
  reapingMtimeMs?: number;
  keptlogged?: boolean;
}

/** Write a claimed job's markers under queue/run with pinned mtimes. */
async function claim(root: string, job: string, opts: ClaimOpts = {}): Promise<void> {
  const run = join(root, 'queue', 'run');
  await mkdir(run, { recursive: true });
  const lineMtime = opts.lineMtimeMs ?? NOW - HOUR;
  const linePath = await write(root, `queue/run/${job}.line`, opts.line === undefined ? lineRecord(job) : (opts.line ?? ''));
  await mtime(linePath, lineMtime);

  if (opts.dispatched) {
    const dMtime = opts.dispatchedMtimeMs ?? lineMtime;
    const content = opts.dispatchedContent
      ?? `${opts.dispatchedEpochSec ?? Math.floor(dMtime / 1000)}\n`;
    const p = await write(root, `queue/run/${job}.dispatched`, content);
    await mtime(p, dMtime);
  }
  if (opts.rc !== undefined && opts.rc !== null) {
    const p = await write(root, `queue/run/${job}.rc`, opts.rc);
    if (opts.rcMtimeMs !== undefined) await mtime(p, opts.rcMtimeMs);
  }
  if (opts.timeout) {
    const p = await write(root, `queue/run/${job}.timeout`, '');
    if (opts.timeoutMtimeMs !== undefined) await mtime(p, opts.timeoutMtimeMs);
  }
  if (opts.fin) {
    const p = await write(root, `queue/run/${job}.fin`, '1\n');
    if (opts.finMtimeMs !== undefined) await mtime(p, opts.finMtimeMs);
  }
  if (opts.reaping) {
    const p = join(run, `${job}.reaping`);
    await mkdir(p, { recursive: true });
    if (opts.reapingMtimeMs !== undefined) await mtime(p, opts.reapingMtimeMs);
  }
  if (opts.keptlogged) await write(root, `queue/run/${job}.keptlogged`, '');
}

async function statusJson(root: string, body: unknown): Promise<void> {
  await write(root, 'queue/status.json', typeof body === 'string' ? body : JSON.stringify(body));
}

// ---------------------------------------------------------------------------
// Missing / degraded sources
// ---------------------------------------------------------------------------

describe('readFleetSessions — absent state', () => {
  it('reports missing for a nonexistent runs dir', async () => {
    const root = await runsRoot();
    const v = await read(join(root, 'absent'));
    expect(v.v).toBe(1);
    expect(v.runsDirPresent).toBe(false);
    expect(v.sourceState).toBe('missing');
    expect(v.sources).toEqual({ status: 'missing', runs: 'missing' });
    expect(v.sessions).toEqual([]);
    expect(v.lanes).toEqual([]);
    expect(v.lastTick).toBeNull();
    expect(v.paused).toBeNull();
    expect(v.queueDepth).toBeNull();
    expect(v.truncated).toBe(false);
  });

  it('reports missing when the root exists but queue/ does not', async () => {
    const root = await runsRoot();
    const v = await read(root);
    expect(v.runsDirPresent).toBe(true);
    expect(v.sourceState).toBe('missing');
    expect(v.sources).toEqual({ status: 'missing', runs: 'missing' });
    expect(v.sessions).toEqual([]);
  });

  it('degrades when status.json is healthy but queue/run is absent', async () => {
    const root = await runsRoot();
    await statusJson(root, {
      schema: 'dispatchd.status.v1', last_tick: '2026-10-31T11:59:00Z',
      paused: false, queue_depth: 4,
      lanes: { 'codex-personal': { running: 1, target: 2, queued: 4, held: false } },
    });
    const v = await read(root);
    expect(v.sources.status).toBe('healthy');
    expect(v.sources.runs).toBe('missing');
    expect(v.sourceState).toBe('degraded');
    expect(v.queueDepth).toBe(4);
    expect(v.lanes).toEqual([{ lane: 'codex-personal', running: 1, target: 2, queued: 4, held: false }]);
    expect(v.sessions).toEqual([]);
  });

  it('isolates a corrupt status.json from the session scan', async () => {
    const root = await runsRoot();
    await statusJson(root, '{not json');
    await claim(root, 'RQ-OK-1', { dispatched: true, dispatchedMtimeMs: NOW - HOUR });
    const v = await read(root);
    expect(v.sources.status).toBe('degraded');
    expect(v.sources.runs).toBe('healthy');
    expect(v.sourceState).toBe('degraded');
    expect(v.lastTick).toBeNull();
    expect(byJob(v.sessions, 'RQ-OK-1')?.status).toBe('running');
  });

  it('treats an oversized status.json as degraded', async () => {
    const root = await runsRoot();
    await statusJson(root, ' '.repeat(256 * 1024 + 1));
    const v = await read(root);
    expect(v.sources.status).toBe('degraded');
    expect(v.sourceState).toBe('degraded');
  });
});

// ---------------------------------------------------------------------------
// status.json projection
// ---------------------------------------------------------------------------

describe('readFleetSessions — status.json projection', () => {
  it('projects last_tick, paused, queue_depth and lanes', async () => {
    const root = await runsRoot();
    await statusJson(root, {
      schema: 'dispatchd.status.v1',
      last_tick: '2026-10-31T11:59:30Z',
      paused: 'operator hold',
      queue_depth: 7,
      lanes: {
        'codex-personal': { running: 2, target: 4, queued: 5, held: true },
        'devin': { running: 0, target: 2, queued: 0, held: false },
        'not a lane!': { running: 9, target: 9, queued: 9, held: false },
      },
    });
    await claim(root, 'RQ-X-1');
    const v = await read(root);
    expect(v.sources.status).toBe('healthy');
    expect(v.lastTick).toBe('2026-10-31T11:59:30Z');
    expect(v.paused).toBe(true);           // non-empty string pause = paused
    expect(v.queueDepth).toBe(7);
    expect(v.lanes).toEqual([
      { lane: 'codex-personal', running: 2, target: 4, queued: 5, held: true },
      { lane: 'devin', running: 0, target: 2, queued: 0, held: false },
    ]);
    expect(v.sourceState).toBe('healthy');
  });

  it('keeps malformed lane entries and bad timestamps unavailable', async () => {
    const root = await runsRoot();
    await statusJson(root, {
      schema: 'dispatchd.status.v1',
      last_tick: 'not-a-timestamp',
      paused: 42,
      queue_depth: 'many',
      lanes: {
        'codex-personal': { running: 'x', target: 2, queued: 0, held: false },
        'devin': { running: 1, target: 2, queued: 3 },              // held missing
      },
    });
    const v = await read(root);
    expect(v.lastTick).toBeNull();
    expect(v.paused).toBeNull();
    expect(v.queueDepth).toBeNull();
    expect(v.lanes).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Marker-derived session statuses
// ---------------------------------------------------------------------------

describe('readFleetSessions — lifecycle statuses', () => {
  it('derives every marker status', async () => {
    const root = await runsRoot();
    const t = NOW - 10 * 60_000;

    await claim(root, 'RQ-LAUNCH', { dispatched: true, dispatchedMtimeMs: NOW - 30_000 });
    await claim(root, 'RQ-RUN', { dispatched: true, dispatchedMtimeMs: NOW - HOUR });
    await claim(root, 'RQ-PUB', { reaping: true, reapingMtimeMs: NOW - 5 * 60_000 });
    await claim(root, 'RQ-DONE', { rc: '0\n', rcMtimeMs: t, fin: true, finMtimeMs: t + 1000 });
    await claim(root, 'RQ-FAIL', { rc: '1\n', rcMtimeMs: t + 2000 });
    await claim(root, 'RQ-TIMEOUT', { timeout: true, timeoutMtimeMs: t + 3000 });
    await claim(root, 'RQ-FIN', { fin: true, finMtimeMs: t + 4000 });
    await claim(root, 'RQ-EXITED', { rc: 'not-a-code\n', rcMtimeMs: t + 5000 });
    await claim(root, 'RQ-UNKNOWN');

    const v = await read(root);
    expect(v.sources.runs).toBe('healthy');
    const status = (id: string) => byJob(v.sessions, id)?.status;
    expect(status('RQ-LAUNCH')).toBe('launching');
    expect(status('RQ-RUN')).toBe('running');
    expect(status('RQ-PUB')).toBe('publishing');
    expect(status('RQ-DONE')).toBe('done');
    expect(status('RQ-FAIL')).toBe('failed');
    expect(status('RQ-TIMEOUT')).toBe('timeout');
    expect(status('RQ-FIN')).toBe('finished');
    expect(status('RQ-EXITED')).toBe('exited');
    expect(status('RQ-UNKNOWN')).toBe('unknown');
    expect(v.sessions).toHaveLength(9);
  });

  it('parses .line display fields and never emits the prompt path', async () => {
    const root = await runsRoot();
    await claim(root, 'RQ-FIELDS', {
      line: lineRecord('RQ-FIELDS', 'phantom-secrets', 'devin', 'frontier', '/queue/prompts/RQ-FIELDS.md'),
    });
    const v = await read(root);
    const s = byJob(v.sessions, 'RQ-FIELDS');
    expect(s).toMatchObject({ repo: 'phantom-secrets', lane: 'devin', tier: 'frontier' });
    const json = JSON.stringify(v);
    expect(json).not.toContain('/queue/prompts');
    expect(json).not.toContain('RQ-FIELDS.md');
  });

  it('drops repo/lane/tier when the .line job id does not match the marker', async () => {
    const root = await runsRoot();
    await claim(root, 'RQ-REAL', { line: lineRecord('RQ-OTHER', 'phantom', 'devin', 'work') });
    const s = byJob((await read(root)).sessions, 'RQ-REAL');
    expect(s?.job).toBe('RQ-REAL');
    expect(s?.repo).toBeNull();
    expect(s?.lane).toBeNull();
    expect(s?.tier).toBeNull();
  });

  it('degrades a corrupt or oversized .line to null fields, keeping marker status', async () => {
    const root = await runsRoot();
    await claim(root, 'RQ-BADLINE', { line: 'garbage\tno\ttabs\n', dispatched: true, dispatchedMtimeMs: NOW - HOUR });
    await claim(root, 'RQ-HUGELINE', { line: 'x'.repeat(16 * 1024 + 1), dispatched: true, dispatchedMtimeMs: NOW - HOUR });
    const v = await read(root);
    for (const id of ['RQ-BADLINE', 'RQ-HUGELINE']) {
      const s = byJob(v.sessions, id);
      expect(s?.status).toBe('running');
      expect(s?.repo).toBeNull();
      expect(s?.lane).toBeNull();
    }
  });

  it('ignores unsafe .line names but keeps valid odd job ids', async () => {
    const root = await runsRoot();
    const run = join(root, 'queue', 'run');
    await mkdir(run, { recursive: true });
    await writeFile(join(run, 'bad name!.line'), lineRecord('bad name!'));
    await writeFile(join(run, 'UPPER_ok-1.2.line'), lineRecord('UPPER_ok-1.2'));
    await claim(root, 'RQ-GOOD');
    const v = await read(root);
    expect(v.sessions.map((s) => s.job)).toEqual(['RQ-GOOD', 'UPPER_ok-1.2']);
  });

  it('excludes secret-shaped job ids from the scan entirely', async () => {
    const root = await runsRoot();
    const run = join(root, 'queue', 'run');
    await mkdir(run, { recursive: true });
    // JOB_RE passes, but the id must survive scrubSecrets unchanged to list.
    await writeFile(join(run, 'RQ-LEAK-ghp_0123456789abcdefghijklmnop.line'), lineRecord('RQ-LEAK-ghp_0123456789abcdefghijklmnop'));
    await claim(root, 'RQ-CLEAN');
    const v = await read(root);
    expect(v.sessions.map((s) => s.job)).toEqual(['RQ-CLEAN']);
    expect(JSON.stringify(v)).not.toContain('ghp_');
  });

  it('reads through a symlinked .line as absent fields (O_NOFOLLOW)', async () => {
    const root = await runsRoot();
    const run = join(root, 'queue', 'run');
    await mkdir(run, { recursive: true });
    const secret = join(root, 'secret.txt');
    await writeFile(secret, 'token=supersecretvalue\n');
    await symlink(secret, join(run, 'RQ-LINK.line'));
    const dPath = await write(root, 'queue/run/RQ-LINK.dispatched', `${Math.floor((NOW - HOUR) / 1000)}\n`);
    await mtime(dPath, NOW - HOUR);
    const v = await read(root);
    const s = byJob(v.sessions, 'RQ-LINK');
    expect(s?.status).toBe('running');
    expect(s?.repo).toBeNull();
    expect(JSON.stringify(v)).not.toContain('supersecretvalue');
  });
});

// ---------------------------------------------------------------------------
// Attempt freshness — stale markers from a previous attempt
// ---------------------------------------------------------------------------

describe('readFleetSessions — attempt freshness', () => {
  it('ignores a stale .fin/.rc left over from a previous attempt', async () => {
    const root = await runsRoot();
    // Relaunched 5m ago: fresh .line + .dispatched; .fin/.rc are from the old attempt.
    await claim(root, 'RQ-RETRY', {
      lineMtimeMs: NOW - 5 * 60_000,
      dispatched: true, dispatchedMtimeMs: NOW - 5 * 60_000,
      fin: true, finMtimeMs: NOW - 2 * HOUR,
      rc: '0\n', rcMtimeMs: NOW - 2 * HOUR,
    });
    const s = byJob((await read(root)).sessions, 'RQ-RETRY');
    expect(s?.status).toBe('running');
    expect(s?.exitCode).toBeNull();
    expect(s?.endedAtMs).toBeNull();
  });

  it('honors a .fin written during the current attempt', async () => {
    const root = await runsRoot();
    await claim(root, 'RQ-FINNED', {
      lineMtimeMs: NOW - 3 * HOUR,
      fin: true, finMtimeMs: NOW - 10 * 60_000,
    });
    const s = byJob((await read(root)).sessions, 'RQ-FINNED');
    expect(s?.status).toBe('finished');
    expect(s?.endedAtMs).toBe(NOW - 10 * 60_000);
  });

  it('uses the earliest fresh terminal marker as endedAtMs', async () => {
    const root = await runsRoot();
    await claim(root, 'RQ-END', {
      lineMtimeMs: NOW - 4 * HOUR,
      rc: '0\n', rcMtimeMs: NOW - 30 * 60_000,
      fin: true, finMtimeMs: NOW - 20 * 60_000,
    });
    const s = byJob((await read(root)).sessions, 'RQ-END');
    expect(s?.status).toBe('done');
    expect(s?.endedAtMs).toBe(NOW - 30 * 60_000); // .rc write precedes .fin
  });
});

// ---------------------------------------------------------------------------
// Timing + ordering + bounds
// ---------------------------------------------------------------------------

describe('readFleetSessions — timing, ordering, bounds', () => {
  it('derives startedAtMs from .dispatched epoch and elapsed fields', async () => {
    const root = await runsRoot();
    const epochSec = Math.floor((NOW - HOUR) / 1000);
    await claim(root, 'RQ-T', { dispatched: true, dispatchedEpochSec: epochSec, dispatchedMtimeMs: NOW - HOUR });
    const s = byJob((await read(root)).sessions, 'RQ-T');
    expect(s?.startedAtMs).toBe(epochSec * 1000);
    expect(s?.endedAtMs).toBeNull();
  });

  it('falls back to marker mtimes when .dispatched content is malformed', async () => {
    const root = await runsRoot();
    await claim(root, 'RQ-MTIME', {
      dispatched: true, dispatchedContent: 'garbage\n', dispatchedMtimeMs: NOW - HOUR,
    });
    const s = byJob((await read(root)).sessions, 'RQ-MTIME');
    expect(s?.startedAtMs).toBe(NOW - HOUR);
    expect(s?.status).toBe('running');
  });

  it('orders active sessions oldest-first, then finished newest-ended first', async () => {
    const root = await runsRoot();
    await claim(root, 'RQ-NEW-RUN', { dispatched: true, dispatchedMtimeMs: NOW - 10 * 60_000 });
    await claim(root, 'RQ-OLD-RUN', { dispatched: true, dispatchedMtimeMs: NOW - 2 * HOUR });
    await claim(root, 'RQ-DONE-OLD', { lineMtimeMs: NOW - 5 * HOUR, rc: '0\n', rcMtimeMs: NOW - 4 * HOUR });
    await claim(root, 'RQ-DONE-NEW', { lineMtimeMs: NOW - 5 * HOUR, rc: '0\n', rcMtimeMs: NOW - 60_000 });
    const v = await read(root);
    expect(v.sessions.map((s) => s.job)).toEqual(['RQ-OLD-RUN', 'RQ-NEW-RUN', 'RQ-DONE-NEW', 'RQ-DONE-OLD']);
  });

  it('caps the emitted list and reports truncation', async () => {
    const root = await runsRoot();
    for (let i = 0; i < 70; i++) {
      await claim(root, `RQ-CAP-${String(i).padStart(3, '0')}`, { lineMtimeMs: NOW - i * 1000 });
    }
    const v = await read(root);
    expect(v.sessions).toHaveLength(64);
    expect(v.truncated).toBe(true);
  });

  it('is read-only: the runs dir listing is unchanged after a read', async () => {
    const root = await runsRoot();
    await statusJson(root, { schema: 'dispatchd.status.v1', queue_depth: 1 });
    await claim(root, 'RQ-RO', { dispatched: true, dispatchedMtimeMs: NOW - HOUR, rc: '0\n', rcMtimeMs: NOW - 30 * 60_000 });
    const before = (await readdir(join(root, 'queue', 'run'))).sort();
    await read(root);
    const after = (await readdir(join(root, 'queue', 'run'))).sort();
    expect(after).toEqual(before);
  });
});
