/**
 * core/web/workbench-fleet-view.ts — `GET /api/wb/v1/fleet`: the live fleet
 * workbench projection for the desktop native shell (desktop/src-tauri Fleet
 * tab). One composite read that answers what the workbench shows at a glance:
 *
 *   lanes   — per-lane queue depth, live jobs, merges/hour and credit, from
 *             fleet/lane-console.ts's fleet.lanes.v1 snapshot (same
 *             projection as GET /api/fleet/lanes and `phm fleet lanes`).
 *   jobs    — the merged live+ready job list from the router queue dir:
 *             queue.v1.json is authoritative where present; ready.tsv rows
 *             fill in jobs the document does not track.
 *   prs     — open pull requests across enrolled repos, behind the shared
 *             single-flight cache + failure backoff (fleet-status-cache.ts
 *             getCachedWbGhStatus) so a workbench poll and a /api/wb/v1/gh
 *             poll share one gh read and never multiply a broken spawn.
 *   leader  — the Leader's run state, health, latest memo summary and pending
 *             action count, from vision/leader.ts buildLeaderState (the same
 *             state GET /api/verse/leader serves).
 *
 * Auth: identical to the other wb routes — `/api/*` GET, gated by the
 * read-session boundary in server.ts before handleApi is called. GET-only.
 *
 * Honesty discipline (same as the rest of the web layer): a missing or
 * malformed input degrades only its own section to `unknown` with a named
 * reason — the view never fabricates zeros and never presents old data as
 * current (`stale`/`ageMs`/`observedAt` travel with the sections that have a
 * freshness concept). Top-level `state` is 'ok' when every section answered,
 * 'degraded' when some did, 'unknown' when none did.
 *
 * Redaction: the whole body goes through sanitizePublicJson — a job task or
 * PR title carrying a secret-shaped string comes back `[REDACTED]`, never
 * verbatim. Absolute host paths do not leave this module (queue files are
 * read, never named; repo identity is nameWithOwner).
 */

