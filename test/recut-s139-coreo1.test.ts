/**
 * recut-s139-coreo1.test.ts — RQ-PHX-RECUTCOREO1S139 (recut of PR #1685).
 *
 * Asserts the landed work through the real modules (no new seams):
 *   - lane-console.ts: parseQueueV1Document now carries validated job `rows`
 *     (repo/tier/priority plus a bounded single-line summary), and the new
 *     isLiveQueueStatus export shares the snapshot's in-flight status set.
 *   - workbench-fleet-view.ts: buildWorkbenchFleetView merges queue.v1.json
 *     with ready.tsv (queue.v1 wins on shared ids; tsv-only jobs surface),
 *     counts live/ready honestly, and never fabricates a section.
 *   - wb-read-api.ts: GET /api/wb/v1/fleet is routed through handleWbApi's
 *     real table — GET answers 200 workbench.fleet.v1, POST 405, an
 *     unregistered /api/wb/v1/* path still 404s.
 *
 * Hermetic: queue files and HOME live under per-test tmp dirs; the GitHub
 * read is exercised through `paths: () => []`, which runs the real
 * readVerseGithubSnapshotAsync over zero repos — no subprocess.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AshlrConfig } from '../src/core/types.js';
import {
  isLiveQueueStatus,
  parseQueueV1Document,
} from '../src/core/fleet/lane-console.js';
import {
  buildWorkbenchFleetView,
  WB_FLEET_PATH,
  type WorkbenchFleetViewDeps,
} from '../src/core/web/workbench-fleet-view.js';
import { handleWbApi, isWbApiPath, type WbApiDeps } from '../src/core/web/wb-read-api.js';
import { makeCfg } from './helpers/h1-fixture.js';

// ---------------------------------------------------------------------------
// Per-test tmp HOME + queue dir (the read surfaces resolve from homedir()).
// ---------------------------------------------------------------------------

let tmpHome: string;
let queueDir: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;
let prevAshlrHome: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'recut-s139-'));
  queueDir = join(tmpHome, '.ashlr-runs', 'queue');
  mkdirSync(queueDir, { recursive: true });
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  prevAshlrHome = process.env.ASHLR_HOME;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.env.ASHLR_HOME = join(tmpHome, '.ashlr');
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserProfile;
  if (prevAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = prevAshlrHome;
  rmSync(tmpHome, { recursive: true, force: true });
});

const cfg = (): AshlrConfig => makeCfg();

const viewDeps = (): WorkbenchFleetViewDeps => ({
  queueDir,
  paths: () => [],
});

function seedQueue(): void {
  writeFileSync(join(queueDir, 'queue.v1.json'), JSON.stringify({
    schema: 'queue.v1',
    jobs: [
      { id: 'RQ-1', status: 'claimed', pool: 'devin', repo: 'phantom', tier: 'work', priority: 'P0', task: 'first line\nsecond line' },
      { id: 'RQ-2', status: 'READY', pool: 'devin', repo: 'phantom' },
    ],
  }));
  writeFileSync(join(queueDir, 'ready.tsv'), [
    'id\tstatus\tpool\ttier\trepo\tpriority\ttitle',
    'RQ-1\tCLAIMED\tdevin\twork\tphantom\tP0\tstale duplicate — queue.v1 wins',
    'RQ-9\tREADY\tdevin\twork\tphantom\tP2\ttsv-only queued job',
    '',
  ].join('\n'));
}

// ---------------------------------------------------------------------------
// lane-console row projection + live-status helper (the carried hunks)
// ---------------------------------------------------------------------------

describe('queue.v1 row projection', () => {
  it('carries validated rows with normalized status, text fields and a bounded one-line summary', () => {
    const read = parseQueueV1Document(JSON.stringify({
      schema: 'queue.v1',
      jobs: [
        { id: 'RQ-1', status: 'claimed', pool: 'devin', repo: 'phantom', tier: 'work', priority: 'P0', task: 'first line\nsecond line' },
        { id: 'RQ-2', status: 'READY', pool: 'devin', title: 'has a title' },
        { id: 'RQ-3', status: 'READY', pool: 'devin' },
      ],
    }));
    expect(read.jobs).toBe(3);
    expect(read.rows).toHaveLength(3);
    expect(read.rows[0]).toMatchObject({
      id: 'RQ-1', status: 'CLAIMED', pool: 'devin',
      repo: 'phantom', tier: 'work', priority: 'P0', summary: 'first line',
    });
    expect(read.rows[1]!.summary).toBe('has a title');
    expect(read.rows[2]!.summary).toBeUndefined();
  });

  it('bounds a summary to one line and 240 chars, and still rejects invalid rows', () => {
    const read = parseQueueV1Document(JSON.stringify({
      schema: 'queue.v1',
      jobs: [{ id: 'RQ-4', status: 'READY', pool: 'devin', task: 'x'.repeat(500) }],
    }));
    expect(read.rows[0]!.summary).toHaveLength(240);
    expect(() => parseQueueV1Document(JSON.stringify({
      schema: 'queue.v1',
      jobs: [{ id: 'bad id!', status: 'READY', pool: 'devin' }],
    }))).toThrow('invalid queue.v1 job');
  });

  it('isLiveQueueStatus shares the snapshot in-flight set, case-insensitive', () => {
    for (const live of ['claimed', 'PR-OPEN', 'Working', 'dispatched', 'IN-PROGRESS', 'starting']) {
      expect(isLiveQueueStatus(live), live).toBe(true);
    }
    for (const queued of ['ready', 'DONE', 'failed', 'merged', 'held']) {
      expect(isLiveQueueStatus(queued), queued).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// buildWorkbenchFleetView — the composite workbench.fleet.v1 projection
// ---------------------------------------------------------------------------

describe('buildWorkbenchFleetView', () => {
  it('answers workbench.fleet.v1 and merges queue.v1 + ready.tsv with queue.v1 authoritative', async () => {
    seedQueue();
    const view = await buildWorkbenchFleetView(cfg(), viewDeps());
    expect(view.v).toBe(1);
    expect(view.schema).toBe('workbench.fleet.v1');
    expect(['ok', 'degraded']).toContain(view.state);

    expect(view.jobs.state).toBe('ok');
    expect(view.jobs.sources).toEqual({ queueV1: 'ok', readyTsv: 'ok' });
    const ids = view.jobs.jobs.map((job) => job.id);
    expect(ids.filter((id) => id === 'RQ-1')).toHaveLength(1);
    expect(ids).toContain('RQ-9');
    const rq1 = view.jobs.jobs.find((job) => job.id === 'RQ-1')!;
    expect(rq1).toMatchObject({
      status: 'CLAIMED', pool: 'devin', repo: 'phantom', tier: 'work',
      priority: 'P0', summary: 'first line', live: true, source: 'queue.v1',
    });
    const rq9 = view.jobs.jobs.find((job) => job.id === 'RQ-9')!;
    expect(rq9).toMatchObject({ status: 'READY', source: 'ready.tsv', summary: 'tsv-only queued job', live: false });
    expect(view.jobs.counts).toMatchObject({ live: 1, ready: 2, total: 3 });
  });

  it('marks the jobs section missing when no queue files exist — never fabricated', async () => {
    const view = await buildWorkbenchFleetView(cfg(), viewDeps());
    expect(view.jobs.state).toBe('unknown');
    expect(view.jobs.reason).toBe('missing');
    expect(view.jobs.jobs).toEqual([]);
    expect(view.jobs.counts).toEqual({ live: 0, ready: 0, total: 0 });
    expect(view.prs.state).toBe('ok'); // empty paths → the real reader answers an empty snapshot
    expect(view.prs.open).toEqual([]);
  });

  it('a malformed queue.v1 degrades only its source; ready.tsv still answers', async () => {
    writeFileSync(join(queueDir, 'queue.v1.json'), '{broken\n');
    writeFileSync(join(queueDir, 'ready.tsv'), 'RQ-2\tREADY\tdevin\twork\tphantom\tP1\tqueued\n');
    const view = await buildWorkbenchFleetView(cfg(), viewDeps());
    expect(view.jobs.state).toBe('ok');
    expect(view.jobs.sources).toEqual({ queueV1: 'invalid', readyTsv: 'ok' });
    expect(view.jobs.jobs).toHaveLength(1);
    expect(view.jobs.jobs[0]).toMatchObject({ id: 'RQ-2', source: 'ready.tsv' });
  });
});

// ---------------------------------------------------------------------------
// Route table — GET /api/wb/v1/fleet through the real handleWbApi entry point
// ---------------------------------------------------------------------------

function fakeResponse(): { res: ServerResponse; status: () => number; body: () => unknown } {
  let status = 0;
  let raw = '';
  const res = {
    writeHead(code: number) { status = code; return res; },
    end(chunk?: string) { raw = chunk ?? ''; return res; },
  } as unknown as ServerResponse;
  return { res, status: () => status, body: () => JSON.parse(raw) };
}

const get = { method: 'GET' } as unknown as IncomingMessage;
const post = { method: 'POST' } as unknown as IncomingMessage;

describe('GET /api/wb/v1/fleet routing', () => {
  const apiDeps = (): WbApiDeps => ({ fleet: viewDeps() });

  it('is a wb path and is routed to a 200 workbench.fleet.v1 answer', async () => {
    seedQueue();
    expect(isWbApiPath(WB_FLEET_PATH)).toBe(true);
    const { res, status, body } = fakeResponse();
    expect(await handleWbApi(get, res, cfg(), WB_FLEET_PATH, apiDeps())).toBe(true);
    expect(status()).toBe(200);
    const payload = body() as { schema?: string; jobs?: { counts: { total: number } } };
    expect(payload.schema).toBe('workbench.fleet.v1');
    expect(payload.jobs?.counts.total).toBe(3);
  });

  it('rejects non-GET methods with 405 and unknown wb paths with 404', async () => {
    const a = fakeResponse();
    expect(await handleWbApi(post, a.res, cfg(), WB_FLEET_PATH, apiDeps())).toBe(true);
    expect(a.status()).toBe(405);
    const b = fakeResponse();
    expect(await handleWbApi(get, b.res, cfg(), '/api/wb/v1/nope', apiDeps())).toBe(true);
    expect(b.status()).toBe(404);
  });
});
