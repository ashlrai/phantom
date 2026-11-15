/**
 * fleet.sessions.v1 — unified agent-session projection (GET /api/fleet/sessions).
 *
 * Contract under test:
 *   - One row per dispatchd session assembled read-only from the runs dir:
 *     queue/ready.tsv (queued/parked), queue/run/<job>.{line,dispatched,
 *     enqueued,fin,rc,reaping,batched,timeout} markers, root worker artifacts
 *     (.base/.log/.launch/.publish/.base.meta), metrics/jobs.jsonl tail and
 *     the injectable ps join.
 *   - Statuses: queued, parked (PARKED-DEP dialects + precheck retry),
 *     launching (dispatch grace), running (ps worker or fresh artifacts),
 *     publishing (.reaping dir), exited (.rc), stale (no liveness evidence),
 *     finished (.fin keyed to .base mtime, or a post-claim finish event).
 *   - A ready.tsv row whose job already has live attempt evidence stays
 *     dispatched; a finished/exited/stale attempt re-queued in ready.tsv is
 *     honestly 'queued' again.
 *   - VALUE-BLIND: prompt paths, env and secret-shaped strings never appear
 *     anywhere in the serialized projection; every public field is scrubbed
 *     and capped.
 *   - Every source degrades independently (missing vs degraded); the
 *     projection never throws on absent/corrupt inputs.
 *   - GET /api/fleet/sessions serves the same projection on loopback.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import * as http from 'node:http';

import {
  getFleetSessions,
  parseReadySessionLine,
  parseSessionLine,
  parseSessionMetrics,
  type FleetSessionsV1,
  type FleetSessionV1,
} from '../src/core/fleet/runs-sessions.js';
import { makeCfg } from './helpers/h1-fixture.js';
import { readAuthHeaders, startServer } from './helpers/authenticated-web-server.js';

const ANCHOR = Date.parse('2026-11-05T12:00:00Z');
const S = 1000;
const opts = { now: () => ANCHOR } as const;

let scratch: string;
let openHandles: Array<{ close(): Promise<void> }>;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'runs-sessions-'));
  openHandles = [];
});

afterEach(async () => {
  for (const h of openHandles) {
    try { await h.close(); } catch { /* ignore */ }
  }
  vi.restoreAllMocks();
  await rm(scratch, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Fixture helpers — every path is inside the per-test scratch dir.
// ---------------------------------------------------------------------------

async function write(root: string, rel: string, content: string | Buffer): Promise<string> {
  const path = join(root, rel);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, content);
  return path;
}

async function touch(path: string, ms: number): Promise<void> {
  const d = new Date(ms);
  await utimes(path, d, d);
}

