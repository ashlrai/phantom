/**
 * workbench-fleet-view.test.ts — GET /api/wb/v1/fleet coverage.
 *
 * The composite live workbench read for the desktop native shell
 * (desktop/src-tauri Fleet tab):
 *
 *   - 401 without a token: it is an /api/* GET, so the read-session boundary
 *     in server.ts denies it before handleApi is reached.
 *   - EMPTY state: no queue files, no leader store, a failing gh read —
 *     every section answers `unknown` with a named reason; nothing is
 *     fabricated.
 *   - BUSY state: seeded queue.v1.json + ready.tsv + usage journal + a
 *     leader state/memo + gh PRs — every section answers `ok` with its
 *     projected rows; queue.v1 wins on id conflicts and ready.tsv-only jobs
 *     still surface.
 *   - STALE state: a cached gh read older than its TTL is served with
 *     `stale: true` + `ageMs` — never silently presented as fresh; an old
 *     leader run still answers with its real timestamps.
 *   - Redaction: secret-shaped strings inside queue tasks, TSV titles, PR
 *     titles and memo text are scrubbed to [REDACTED] by sanitizePublicJson.
 *
 * Hermetic: one real loopback server per test over a tmp HOME; the GitHub
 * reader is the only mocked module (the gh subprocess seam).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { AshlrConfig, WebServerHandle, WebServerOptions } from '../src/core/types.js';

// ---------------------------------------------------------------------------
// gh reader seam — the only mocked module (same as wb-read-api.test.ts).
// ---------------------------------------------------------------------------

const ghReadMock = vi.fn<() => Promise<unknown>>();

vi.mock('../src/core/verse/github-repo.js', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../src/core/verse/github-repo.js')>();
  return {
    ...orig,
    readVerseGithubSnapshotAsync: (...args: unknown[]) => ghReadMock(...args),
  };
});

import { startServer as startRealServer } from '../src/core/web/server.js';
import { parseQueueV1Document, isLiveQueueStatus } from '../src/core/fleet/lane-console.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SECRET_PROBE = ['sk', '-FAKE', '-wbFleet', 'Secret9', '0123456789', 'abcdef'].join('');

const QUEUE_V1_BUSY = {
  schema: 'queue.v1',
  jobs: [
    { id: 'RQ-1', status: 'CLAIMED', priority: 'P0', pool: 'devin', tier: 'work', repo: 'phantom', task: 'Fix the flaky wb test' },
    { id: 'RQ-2', status: 'PR-OPEN', priority: 'P1', pool: 'codex-cmp', tier: 'work', repo: 'phantom' },
    { id: 'RQ-3', status: 'READY', priority: 'P1', pool: 'devin', tier: 'work', repo: 'phantom' },
    { id: 'RQ-4', status: 'READY', priority: 'P2', pool: 'grok-ultra', tier: 'work', repo: 'phantom' },
    { id: 'RQ-5', status: 'DONE', priority: 'P1', pool: 'local-omlx', tier: 'work', repo: 'phantom' },
  ],
};

const READY_TSV_BUSY = [
  'id\tstatus\tpool\ttier\trepo\tpriority\ttitle',
  'RQ-1\tCLAIMED\tdevin\twork\tphantom\tP0\tduplicate row — queue.v1 wins',
  'RQ-9\tREADY\tdevin\twork\tphantom\tP2\ttsv-only queued job',
  '',
].join('\n');

const FAKE_GH_BUSY = {
  repos: [
    {
      path: '/tmp/repo',
      name: 'phantom',
      remote: { state: 'github', nameWithOwner: 'ashlrai/phantom' },
      prs: [
        {
          number: 1482,
          title: 'bridge(RQ-FIXUP): smoke fix',
          url: 'https://github.com/ashlrai/phantom/pull/1482',
          state: 'open',
          author: 'devin-ai-integration[bot]',
          draft: false,
          headRefName: 'devin/rq-fixup',
          baseRefName: 'main',
          checks: { state: 'passing', total: 4, passed: 4, failed: 0, pending: 0 },
        },
        {
          number: 1483,
          title: 'wip: fleet lanes',
          url: 'https://github.com/ashlrai/phantom/pull/1483',
          state: 'open',
          author: 'masonwyatt',
          draft: true,
          headRefName: 'mason/lanes',
          baseRefName: 'main',
          checks: { state: 'pending', total: 4, passed: 1, failed: 0, pending: 3 },
        },
      ],
      issues: [],
      listsRequested: true,
      prsAvailable: true,
      issuesAvailable: true,
      observedAt: '2026-10-30T00:00:00.000Z',
      detail: '2 open pull requests, 0 open issues',
    },
  ],
  observedAt: '2026-10-30T00:00:00.000Z',
};

function localDay(ms: number): string {
  const d = new Date(ms);
  const mm = `${d.getMonth() + 1}`.padStart(2, '0');
  const dd = `${d.getDate()}`.padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

/** Minimal valid LeaderRunState (leader.ts readLeaderRunState shape). */
function seedLeaderState(home: string, lastRunAt: string): void {
  const root = path.join(home, '.ashlr', 'vision', 'leader');
  fs.mkdirSync(path.join(root, 'memos'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(root, 'state.json'),
    JSON.stringify({
      v: 1,
      lastRun: { at: lastRunAt, outcome: 'ok', reason: null },
      lastSuccessAt: lastRunAt,
      runDays: { [localDay(Date.parse(lastRunAt))]: 1 },
      lastEvidenceDigest: 'a'.repeat(64),
      lastDeepRunAt: lastRunAt,
      lastMemoAt: lastRunAt,
      baselines: {},
      outcomes: [],
    }) + '\n',
    { mode: 0o600 },
  );
}

/** Minimal valid LeaderMemo (leader-memo.ts isMemoShape: v/id/at/status/actions/goals). */
function seedLeaderMemo(home: string, opts: { id: string; at: string; bottleneck?: string; questions?: string[] }): void {
  const root = path.join(home, '.ashlr', 'vision', 'leader');
  fs.mkdirSync(path.join(root, 'memos'), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(root, 'memos', `${opts.id}.json`),
    JSON.stringify({
      v: 1,
      id: opts.id,
      at: opts.at,
      status: 'ok',
      statusReason: null,
      trigger: 'schedule',
      dryRun: false,
      seatId: 'seat-claude-1',
      model: 'claude-test',
      evidenceDigest: 'b'.repeat(64),
      bottleneck: opts.bottleneck !== undefined
        ? { statement: opts.bottleneck, metric: 'mergeRate', evidence: [] }
        : null,
      move: { statement: 'Raise the merge rate', why: 'It is the bottleneck', expectedDelta: null },
      killList: [],
      goals: [],
      priorityChanges: [],
      standards: [],
      critiques: [],
      seatPlan: [],
      hypotheses: [],
      questionsForMason: opts.questions ?? [],
      actions: [],
    }) + '\n',
    { mode: 0o600 },
  );
}

function seedQueueDir(home: string): string {
  const dir = path.join(home, '.ashlr-runs', 'queue');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'queue.v1.json'), JSON.stringify(QUEUE_V1_BUSY));
  fs.writeFileSync(path.join(dir, 'ready.tsv'), READY_TSV_BUSY);
  fs.writeFileSync(
    path.join(dir, 'jobs.jsonl'),
    `{"job":"RQ-5","pool":"local-omlx","to":"LAND","at":"${new Date().toISOString()}"}\n`,
  );
  fs.writeFileSync(
    path.join(dir, 'usage-readings.log'),
    `${JSON.stringify({ pool: 'devin', pctUsed: 36, resetAt: '2026-11-04T00:00:00Z', fetchedAt: new Date().toISOString() })}\n`,
  );
  return dir;
}

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

