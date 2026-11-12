/**
 * recut-core-old-c199.test.ts — recut coverage for PR #1685
 * (RQ-PHDESKQ8: `GET /api/wb/v1/fleet`, the composite live fleet workbench
 * view). Exercises the recovered behavior through its real exported entry
 * points: handleWbApi's route dispatch, buildWorkbenchFleetView, and the
 * lane-console queue.v1 row projection it consumes.
 *
 * Hermetic: HOME/ASHLR_HOME are repointed to a tmp dir for the duration of
 * each test so the leader and budget readers see only seeded files; the gh
 * seam is `paths: () => []`, which never spawns.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AshlrConfig } from '../src/core/types.js';
import { handleWbApi, isWbApiPath, WB_FLEET_PATH } from '../src/core/web/wb-read-api.js';
import { buildWorkbenchFleetView } from '../src/core/web/workbench-fleet-view.js';
import { isLiveQueueStatus, parseQueueV1Document } from '../src/core/fleet/lane-console.js';

const QUEUE_V1 = {
  schema: 'queue.v1',
  jobs: [
    { id: 'RQ-1', status: 'CLAIMED', pool: 'devin', repo: 'phantom', task: 'Fix the flaky wb test' },
    { id: 'RQ-2', status: 'READY', pool: 'devin', repo: 'phantom' },
    { id: 'RQ-3', status: 'DONE', pool: 'local-omlx' },
  ],
};

const READY_TSV = [
  'id\tstatus\tpool\ttier\trepo\tpriority\ttitle',
  'RQ-1\tCLAIMED\tdevin\twork\tphantom\tP0\tduplicate row — queue.v1 wins',
  'RQ-9\tREADY\tdevin\twork\tphantom\tP2\ttsv-only queued job',
  '',
].join('\n');

function makeConfig(): AshlrConfig {
  return {
    version: 1,
    roots: [],
    editor: 'cursor',
    staleDays: 30,
    categories: {},
    tidyRules: [],
    keepers: [],
    models: {
      lmstudio: 'http://localhost:1234',
      ollama: 'http://localhost:11434',
      providerChain: ['ollama'],
    },
    telemetry: {},
    tools: {},
  };
}

interface Captured {
  status: number;
  body: string;
}

function fakeResponse(): { res: ServerResponse; out: Captured } {
  const out: Captured = { status: 0, body: '' };
  const res = {
    writeHead(status: number) {
      out.status = status;
      return res;
    },
    end(body?: string) {
      out.body = body ?? '';
    },
    setHeader() {},
    getHeader() {
      return undefined;
    },
  } as unknown as ServerResponse;
  return { res, out };
}

const req = (method: string) => ({ method }) as IncomingMessage;

let tmpHome: string;
let queueDir: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;
let prevAshlrHome: string | undefined;

beforeEach(() => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-recut-c199-'));
  queueDir = path.join(tmpHome, '.ashlr-runs', 'queue');
  fs.mkdirSync(queueDir, { recursive: true });
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  prevAshlrHome = process.env.ASHLR_HOME;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  process.env.ASHLR_HOME = path.join(tmpHome, '.ashlr');
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserProfile;
  if (prevAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = prevAshlrHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe('GET /api/wb/v1/fleet (recovered from PR #1685)', () => {
  it('isWbApiPath claims the route and dispatch answers workbench.fleet.v1', async () => {
    expect(isWbApiPath(WB_FLEET_PATH)).toBe(true);
    fs.writeFileSync(path.join(queueDir, 'queue.v1.json'), JSON.stringify(QUEUE_V1));
    fs.writeFileSync(path.join(queueDir, 'ready.tsv'), READY_TSV);

    const { res, out } = fakeResponse();
    const handled = await handleWbApi(req('GET'), res, makeConfig(), WB_FLEET_PATH, {
      paths: () => [],
      fleet: { queueDir },
    });
    expect(handled).toBe(true);
    expect(out.status).toBe(200);

    const body = JSON.parse(out.body);
    expect(body.v).toBe(1);
    expect(body.schema).toBe('workbench.fleet.v1');
    for (const section of ['lanes', 'jobs', 'prs', 'leader']) {
      expect(body[section], section).toBeTruthy();
    }

    // jobs — queue.v1 authoritative: RQ-1 deduped against the tsv copy; the
    // tsv-only READY row still surfaces; statuses keep their live meaning.
    expect(body.jobs.state).toBe('ok');
    const ids = body.jobs.jobs.map((j: { id: string | null }) => j.id);
    expect(ids.filter((id: string | null) => id === 'RQ-1')).toHaveLength(1);
    expect(ids).toContain('RQ-9');
    const rq1 = body.jobs.jobs.find((j: { id: string | null }) => j.id === 'RQ-1');
    expect(rq1).toMatchObject({ source: 'queue.v1', live: true, summary: 'Fix the flaky wb test' });
    expect(body.jobs.counts).toEqual({ live: 1, ready: 2, total: 4 });

    // lanes — the budget-pool roster always answers, honestly null on data.
    expect(body.lanes.state).toBe('ok');
    expect(body.lanes.lanes.length).toBeGreaterThan(0);

    // prs — the empty enrollment answers ok with zero repos, no spawn.
    expect(body.prs).toMatchObject({ state: 'ok', repos: 0, open: [] });

    // leader — nothing seeded under the tmp HOME degrades honestly.
    expect(body.leader.state).toBe('unknown');
    expect(body.leader.reason).toBe('missing');

    expect(body.state).toBe('degraded');
  });

  it('POST /api/wb/v1/fleet → 405', async () => {
    const { res, out } = fakeResponse();
    const handled = await handleWbApi(req('POST'), res, makeConfig(), WB_FLEET_PATH, {});
    expect(handled).toBe(true);
    expect(out.status).toBe(405);
  });

  it('empty queue dir answers unknown/missing — nothing fabricated', async () => {
    const view = await buildWorkbenchFleetView(makeConfig(), {
      queueDir,
      paths: () => [],
    });
    expect(view.jobs).toMatchObject({
      state: 'unknown',
      reason: 'missing',
      counts: { live: 0, ready: 0, total: 0 },
      jobs: [],
    });
    expect(view.lanes.state).toBe('ok');
    for (const lane of view.lanes.lanes) {
      expect(lane.queueDepth).toBeNull();
      expect(lane.liveJobs).toBeNull();
    }
  });
});

describe('queue.v1 row projection consumed by the view', () => {
  it('parseQueueV1Document serves validated rows with bounded summaries', () => {
    const read = parseQueueV1Document(JSON.stringify({
      schema: 'queue.v1',
      jobs: [
        { id: 'RQ-1', status: 'claimed', pool: 'devin', repo: 'phantom', tier: 'work', priority: 'P0', task: 'first line\nsecond line' },
        { id: 'RQ-2', status: 'READY', pool: 'devin' },
      ],
    }));
    expect(read.rows).toHaveLength(2);
    expect(read.rows[0]).toMatchObject({
      id: 'RQ-1', status: 'CLAIMED', pool: 'devin', repo: 'phantom', summary: 'first line',
    });
    expect(read.rows[1].summary).toBeUndefined();
    expect(isLiveQueueStatus('claimed')).toBe(true);
    expect(isLiveQueueStatus('ready')).toBe(false);
  });

  it('a malformed job row throws — never silently passes', () => {
    expect(() => parseQueueV1Document(JSON.stringify({
      schema: 'queue.v1',
      jobs: [{ id: 'RQ-1', status: 'READY', pool: '!! not a lane' }],
    }))).toThrow('invalid queue.v1 job');
  });
});