import { existsSync } from 'node:fs';
import { readFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { ServerResponse } from 'node:http';

import type { AshlrConfig } from '../types.js';
import { sanitizePublicJson } from '../util/public-json.js';
import {
  getFleetLaneSnapshot,
  isLiveQueueStatus,
  parseQueueV1Document,
  parseReadyTsv,
  type FleetLaneSnapshot,
  type FleetLaneQueueRow,
} from '../fleet/lane-console.js';
import { listEnrolled } from '../sandbox/policy.js';
import {
  readVerseGithubSnapshotAsync,
  type VerseGithubReadOptions,
} from '../verse/github-repo.js';
import type { VerseGithubSnapshot } from '../verse/github-types.js';
import { getCachedWbGhStatus } from './fleet-status-cache.js';
import { sendJson } from './read-session.js';

export const WB_FLEET_PATH = '/api/wb/v1/fleet';

// ---------------------------------------------------------------------------
// Wire types — workbench.fleet.v1
// ---------------------------------------------------------------------------

type SectionState = 'ok' | 'unknown';
type FileReadState = 'ok' | 'missing' | 'invalid';

export interface WorkbenchLaneView {
  lane: string;
  queueDepth: number | null;
  liveJobs: number | null;
  mergesPerHour: number | null;
  credit: FleetLaneSnapshot['lanes'][number]['credit'];
}

export interface WorkbenchLanesSection {
  /** 'unavailable' only when the lane projection itself threw. */
  state: 'ok' | 'unavailable';
  generatedAt: string | null;
  mergeWindowMinutes: number | null;
  lanes: WorkbenchLaneView[];
  /** Per-input health from the lane snapshot (basenames only, by contract). */
  sources: FleetLaneSnapshot['sources'] | null;
}

export interface WorkbenchJobRow {
  id: string | null;
  /** Normalized uppercase status. */
  status: string;
  pool: string;
  repo: string | null;
  tier: string | null;
  priority: string | null;
  /** Bounded single-line preview (title or task's first line); never full text. */
  summary: string | null;
  /** Row timestamp when the source carries one (ready.tsv). */
  at: string | null;
  /** True when the status occupies a lane slot right now. */
  live: boolean;
  source: 'queue.v1' | 'ready.tsv';
}

export interface WorkbenchJobsSection {
  state: SectionState;
  /** 'missing' = no queue files exist; 'invalid' = files exist, none parsed. */
  reason: 'missing' | 'invalid' | null;
  sources: { queueV1: FileReadState; readyTsv: FileReadState };
  /** Mtime of the freshest queue file read — the section's freshness evidence. */
  observedAt: string | null;
  /** Source rows that could not be attributed to a lane and were dropped. */
  dropped: number;
  counts: { live: number; ready: number; total: number };
  jobs: WorkbenchJobRow[];
}

export interface WorkbenchPrRow {
  /** Repo basename on disk. */
  repo: string;
  /** `owner/name` when the remote resolved; null otherwise. */
  nameWithOwner: string | null;
  number: number;
  title: string;
  url: string;
  author: string;
  draft: boolean;
  head: string | null;
  base: string | null;
  checks: VerseGithubSnapshot['repos'][number]['prs'][number]['checks'];
}

export interface WorkbenchPrsSection {
  state: SectionState;
  /** 'unavailable' = no gh read has ever succeeded on this cfg. */
  reason: 'unavailable' | null;
  /** True when the cached read is past its TTL (a refresh may be in flight). */
  stale: boolean;
  ageMs: number | null;
  /** True when answered inside the failure-backoff window — no fetch attempted. */
  backoff: boolean;
  observedAt: string | null;
  /** Enrolled repos the gh read covered. */
  repos: number;
  open: WorkbenchPrRow[];
}

export interface WorkbenchLeaderSection {
  state: SectionState;
  /** 'missing' = no leader state or memos on disk; 'unavailable' = the build threw. */
  reason: 'missing' | 'unavailable' | null;
  generatedAt: string | null;
  health: {
    status: 'healthy' | 'degraded' | 'down' | 'unknown';
    summary: string;
    lastRunAt: string | null;
    nextDueAt: string | null;
    nextDueReason: string | null;
    consecutiveFailures: number;
    servedBy: { seatId: string; model: string | null; at: string } | null;
  } | null;
  lastRun: { at: string; outcome: string; reason: string | null } | null;
  nextRunAt: string | null;
  runsToday: number | null;
  /** Newest memo, projected to its summary — never the full memo. */
  latest: {
    id: string;
    at: string;
    status: string;
    bottleneck: string | null;
    move: string | null;
    actionCount: number;
  } | null;
  /** Actions whose status is 'scheduled' or 'escalated' — the ones still open. */
  pendingActions: number | null;
  /** Open questions on the newest memo. */
  openQuestions: number;
  directives: {
    updatedAt: string;
    grokLanes: number | null;
    codexEnabled: boolean | null;
    hasRouterTuning: boolean;
  } | null;
}

export interface WorkbenchFleetView {
  v: 1;
  schema: 'workbench.fleet.v1';
  generatedAt: string;
  /** 'ok' = every section answered; 'degraded' = some did; 'unknown' = none did. */
  state: 'ok' | 'degraded' | 'unknown';
  lanes: WorkbenchLanesSection;
  jobs: WorkbenchJobsSection;
  prs: WorkbenchPrsSection;
  leader: WorkbenchLeaderSection;
}

export interface WorkbenchFleetViewDeps {
  /** Router queue directory for lanes + jobs. Default `~/.ashlr-runs/queue`. */
  queueDir?: string;
  /** Enrolled repo paths to read; default is the enrollment registry. */
  paths?: () => string[];
  /** Test seam for the gh subprocess runner (github-repo.ts options). */
  gh?: VerseGithubReadOptions['gh'];
  /** Clock seam for tests. */
  now?: () => number;
}

// ---------------------------------------------------------------------------
// Lanes
// ---------------------------------------------------------------------------

async function lanesSection(queueDir: string | undefined): Promise<WorkbenchLanesSection> {
  const empty: WorkbenchLanesSection = {
    state: 'unavailable', generatedAt: null, mergeWindowMinutes: null, lanes: [], sources: null,
  };
  try {
    const snap = await getFleetLaneSnapshot(queueDir ? { queueDir } : {});
    return {
      state: 'ok',
      generatedAt: snap.generatedAt,
      mergeWindowMinutes: snap.mergeWindowMinutes,
      lanes: snap.lanes.map((l) => ({
        lane: l.lane,
        queueDepth: l.queueDepth,
        liveJobs: l.liveJobs,
        mergesPerHour: l.mergesPerHour,
        credit: l.credit,
      })),
      sources: snap.sources,
    };
  } catch {
    return empty;
  }
}

// ---------------------------------------------------------------------------
// Jobs
// ---------------------------------------------------------------------------

const MAX_QUEUE_FILE_BYTES = 4 * 1024 * 1024;

interface QueueFileRead {
  state: FileReadState;
  text: string | null;
  mtimeMs: number | null;
}

async function readQueueFile(path: string): Promise<QueueFileRead> {
  let info;
  try {
    info = await stat(path);
  } catch (error) {
    return { state: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'invalid', text: null, mtimeMs: null };
  }
  if (!info.isFile() || info.size > MAX_QUEUE_FILE_BYTES) {
    return { state: 'invalid', text: null, mtimeMs: info.mtimeMs };
  }
  try {
    return { state: 'ok', text: await readFile(path, 'utf8'), mtimeMs: info.mtimeMs };
  } catch {
    return { state: 'invalid', text: null, mtimeMs: info.mtimeMs };
  }
}

function projectQueueV1Job(row: {
  id: string; status: string; pool: string;
  repo?: string; tier?: string; priority?: string; summary?: string;
}): WorkbenchJobRow {
  return {
    id: row.id,
    status: row.status,
    pool: row.pool,
    repo: row.repo ?? null,
    tier: row.tier ?? null,
    priority: row.priority ?? null,
    summary: row.summary ?? null,
    at: null,
    live: isLiveQueueStatus(row.status),
    source: 'queue.v1',
  };
}

function projectReadyTsvJob(row: FleetLaneQueueRow): WorkbenchJobRow {
  return {
    id: row.id,
    status: row.status,
    pool: row.pool,
    repo: row.repo ?? null,
    tier: row.tier ?? null,
    priority: row.priority ?? null,
    summary: row.title ?? null,
    at: row.at ?? null,
    live: isLiveQueueStatus(row.status),
    source: 'ready.tsv',
  };
}

async function jobsSection(queueDir: string): Promise<WorkbenchJobsSection> {
  const [queueV1, readyTsv] = await Promise.all([
    readQueueFile(join(queueDir, 'queue.v1.json')),
    readQueueFile(join(queueDir, 'ready.tsv')),
  ]);

  const sources: WorkbenchJobsSection['sources'] = {
    queueV1: queueV1.state,
    readyTsv: readyTsv.state,
  };
  const jobs: WorkbenchJobRow[] = [];
  const seen = new Set<string>();
  let dropped = 0;

  if (queueV1.state === 'ok') {
    try {
      for (const row of parseQueueV1Document(queueV1.text!).rows) {
        jobs.push(projectQueueV1Job(row));
        seen.add(row.id);
      }
    } catch {
      sources.queueV1 = 'invalid';
    }
  }
  if (readyTsv.state === 'ok') {
    const parsed = parseReadyTsv(readyTsv.text!);
    dropped += parsed.dropped;
    for (const row of parsed.rows) {
      // queue.v1 is authoritative where present: its ids win, and id-less TSV
      // rows cannot be deduplicated against it so they stay out.
      if (row.id === null ? sources.queueV1 === 'ok' : seen.has(row.id)) continue;
      jobs.push(projectReadyTsvJob(row));
    }
  }

  const answered = sources.queueV1 === 'ok' || sources.readyTsv === 'ok';
  // Freshness belongs to the data actually served — only ok sources count.
  const mtime = Math.max(
    sources.queueV1 === 'ok' ? queueV1.mtimeMs ?? 0 : 0,
    sources.readyTsv === 'ok' ? readyTsv.mtimeMs ?? 0 : 0,
  );
  const live = jobs.filter((j) => j.live).length;
  const ready = jobs.filter((j) => j.status === 'READY').length;
  return {
    state: answered ? 'ok' : 'unknown',
    reason: answered ? null
      : (sources.queueV1 === 'missing' && sources.readyTsv === 'missing' ? 'missing' : 'invalid'),
    sources,
    observedAt: answered && mtime > 0 ? new Date(mtime).toISOString() : null,
    dropped,
    counts: { live, ready, total: jobs.length },
    jobs,
  };
}

// ---------------------------------------------------------------------------
// PRs
// ---------------------------------------------------------------------------

async function prsSection(cfg: AshlrConfig, deps: WorkbenchFleetViewDeps): Promise<WorkbenchPrsSection> {
  const paths = deps.paths?.() ?? listEnrolled();
  const readOptions: VerseGithubReadOptions = deps.gh ? { gh: deps.gh } : {};
  const { value, stale, ageMs, backoff } = await getCachedWbGhStatus<VerseGithubSnapshot>(
    cfg,
    () => readVerseGithubSnapshotAsync(paths, readOptions),
  );

  if (!value) {
    return {
      state: 'unknown', reason: 'unavailable',
      stale: true, ageMs: null, backoff,
      observedAt: null, repos: 0, open: [],
    };
  }

  const open: WorkbenchPrRow[] = [];
  for (const repo of value.repos) {
    for (const pr of repo.prs) {
      open.push({
        repo: repo.name,
        nameWithOwner: repo.remote.nameWithOwner,
        number: pr.number,
        title: pr.title,
        url: pr.url,
        author: pr.author,
        draft: pr.draft,
        head: pr.headRefName,
        base: pr.baseRefName,
        checks: pr.checks,
      });
    }
  }
  return {
    state: 'ok', reason: null,
    stale, ageMs, backoff,
    observedAt: value.observedAt,
    repos: value.repos.length,
    open,
  };
}

// ---------------------------------------------------------------------------
// Leader
// ---------------------------------------------------------------------------

async function leaderSection(cfg: AshlrConfig, nowMs: number): Promise<WorkbenchLeaderSection> {
  const empty = (reason: 'missing' | 'unavailable'): WorkbenchLeaderSection => ({
    state: 'unknown', reason, generatedAt: null, health: null, lastRun: null,
    nextRunAt: null, runsToday: null, latest: null, pendingActions: null,
    openQuestions: 0, directives: null,
  });
  try {
    // Deferred imports: the Leader module family is heavy and only needed for
    // this section; a load fault degrades the section, never the view.
    const leader = await import('../vision/leader.js');
    const memoStore = await import('../vision/leader-memo.js');
    if (!existsSync(leader.leaderStatePath()) && memoStore.listMemoIds().length === 0) {
      return empty('missing');
    }
    const state = leader.buildLeaderState(nowMs, cfg);
    const health = state.health ?? null;
    const latest = state.timeline[0] ?? null;
    const pending = state.actions.filter(
      (a) => a.status === 'scheduled' || a.status === 'escalated',
    ).length;
    return {
      state: 'ok',
      reason: null,
      generatedAt: state.generatedAt,
      health: health
        ? {
            status: health.status,
            summary: health.summary,
            lastRunAt: health.lastRunAt,
            nextDueAt: health.nextDueAt,
            nextDueReason: health.nextDueReason,
            consecutiveFailures: health.consecutiveFailures,
            servedBy: health.servedBy,
          }
        : null,
      lastRun: state.lastRun,
      nextRunAt: state.nextRunAt,
      runsToday: state.runsToday,
      latest: latest
        ? {
            id: latest.id,
            at: latest.at,
            status: latest.status,
            bottleneck: latest.bottleneck,
            move: latest.move,
            actionCount: latest.actionCount,
          }
        : null,
      pendingActions: pending,
      openQuestions: state.latest?.questionsForMason.length ?? 0,
      directives: state.directives
        ? {
            updatedAt: state.directives.updatedAt,
            grokLanes: state.directives.grokLanes,
            codexEnabled: state.directives.codexEnabled,
            hasRouterTuning: state.directives.routerTuning !== null,
          }
        : null,
    };
  } catch {
    return empty('unavailable');
  }
}

// ---------------------------------------------------------------------------
// View assembly
// ---------------------------------------------------------------------------

/**
 * Build the composite workbench view. Never throws: every section is
 * independently guarded, so one broken input degrades its own slice only.
 */
export async function buildWorkbenchFleetView(
  cfg: AshlrConfig,
  deps: WorkbenchFleetViewDeps = {},
): Promise<WorkbenchFleetView> {
  const nowMs = deps.now?.() ?? Date.now();
  const queueDir = deps.queueDir ?? join(homedir(), '.ashlr-runs', 'queue');

  const [lanes, jobs, prs, leader] = await Promise.all([
    lanesSection(deps.queueDir),
    jobsSection(queueDir),
    prsSection(cfg, deps),
    leaderSection(cfg, nowMs),
  ]);

  const answered = [lanes.state, jobs.state, prs.state, leader.state]
    .filter((s) => s === 'ok').length;
  return {
    v: 1,
    schema: 'workbench.fleet.v1',
    generatedAt: new Date(nowMs).toISOString(),
    state: answered === 4 ? 'ok' : answered === 0 ? 'unknown' : 'degraded',
    lanes,
    jobs,
    prs,
    leader,
  };
}

/**
 * `GET /api/wb/v1/fleet` — mounted through wb-read-api.ts's route table.
 */
export async function handleWbFleetView(
  res: ServerResponse,
  cfg: AshlrConfig,
  deps: WorkbenchFleetViewDeps = {},
): Promise<void> {
  sendJson(res, 200, sanitizePublicJson(await buildWorkbenchFleetView(cfg, deps)));
}