interface Response {
  statusCode: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function httpRequest(
  method: string,
  url: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: Number(parsed.port),
        path: parsed.pathname + parsed.search,
        method,
        headers,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
        res.on('end', () =>
          resolve({
            statusCode: res.statusCode ?? 0,
            headers: res.headers as Record<string, string | string[] | undefined>,
            body: data,
          }),
        );
      },
    );
    req.on('error', reject);
    req.end();
  });
}

const hostOf = (h: WebServerHandle) => `127.0.0.1:${h.port}`;
const authHeaders = (h: WebServerHandle) => ({ Host: hostOf(h), 'x-ashlr-token': h.readToken });

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

let openHandles: WebServerHandle[] = [];
let tmpHome: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;
let prevAshlrHome: string | undefined;

beforeEach(() => {
  openHandles = [];
  ghReadMock.mockReset();
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-wb-fleet-'));
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  prevAshlrHome = process.env.ASHLR_HOME;
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  // lane-console's usage-journal fallback prefers ASHLR_HOME over homedir —
  // repoint it too so no shared worker-home file leaks into a reading.
  process.env.ASHLR_HOME = path.join(tmpHome, '.ashlr');
});

afterEach(async () => {
  vi.useRealTimers();
  for (const h of openHandles) {
    try { await h.close(); } catch { /* ignore */ }
  }
  openHandles = [];
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserProfile;
  if (prevAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = prevAshlrHome;
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

async function serve(overrides: Partial<WebServerOptions> = {}): Promise<WebServerHandle> {
  const h = await startRealServer(makeConfig(), { port: 0, open: false, allowDispatch: false, ...overrides },
    { readProjections: null });
  openHandles.push(h);
  return h;
}

const getFleet = (h: WebServerHandle, headers: Record<string, string> = authHeaders(h)) =>
  httpRequest('GET', `${h.url}/api/wb/v1/fleet`, headers);

// ---------------------------------------------------------------------------
// Boundary
// ---------------------------------------------------------------------------

describe('boundary', () => {
  it('GET /api/wb/v1/fleet without a token → 401; with it → 200 v:1 workbench.fleet.v1', async () => {
    const h = await serve();
    ghReadMock.mockResolvedValue({ repos: [], observedAt: new Date().toISOString() });

    const unauth = await getFleet(h, { Host: hostOf(h) });
    expect(unauth.statusCode).toBe(401);
    expect(unauth.body).not.toContain(h.readToken);

    const res = await getFleet(h);
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body);
    expect(body.v).toBe(1);
    expect(body.schema).toBe('workbench.fleet.v1');
    for (const section of ['lanes', 'jobs', 'prs', 'leader']) {
      expect(body[section], section).toBeTruthy();
    }
  });

  it('POST /api/wb/v1/fleet → 405', async () => {
    const h = await serve();
    const res = await httpRequest('POST', `${h.url}/api/wb/v1/fleet`, authHeaders(h));
    expect(res.statusCode).toBe(405);
  });
});

// ---------------------------------------------------------------------------
// Empty state — nothing on disk, gh down
// ---------------------------------------------------------------------------

describe('empty state', () => {
  it('every section answers unknown/empty with a named reason — nothing fabricated', async () => {
    const h = await serve();
    ghReadMock.mockRejectedValue(new Error('gh is down'));

    const res = await getFleet(h);
    const body = JSON.parse(res.body);
    expect(res.statusCode).toBe(200);

    // The lane projection always answers — it reports the known pool roster
    // (BUDGET_POOLS) with every reading null, and per-source health says why.
    expect(body.lanes.state).toBe('ok');
    expect(body.lanes.lanes.length).toBeGreaterThan(0);
    for (const lane of body.lanes.lanes) {
      expect(lane.queueDepth).toBeNull();
      expect(lane.liveJobs).toBeNull();
      expect(lane.credit.state).toBe('unknown');
    }
    expect(body.lanes.sources.queue.state).toBe('missing');

    expect(body.jobs.state).toBe('unknown');
    expect(body.jobs.reason).toBe('missing');
    expect(body.jobs.jobs).toEqual([]);
    expect(body.jobs.counts).toEqual({ live: 0, ready: 0, total: 0 });

    expect(body.prs.state).toBe('unknown');
    expect(body.prs.reason).toBe('unavailable');
    expect(body.prs.open).toEqual([]);

    expect(body.leader.state).toBe('unknown');
    expect(body.leader.reason).toBe('missing');
    expect(body.leader.latest).toBeNull();
    expect(body.leader.health).toBeNull();

    expect(body.state).toBe('degraded');
  });
});

// ---------------------------------------------------------------------------
// Busy state — seeded queue, leader store and gh read
// ---------------------------------------------------------------------------

describe('busy state', () => {
  it('all four sections answer ok with projected data', async () => {
    seedQueueDir(tmpHome);
    const nowIso = new Date().toISOString();
    seedLeaderState(tmpHome, nowIso);
    seedLeaderMemo(tmpHome, {
      id: 'lm-20261030120000-abc123',
      at: nowIso,
      bottleneck: 'Merge rate is the bottleneck',
      questions: ['Ship the lanes tab?'],
    });
    ghReadMock.mockResolvedValue(FAKE_GH_BUSY);

    const h = await serve();
    const res = await getFleet(h);
    const body = JSON.parse(res.body);
    expect(res.statusCode).toBe(200);
    expect(body.state).toBe('ok');

    // lanes — seeded queue gives devin depth + live jobs and credit.
    const devin = body.lanes.lanes.find((l: { lane: string }) => l.lane === 'devin');
    expect(devin).toBeTruthy();
    expect(devin.liveJobs).toBe(1);
    expect(devin.queueDepth).toBeGreaterThanOrEqual(1);
    expect(devin.credit.state).toBe('observed');

    // jobs — queue.v1 authoritative, ready.tsv extra merged, dup deduped.
    expect(body.jobs.state).toBe('ok');
    expect(body.jobs.counts.live).toBe(2);            // CLAIMED + PR-OPEN
    expect(body.jobs.counts.ready).toBe(3);           // 2 queue.v1 + RQ-9
    const ids = body.jobs.jobs.map((j: { id: string }) => j.id);
    expect(ids.filter((id: string) => id === 'RQ-1')).toHaveLength(1);
    expect(ids).toContain('RQ-9');
    const rq1 = body.jobs.jobs.find((j: { id: string }) => j.id === 'RQ-1');
    expect(rq1.source).toBe('queue.v1');
    expect(rq1.live).toBe(true);
    expect(rq1.summary).toBe('Fix the flaky wb test');
    const rq9 = body.jobs.jobs.find((j: { id: string }) => j.id === 'RQ-9');
    expect(rq9.source).toBe('ready.tsv');
    expect(rq9.summary).toBe('tsv-only queued job');

    // prs — flattened across repos with check rollups.
    expect(body.prs.state).toBe('ok');
    expect(body.prs.stale).toBe(false);
    expect(body.prs.open).toHaveLength(2);
    expect(body.prs.open[0]).toMatchObject({
      repo: 'phantom',
      nameWithOwner: 'ashlrai/phantom',
      number: 1482,
      draft: false,
      checks: { state: 'passing' },
    });

    // leader — state + memo surfaced as a compact projection.
    expect(body.leader.state).toBe('ok');
    expect(body.leader.latest).toMatchObject({
      id: 'lm-20261030120000-abc123',
      status: 'ok',
      bottleneck: 'Merge rate is the bottleneck',
    });
    expect(body.leader.openQuestions).toBe(1);
    expect(body.leader.pendingActions).toBe(0);
    expect(['healthy', 'degraded', 'down', 'unknown']).toContain(body.leader.health.status);
  });

  it('queue.v1 wins over a conflicting ready.tsv row for the same job id', async () => {
    const dir = path.join(tmpHome, '.ashlr-runs', 'queue');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'queue.v1.json'),
      JSON.stringify({ schema: 'queue.v1', jobs: [{ id: 'RQ-7', status: 'CLAIMED', pool: 'devin' }] }),
    );
    fs.writeFileSync(
      path.join(dir, 'ready.tsv'),
      'RQ-7\tREADY\tdevin\twork\tphantom\tP1\tstale tsv copy\n',
    );
    ghReadMock.mockRejectedValue(new Error('gh is down'));

    const h = await serve();
    const body = JSON.parse((await getFleet(h)).body);
    expect(body.jobs.jobs).toHaveLength(1);
    expect(body.jobs.jobs[0]).toMatchObject({ id: 'RQ-7', status: 'CLAIMED', source: 'queue.v1' });
  });

  it('malformed queue.v1 degrades only its own source — ready.tsv still answers', async () => {
    const dir = path.join(tmpHome, '.ashlr-runs', 'queue');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'queue.v1.json'), '{not json\n');
    fs.writeFileSync(path.join(dir, 'ready.tsv'), 'RQ-2\tREADY\tdevin\twork\tphantom\tP1\tqueued\n');
    ghReadMock.mockRejectedValue(new Error('gh is down'));

    const h = await serve();
    const body = JSON.parse((await getFleet(h)).body);
    expect(body.jobs.state).toBe('ok');
    expect(body.jobs.sources).toEqual({ queueV1: 'invalid', readyTsv: 'ok' });
    expect(body.jobs.jobs).toHaveLength(1);
    expect(body.jobs.jobs[0].id).toBe('RQ-2');
  });
});