/** dispatchd metric ts: local time `%Y-%m-%dT%H:%M:%S%z`. */
function metricTs(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number): string => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset();
  const sign = off >= 0 ? '+' : '-';
  const oh = pad(Math.floor(Math.abs(off) / 60));
  const om = pad(Math.abs(off) % 60);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}${sign}${oh}${om}`;
}

const epoch = (ms: number): string => String(Math.floor(ms / 1000));
const line = (job: string, repo = 'phantom', lane = 'codex-cmp', tier = 'work'): string =>
  `${job}\t${repo}\t${lane}\t${tier}\t/prompt/dir/${job}.md`;

/** ps table row that parsePsTable recognizes as a launch.sh worker. */
const psWorker = (pid: number, job: string, repo = 'phantom', lane = 'codex-cmp', tier = 'work', etime = '00:12:34'): string =>
  `  ${pid}  ${etime}  /Users/x/.ashlr-runs/work/${job}/bin/launch.sh ${job} ${repo} ${lane} ${tier} /prompt/${job}.md\n`;

const noPs = async (): Promise<string> => '';
const psDown = async (): Promise<string> => { throw new Error('ps failed'); };

async function runsDir(files: Record<string, string | Buffer>): Promise<string> {
  const dir = join(scratch, `runs-${Math.random().toString(36).slice(2)}`);
  for (const [rel, content] of Object.entries(files)) await write(dir, rel, content);
  return dir;
}

const byJob = (snap: FleetSessionsV1, job: string): FleetSessionV1 | undefined =>
  [...snap.sessions, ...snap.recent].find(s => s.job === job);

// ---------------------------------------------------------------------------
// Pure parsers
// ---------------------------------------------------------------------------

describe('parseReadySessionLine', () => {
  it('parses the normal job repo lane tier prompt dialect', () => {
    const row = parseReadySessionLine('JOB1\tphantom\tcodex-cmp\twork\t/prompt/job1.md');
    expect(row).toEqual({ job: 'JOB1', repo: 'phantom', lane: 'codex-cmp', tier: 'work', parked: null });
  });

  it('parses status-first PARKED-DEP.<lane> rows', () => {
    const row = parseReadySessionLine('PARKED-DEP.claude\tJOB2\tclaude\tfrontier\tlexicon\t/p/x.md');
    expect(row).toEqual({ job: 'JOB2', repo: 'lexicon', lane: 'claude', tier: 'frontier', parked: 'dependency' });
  });

  it('parses lane-column PARKED-DEP.<lane> rows', () => {
    const row = parseReadySessionLine('JOB3\tphantom\tPARKED-DEP.devin\tfast\t/p/x.md');
    expect(row).toEqual({ job: 'JOB3', repo: 'phantom', lane: 'devin', tier: 'fast', parked: 'dependency' });
  });

  it('rejects comments, kv rows, short rows and bad fields', () => {
    for (const bad of [
      '# comment',
      'key=value\tother',
      'JOB1\tphantom',
      'JOB1\tphantom\tcodex-cmp\tbogus-tier\t/p.md',
      'JOB1\tphantom\tbad lane!\twork\t/p.md',
      '',
    ]) {
      expect(parseReadySessionLine(bad)).toBeNull();
    }
  });
});

describe('parseSessionLine', () => {
  it('parses .line content and never retains the prompt path', () => {
    const parsed = parseSessionLine(line('JOB9', 'phantom', 'devin', 'mid'));
    expect(parsed).toEqual({ job: 'JOB9', repo: 'phantom', lane: 'devin', tier: 'mid' });
    expect(JSON.stringify(parsed)).not.toContain('/prompt/');
  });

  it('rejects malformed content', () => {
    expect(parseSessionLine('not enough\tfields')).toBeNull();
    expect(parseSessionLine('')).toBeNull();
  });
});

describe('parseSessionMetrics', () => {
  it('keeps last-event facts per job and skips jobless/malformed lines', () => {
    const text = [
      JSON.stringify({ event: 'enqueue', job: 'J1', ts: metricTs(ANCHOR - 900 * S) }),
      JSON.stringify({ event: 'claim', job: 'J1', ts: metricTs(ANCHOR - 800 * S) }),
      JSON.stringify({ event: 'launch', job: 'J1', ts: metricTs(ANCHOR - 790 * S), model: 'gpt-5.3-codex' }),
      JSON.stringify({ event: 'finish', job: 'J1', ts: metricTs(ANCHOR - 100 * S), tokens_total: 12345, wall_s: 600.7, diff_lines: 42, exit_code: 0, empty: false }),
      JSON.stringify({ event: 'publish', job: 'J1', ts: metricTs(ANCHOR - 90 * S), url: 'https://github.com/ashlrai/phantom/pull/77', class: 'pr' }),
      JSON.stringify({ event: 'concurrency', from: 1, to: 2 }), // jobless — skipped silently
      '{not json',
      JSON.stringify({ event: 'launch', job: 'J1', ts: metricTs(ANCHOR - 700 * S), model: 'older-model' }),
    ].join('\n');
    const { facts, malformed } = parseSessionMetrics(text);
    const f = facts.get('J1')!;
    expect(f.launchModel).toBe('older-model'); // last launch wins
    expect(f.launchTsMs).toBe(Date.parse(metricTs(ANCHOR - 700 * S)));
    expect(f.tokensTotal).toBe(12345);
    expect(f.wallSeconds).toBe(600);
    expect(f.diffLines).toBe(42);
    expect(f.exitCode).toBe(0);
    expect(f.prUrl).toBe('https://github.com/ashlrai/phantom/pull/77');
    expect(malformed).toBe(1); // only the unparseable line
  });
});

// ---------------------------------------------------------------------------
// getFleetSessions — the kitchen-sink fixture
// ---------------------------------------------------------------------------

describe('getFleetSessions', () => {
  it('classifies queued, parked, launching, running, exited, stale and finished sessions', async () => {
    const baseMtime = ANCHOR - 500 * S;
    const dir = await runsDir({
      'queue/ready.tsv': [
        '# waiting',
        'JOB-Q1\tphantom\tcodex-cmp\twork\t/p/q1.md',
        'PARKED-DEP.claude\tJOB-P1\tclaude\tfrontier\tlexicon\t/p/p1.md',
        'JOB-P2\tphantom\tdevin\tfast\t/p/p2.md',
        'JOB-M1\tphantom\tdevin\tbogus-tier\t/p/m1.md', // malformed tier
        'JOB-RUN1\tphantom\tcodex-cmp\twork\t/p/run1.md', // dispatched job still listed → dedupe
        'JOB-REQUEUE\tphantom\tcodex-cmp\twork\t/p/requeue.md',
        '',
      ].join('\n'),
      'queue/claimed.tsv': `JOB-P2\tdevin\tfast\t11:00\t${epoch(ANCHOR - 700 * S)}\n`,
      'queue/precheck-parked.json': JSON.stringify({ 'JOB-P2': { retry_at: (ANCHOR + 3600 * S) / 1000 } }),
      'queue/status.json': JSON.stringify({
        schema: 'dispatchd.status.v1', last_tick: new Date(ANCHOR - 15 * S).toISOString(), paused: null,
      }),
      [`queue/run/${'JOB-Q1'}.enqueued`]: `${(ANCHOR - 600 * S) / 1000}\n`,
      'queue/run/JOB-RUN1.line': line('JOB-RUN1'),
      'queue/run/JOB-RUN1.dispatched': epoch(ANCHOR - 300 * S),
      'queue/run/JOB-RUN1.enqueued': `${(ANCHOR - 400 * S) / 1000}\n`,
      'queue/run/JOB-LCH.line': line('JOB-LCH', 'phantom', 'claude', 'frontier'),
      'queue/run/JOB-LCH.dispatched': epoch(ANCHOR - 30 * S), // inside launch grace
      'queue/run/JOB-EXIT.line': line('JOB-EXIT', 'lexicon', 'devin', 'mid'),
      'queue/run/JOB-EXIT.dispatched': epoch(ANCHOR - 900 * S),
      'queue/run/JOB-EXIT.rc': '0\n',
      'queue/run/JOB-STALE.line': line('JOB-STALE'),
      'queue/run/JOB-STALE.dispatched': epoch(ANCHOR - 7200 * S),
      'queue/run/JOB-FIN.line': line('JOB-FIN'),
      'queue/run/JOB-FIN.dispatched': epoch(ANCHOR - 800 * S),
      'queue/run/JOB-FIN.rc': '0\n',
      'queue/run/JOB-FIN.fin': String(Math.floor(baseMtime / 1000)),
      'queue/run/JOB-REQUEUE.line': line('JOB-REQUEUE'),
      'queue/run/JOB-REQUEUE.dispatched': epoch(ANCHOR - 2000 * S),
      'queue/run/JOB-REQUEUE.rc': '1\n',
      'JOB-RUN1.launch': 'launched\n',
      'JOB-RUN1.base': 'base\n',
      'JOB-RUN1.log': 'log\n',
      'JOB-RUN1.base.meta': 'MODEL codex-cmp work gpt-5.3-codex extra\n',
      'JOB-FIN.base': 'base\n',
      'JOB-FIN.publish': 'RESULT PR https://github.com/ashlrai/phantom/pull/123\n',
      'metrics/jobs.jsonl': [
        JSON.stringify({ event: 'enqueue', job: 'JOB-Q1', ts: metricTs(ANCHOR - 610 * S) }),
        JSON.stringify({ event: 'claim', job: 'JOB-RUN1', ts: metricTs(ANCHOR - 305 * S) }),
        JSON.stringify({ event: 'launch', job: 'JOB-RUN1', ts: metricTs(ANCHOR - 300 * S), model: 'gpt-5.3-codex' }),
        JSON.stringify({ event: 'claim', job: 'JOB-FIN', ts: metricTs(ANCHOR - 790 * S) }),
        JSON.stringify({ event: 'launch', job: 'JOB-FIN', ts: metricTs(ANCHOR - 780 * S), model: 'gpt-5.3-codex' }),
        JSON.stringify({ event: 'finish', job: 'JOB-FIN', ts: metricTs(ANCHOR - 120 * S), tokens_total: 4321, wall_s: 640.4, diff_lines: 17, exit_code: 0, empty: false }),
        JSON.stringify({ event: 'publish', job: 'JOB-FIN', ts: metricTs(ANCHOR - 110 * S), url: 'https://github.com/ashlrai/phantom/pull/123', class: 'pr' }),
        '{corrupt line',
      ].join('\n'),
    });
    // Control mtimes: .line claims and worker artifacts relative to ANCHOR.
    const age = async (rel: string, msAgo: number) => touch(join(dir, rel), ANCHOR - msAgo * S);
    await age('queue/run/JOB-RUN1.line', 305);
    await age('queue/run/JOB-LCH.line', 35);
    await age('queue/run/JOB-EXIT.line', 905);
    await age('queue/run/JOB-STALE.line', 7210);
    await age('queue/run/JOB-FIN.line', 795);
    await age('queue/run/JOB-REQUEUE.line', 2010);
    await age('JOB-RUN1.launch', 300);
    await age('JOB-RUN1.base', 60);
    await age('JOB-RUN1.log', 55);
    await touch(join(dir, 'JOB-FIN.base'), baseMtime);
    await age('queue/run/JOB-FIN.fin', 115);

    const snap = await getFleetSessions({
      ...opts,
      runsDir: dir,
      runPs: async () => psWorker(4321, 'JOB-RUN1'),
    });

    expect(snap.schema).toBe('fleet.sessions.v1');
    // The fixture deliberately carries a bad ready row and a corrupt ledger
    // line — those two sources degrade; everything else stays healthy.
    expect(snap.sourceState).toBe('degraded');
    expect(snap.sources.ready).toBe('degraded');
    expect(snap.sources.metrics).toBe('degraded');
    expect(snap.sources.runDir).toBe('healthy');
    expect(snap.sources.live).toBe('healthy');
    expect(snap.runsDirPresent).toBe(true);
    expect(snap.malformed).toBeGreaterThanOrEqual(2); // JOB-M1 row + corrupt ledger line
    expect(snap.truncated).toBe(false);

    // ── statuses ──────────────────────────────────────────────────────────
    expect(byJob(snap, 'JOB-RUN1')?.status).toBe('running');
    expect(byJob(snap, 'JOB-LCH')?.status).toBe('launching');
    expect(byJob(snap, 'JOB-EXIT')?.status).toBe('exited');
    expect(byJob(snap, 'JOB-STALE')?.status).toBe('stale');
    expect(byJob(snap, 'JOB-Q1')?.status).toBe('queued');
    expect(byJob(snap, 'JOB-P1')?.status).toBe('parked');
    expect(byJob(snap, 'JOB-P2')?.status).toBe('parked');
    expect(byJob(snap, 'JOB-REQUEUE')?.status).toBe('queued'); // re-queued finished attempt
    expect(byJob(snap, 'JOB-M1')).toBeUndefined(); // malformed row dropped
    expect(byJob(snap, 'JOB-FIN')?.status).toBe('finished');

    // ── counts ────────────────────────────────────────────────────────────
    expect(snap.counts).toEqual({ queued: 2, parked: 2, launching: 1, running: 1, publishing: 0, exited: 1, stale: 1 });

    // ── running session detail ────────────────────────────────────────────
    const run1 = byJob(snap, 'JOB-RUN1')!;
    expect(run1.repo).toBe('phantom');
    expect(run1.lane).toBe('codex-cmp');
    expect(run1.tier).toBe('work');
    expect(run1.pid).toBe(4321);
    expect(run1.live).toBe('yes');
    expect(run1.model).toBe('gpt-5.3-codex');
    expect(run1.enqueuedAt).toBe(new Date(ANCHOR - 400 * S).toISOString());
    expect(run1.claimedAt).toBe(new Date(ANCHOR - 300 * S).toISOString());
    expect(run1.launchedAt).toBe(new Date(ANCHOR - 300 * S).toISOString()); // launch metric ts
    expect(run1.elapsedSeconds).toBe(300);
    expect(run1.queueWaitSeconds).toBe(100); // claimed - enqueued
    // The ready.tsv duplicate of JOB-RUN1 must not produce a second row.
    expect(snap.sessions.filter(s => s.job === 'JOB-RUN1')).toHaveLength(1);

    // ── queued session detail ─────────────────────────────────────────────
    const q1 = byJob(snap, 'JOB-Q1')!;
    expect(q1.live).toBe('no');
    expect(q1.pid).toBeNull();
    expect(q1.enqueuedAt).toBe(new Date(ANCHOR - 600 * S).toISOString()); // .enqueued receipt wins
    expect(q1.elapsedSeconds).toBe(600);
    expect(q1.claimedAt).toBeNull();
    expect(q1.launchedAt).toBeNull();

    // parked precheck fallback: claimed.tsv supplies enqueuedAt
    const p2 = byJob(snap, 'JOB-P2')!;
    expect(p2.status).toBe('parked');
    expect(p2.enqueuedAt).toBe(new Date(ANCHOR - 700 * S).toISOString());

    // parked dependency keeps its explicit lane
    expect(byJob(snap, 'JOB-P1')?.lane).toBe('claude');

    // ── finished tail ─────────────────────────────────────────────────────
    const fin = byJob(snap, 'JOB-FIN')!;
    expect(fin.status).toBe('finished');
    expect(fin.outcome).toBe('pr');
    expect(fin.prUrl).toBe('https://github.com/ashlrai/phantom/pull/123');
    expect(fin.tokensTotal).toBe(4321);
    expect(fin.wallSeconds).toBe(640);
    expect(fin.diffLines).toBe(17);
    expect(fin.durationSeconds).toBe(640);
    expect(snap.recent[0]?.job).toBe('JOB-FIN');
    expect(snap.recent).toHaveLength(1);

    // ── dispatcher context ────────────────────────────────────────────────
    expect(snap.dispatcher?.paused).toBe(false);
    expect(snap.dispatcher?.tickAgeSeconds).toBe(15);

    // ── VALUE-BLIND: no prompt paths anywhere in the projection ───────────
    const json = JSON.stringify(snap);
    for (const secret of ['/p/q1.md', '/p/p1.md', '/p/run1.md', '/p/requeue.md', '/prompt/']) {
      expect(json).not.toContain(secret);
    }
  });

  it('reports missing sources honestly on an absent runs dir', async () => {
    const dir = join(scratch, 'no-such-dir');
    const snap = await getFleetSessions({ ...opts, runsDir: dir, runPs: noPs });
    expect(snap.schema).toBe('fleet.sessions.v1');
    expect(snap.sourceState).toBe('missing');
    expect(snap.runsDirPresent).toBe(false);
    expect(snap.sessions).toEqual([]);
    expect(snap.recent).toEqual([]);
    expect(snap.dispatcher).toBeNull();
    expect(snap.sources.runDir).toBe('missing');
    expect(snap.sources.ready).toBe('missing');
    expect(snap.sources.live).toBe('healthy'); // ps ran fine; nothing to join
  });

  it('degrades only the broken sources and marks live unknown when ps fails', async () => {
    const dir = await runsDir({
      'queue/run/JOB-X.line': line('JOB-X'),
      'queue/run/JOB-X.dispatched': epoch(ANCHOR - 60 * S),
      'queue/ready.tsv': 'JOB-BAD\tphantom\tlane with spaces\twork\t/p.md\n',
      'queue/precheck-parked.json': '{broken',
      'metrics/jobs.jsonl': '{also broken',
    });
    await touch(join(dir, 'queue/run/JOB-X.line'), ANCHOR - 65 * S);
    const snap = await getFleetSessions({ ...opts, runsDir: dir, runPs: psDown });
    expect(snap.sourceState).toBe('degraded');
    expect(snap.sources.live).toBe('degraded');
    expect(snap.sources.precheck).toBe('degraded');
    expect(snap.sources.metrics).toBe('degraded');
    expect(snap.sources.ready).toBe('degraded'); // bad lane → row malformed
    const x = byJob(snap, 'JOB-X')!;
    expect(x.status).toBe('launching'); // dispatched 60s ago, inside grace
    expect(x.live).toBe('unknown'); // ps unavailable
    expect(x.pid).toBeNull();
    expect(snap.malformed).toBeGreaterThanOrEqual(2); // bad ready row + corrupt ledger line
  });

  it('refuses symlinked .line markers instead of reading through them', async () => {
    const dir = await runsDir({
      'queue/run/JOB-REAL.line': line('JOB-REAL'),
      'queue/run/JOB-REAL.dispatched': epoch(ANCHOR - 60 * S),
      'queue/elsewhere.txt': 'decoy',
    });
    await symlink(join(dir, 'queue/elsewhere.txt'), join(dir, 'queue/run/JOB-LINK.line'));
    const snap = await getFleetSessions({ ...opts, runsDir: dir, runPs: noPs });
    expect(byJob(snap, 'JOB-LINK')).toBeUndefined();
    expect(byJob(snap, 'JOB-REAL')?.status).toBe('launching');
  });

  it('caps active sessions and the recent tail', async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 8; i++) {
      const job = `JOB-C${i}`;
      files[`queue/run/${job}.line`] = line(job);
      files[`queue/run/${job}.dispatched`] = epoch(ANCHOR - (5000 + i) * S);
    }
    const dir = await runsDir(files);
    const snap = await getFleetSessions({ ...opts, runsDir: dir, runPs: noPs, maxSessions: 3, maxRecent: 2 });
    expect(snap.sessions).toHaveLength(3);
    expect(snap.truncated).toBe(true);
  });

  it('keeps .rc malformed rows honest and does not fabricate exit codes', async () => {
    const dir = await runsDir({
      'queue/run/JOB-RC.line': line('JOB-RC'),
      'queue/run/JOB-RC.dispatched': epoch(ANCHOR - 900 * S),
      'queue/run/JOB-RC.rc': 'not-a-number\n',
      'queue/run/JOB-RC.enqueued': `${(ANCHOR - 1000 * S) / 1000}\n`,
    });
    await touch(join(dir, 'queue/run/JOB-RC.line'), ANCHOR - 905 * S);
    const snap = await getFleetSessions({ ...opts, runsDir: dir, runPs: noPs });
    const rc = byJob(snap, 'JOB-RC')!;
    expect(rc.exitCode).toBeNull();
    expect(rc.status).toBe('stale'); // no .rc value → no exit evidence; nothing fresh
    expect(snap.malformed).toBeGreaterThanOrEqual(1);
  });

  it('treats .fin keyed to a stale .base mtime as a previous attempt', async () => {
    const dir = await runsDir({
      'queue/run/JOB-OLD.line': line('JOB-OLD'),
      'queue/run/JOB-OLD.dispatched': epoch(ANCHOR - 800 * S),
      'queue/run/JOB-OLD.rc': '0\n',
      'queue/run/JOB-OLD.fin': '1111111111', // does not match .base mtime
      'JOB-OLD.base': 'base\n',
      'JOB-OLD.log': 'log\n',
    });
    await touch(join(dir, 'queue/run/JOB-OLD.line'), ANCHOR - 805 * S);
    await touch(join(dir, 'JOB-OLD.base'), ANCHOR - 790 * S);
    await touch(join(dir, 'JOB-OLD.log'), ANCHOR - 400 * S); // fresh-ish log, no rc? rc exists → exited path
    const snap = await getFleetSessions({ ...opts, runsDir: dir, runPs: noPs });
    const old = byJob(snap, 'JOB-OLD')!;
    expect(old.status).not.toBe('finished');
    expect(old.status).toBe('exited'); // .rc present, .fin mismatched
  });
});

// ---------------------------------------------------------------------------
// GET /api/fleet/sessions — loopback route serves the same projection.
// ---------------------------------------------------------------------------

describe('GET /api/fleet/sessions', () => {
  function get(url: string, port: number): Promise<{ statusCode: number; body: string }> {
    return new Promise((resolvePromise, reject) => {
      const parsed = new URL(url);
      const req = http.request(
        {
          hostname: parsed.hostname, port, path: parsed.pathname + parsed.search,
          method: 'GET', headers: { Host: `127.0.0.1:${port}`, ...readAuthHeaders(port) },
        },
        (res) => {
          let data = '';
          res.on('data', (c: Buffer) => { data += c.toString(); });
          res.on('end', () => resolvePromise({ statusCode: res.statusCode ?? 0, body: data }));
        },
      );
      req.on('error', reject);
      req.end();
    });
  }

  it('serves fleet.sessions.v1 on the loopback server', async () => {
    // The suite HOME is relocated (test/setup/home.ts); seed the default runs dir.
    const runs = join(homedir(), '.ashlr-runs');
    await mkdir(join(runs, 'queue', 'run'), { recursive: true });
    await writeFile(join(runs, 'queue', 'ready.tsv'), 'JOB9\tphantom\tcodex-cmp\twork\t/p/q9.md\n');
    await writeFile(join(runs, 'queue', 'run', 'JOB8.line'), 'JOB8\tphantom\tdevin\tmid\t/p/j8.md\n');
    await writeFile(join(runs, 'queue', 'run', 'JOB8.dispatched'), String(Math.floor(Date.now() / 1000) - 30));

    const h = await startServer(makeCfg(), { port: 0, open: false, allowDispatch: false });
    openHandles.push(h);

    const res = await get(`${h.url}/api/fleet/sessions`, h.port);
    expect(res.statusCode).toBe(200);
    const snap = JSON.parse(res.body) as FleetSessionsV1;
    expect(snap.schema).toBe('fleet.sessions.v1');
    expect(snap.runsDirPresent).toBe(true);
    const jobs = new Set([...snap.sessions, ...snap.recent].map(s => s.job));
    expect(jobs.has('JOB8')).toBe(true);
    expect(jobs.has('JOB9')).toBe(true);
    // The route is read-only and value-blind end to end.
    expect(res.body).not.toContain('/p/j8.md');
    expect(res.body).not.toContain('/p/q9.md');
  });
});