// ---------------------------------------------------------------------------
// Stale state — old data is never presented as fresh
// ---------------------------------------------------------------------------

describe('stale state', () => {
  it('a cached gh read past its TTL is served stale:true with ageMs', async () => {
    ghReadMock.mockResolvedValue(FAKE_GH_BUSY);
    const h = await serve();

    const first = await getFleet(h);
    const body1 = JSON.parse(first.body);
    expect(body1.prs.state).toBe('ok');
    expect(body1.prs.stale).toBe(false);

    // Advance past the 60 s wb gh TTL (Date only — sockets keep real timers).
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 61_000);
    try {
      const second = await getFleet(h);
      const body2 = JSON.parse(second.body);
      expect(body2.prs.state).toBe('ok');
      expect(body2.prs.stale).toBe(true);
      expect(body2.prs.ageMs).toBeGreaterThanOrEqual(61_000);
      expect(body2.prs.open).toHaveLength(2); // last good value still served
    } finally {
      vi.useRealTimers();
    }
  });

  it('queue files report their mtime as observedAt — freshness travels with the data', async () => {
    const dir = path.join(tmpHome, '.ashlr-runs', 'queue');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'queue.v1.json'),
      JSON.stringify({ schema: 'queue.v1', jobs: [{ id: 'RQ-1', status: 'READY', pool: 'devin' }] }),
    );
    const old = new Date(Date.now() - 45 * 60_000);
    fs.utimesSync(path.join(dir, 'queue.v1.json'), old, old);
    ghReadMock.mockRejectedValue(new Error('gh is down'));

    const h = await serve();
    const body = JSON.parse((await getFleet(h)).body);
    expect(body.jobs.state).toBe('ok');
    expect(Date.parse(body.jobs.observedAt)).toBeLessThanOrEqual(old.getTime() + 1000);
  });

  it('an old leader run surfaces with its real timestamps, never as fresh', async () => {
    const old = new Date(Date.now() - 8 * 24 * 60 * 60_000).toISOString();
    seedLeaderState(tmpHome, old);
    ghReadMock.mockRejectedValue(new Error('gh is down'));

    const h = await serve();
    const body = JSON.parse((await getFleet(h)).body);
    expect(body.leader.state).toBe('ok');
    expect(body.leader.lastRun.at).toBe(old);
    expect(['degraded', 'down', 'unknown']).toContain(body.leader.health.status);
  });
});

// ---------------------------------------------------------------------------
// Redaction — secret-shaped fixture data never comes back verbatim
// ---------------------------------------------------------------------------

describe('redaction of secret-shaped input', () => {
  it('secrets in a job task, a PR title and memo text are all scrubbed', async () => {
    const dir = path.join(tmpHome, '.ashlr-runs', 'queue');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'queue.v1.json'),
      JSON.stringify({
        schema: 'queue.v1',
        jobs: [{ id: 'RQ-1', status: 'READY', pool: 'devin', task: `rotate key ${SECRET_PROBE}` }],
      }),
    );
    seedLeaderState(tmpHome, new Date().toISOString());
    seedLeaderMemo(tmpHome, {
      id: 'lm-20261030120000-abc123',
      at: new Date().toISOString(),
      bottleneck: `bottleneck is ${SECRET_PROBE}`,
    });
    ghReadMock.mockResolvedValue({
      repos: [{
        ...FAKE_GH_BUSY.repos[0],
        prs: [{ ...FAKE_GH_BUSY.repos[0]!.prs[0]!, title: `hotfix ${SECRET_PROBE}` }],
      }],
      observedAt: '2026-10-30T00:00:00.000Z',
    });

    const h = await serve();
    const res = await getFleet(h);
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(SECRET_PROBE);
    expect(res.body).toContain('[REDACTED]');
    const body = JSON.parse(res.body);
    expect(body.jobs.jobs[0].summary).toContain('[REDACTED]');
    expect(body.prs.open[0].title).toContain('[REDACTED]');
    expect(body.leader.latest.bottleneck).toContain('[REDACTED]');
  });
});

// ---------------------------------------------------------------------------
// lane-console row projection (the queue.v1 jobs this view reuses)
// ---------------------------------------------------------------------------

describe('queue.v1 row projection', () => {
  it('parseQueueV1Document carries validated rows with bounded summaries', () => {
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
});
