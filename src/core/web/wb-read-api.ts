/**
 * core/web/wb-read-api.ts — `GET /api/wb/v1/*` (loopback read API for the
 * desktop native shell; desktop/src-tauri/src/fleet_ops.rs is the consumer).
 *
 *   GET /api/wb/v1/snapshot → persisted fleet capacity snapshot
 *                             (~/.ashlr/routing/capacity.json), honest about
 *                             staleness: missing/invalid/stale → `unknown`
 *   GET /api/wb/v1/gh       → GitHub read across enrolled repos, behind the
 *                             shared single-flight cache + failure backoff
 *                             (web/fleet-status-cache.ts getCachedWbGhStatus)
 *   GET /api/wb/v1/budget   → budget policy + per-seat usage projection
 *   GET /api/wb/v1/fleet    → composite live fleet workbench view (lanes,
 *                             jobs, PRs, leader state — see
 *                             workbench-fleet-view.ts)
 *
 * Auth: identical to every other read route — these paths are `/api/*` GETs,
 * so server.ts's read-session boundary (X-Ashlr-Token or a minted read
 * cookie) gates them BEFORE handleApi is called. There is no mutation here.
 *
 * Honesty discipline (same as the rest of the web layer): this API never
 * presents old data as current. `state: 'unknown'` + `reason` names what was
 * actually observed; cached answers carry `stale`/`ageMs`; a cold failure
 * answers `unknown`, never a crash-shaped 500.
 *
 * Redaction: every body goes through sanitizePublicJson — secret-shaped
 * strings (a label, a detail sentence, fixture data seeded by tests) come
 * back `[REDACTED]`, never verbatim.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { existsSync } from 'node:fs';

import type { AshlrConfig } from '../types.js';
import { sanitizePublicJson } from '../util/public-json.js';
import {
  capacitySnapshotPath,
  loadBudgetPolicy,
  readCapacitySnapshot,
  type CapacitySnapshot,
} from '../routing/budget-store.js';
import type { SeatCapacity } from '../routing/headroom.js';
import { listEnrolled } from '../sandbox/policy.js';
import {
  readVerseGithubSnapshotAsync,
  type VerseGithubReadOptions,
} from '../verse/github-repo.js';
import type { VerseGithubSnapshot } from '../verse/github-types.js';
import { getCachedWbGhStatus } from './fleet-status-cache.js';
import { sendJson } from './read-session.js';
import {
  handleWbFleetView,
  WB_FLEET_PATH,
  type WorkbenchFleetViewDeps,
} from './workbench-fleet-view.js';

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const WB_SNAPSHOT_PATH = '/api/wb/v1/snapshot';
export const WB_GH_PATH = '/api/wb/v1/gh';
export const WB_BUDGET_PATH = '/api/wb/v1/budget';
export { WB_FLEET_PATH };

const WB_ROUTES = new Set([WB_SNAPSHOT_PATH, WB_GH_PATH, WB_BUDGET_PATH, WB_FLEET_PATH]);

/** True for every `/api/wb/v1/*` path — handled (or 404d) by this module. */
export function isWbApiPath(path: string): boolean {
  return path.startsWith('/api/wb/v1/') || path === '/api/wb/v1';
}

// ---------------------------------------------------------------------------
// Snapshot honesty
// ---------------------------------------------------------------------------

/**
 * The capacity publisher rewrites the snapshot about once a minute while a
 * collector is alive (budget-api.ts BUDGET_PUBLISH_DEFAULT_MS). Ten minutes
 * is ~10× that cadence — comfortably past "between publishes", firmly before
 * "hours-old data served as live".
 */
const WB_SNAPSHOT_STALE_MS = 10 * 60_000;

type WbStateReason = 'missing' | 'invalid' | 'stale' | 'unavailable';

interface WbSeatRow {
  seatId: string;
  engine: string;
  label: string;
  free: boolean;
  signedOut: boolean;
  reachable: boolean | null;
  spentTodayUsd: number | null;
  observedAt: string | null;
  windows: SeatCapacity['windows'];
}

interface WbSnapshotReading {
  state: 'ok' | 'unknown';
  reason: WbStateReason | null;
  publishedAt: string | null;
  ageMs: number | null;
  seats: SeatCapacity[];
}

function projectSeat(seat: SeatCapacity): WbSeatRow {
  return {
    seatId: seat.seatId,
    engine: seat.engine,
    label: seat.label,
    free: seat.free,
    signedOut: seat.signedOut,
    reachable: seat.reachable,
    spentTodayUsd: seat.spentTodayUsd,
    observedAt: seat.observedAt,
    windows: seat.windows,
  };
}

/**
 * Read the persisted capacity snapshot with its freshness honoured.
 *
 *   fresh     → state 'ok' + the seat roster
 *   stale     → state 'unknown', reason 'stale'  (old data is not live data)
 *   absent    → state 'unknown', reason 'missing'
 *   unreadable/malformed → state 'unknown', reason 'invalid'
 *
 * `readCapacitySnapshot` collapses absent/unreadable/malformed into null, so
 * the file's existence distinguishes 'missing' from 'invalid' for the wire.
 */
function readWbSnapshot(file: string = capacitySnapshotPath()): WbSnapshotReading {
  const snap: CapacitySnapshot | null = readCapacitySnapshot(file);
  if (!snap) {
    return {
      state: 'unknown',
      reason: existsSync(file) ? 'invalid' : 'missing',
      publishedAt: null,
      ageMs: null,
      seats: [],
    };
  }
  const publishedMs = Date.parse(snap.publishedAt);
  const ageMs = Number.isFinite(publishedMs) ? Math.max(0, Date.now() - publishedMs) : null;
  if (ageMs === null || ageMs > WB_SNAPSHOT_STALE_MS) {
    return {
      state: 'unknown',
      reason: 'stale',
      publishedAt: snap.publishedAt,
      ageMs,
      seats: [],
    };
  }
  return {
    state: 'ok',
    reason: null,
    publishedAt: snap.publishedAt,
    ageMs,
    seats: snap.seats,
  };
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function handleWbSnapshot(res: ServerResponse): void {
  const reading = readWbSnapshot();
  sendJson(res, 200, sanitizePublicJson({
    v: 1,
    state: reading.state,
    reason: reading.reason,
    publishedAt: reading.publishedAt,
    ageMs: reading.ageMs,
    seats: reading.seats.map(projectSeat),
  }));
}

interface WbGhDeps {
  /** Enrolled repo paths to read; default is the enrollment registry. */
  paths?: () => string[];
  /** Test seam for the gh subprocess runner (github-repo.ts options). */
  gh?: VerseGithubReadOptions['gh'];
}

async function handleWbGh(
  cfg: AshlrConfig,
  res: ServerResponse,
  deps: WbGhDeps = {},
): Promise<void> {
  const paths = deps.paths?.() ?? listEnrolled();
  const readOptions: VerseGithubReadOptions = deps.gh ? { gh: deps.gh } : {};
  const { value, stale, ageMs, backoff } = await getCachedWbGhStatus<VerseGithubSnapshot>(
    cfg,
    () => readVerseGithubSnapshotAsync(paths, readOptions),
  );

  if (!value) {
    // Nothing ever fetched (cold + the fetch failed). Honest 'unknown' — the
    // backoff window is open, so retrying now would just re-break.
    sendJson(res, 200, sanitizePublicJson({
      v: 1,
      state: 'unknown',
      reason: 'unavailable',
      repos: [],
      observedAt: null,
      stale: true,
      ageMs: null,
      backoff,
    }));
    return;
  }

  sendJson(res, 200, sanitizePublicJson({
    v: 1,
    state: 'ok',
    reason: null,
    repos: value.repos,
    observedAt: value.observedAt,
    stale,
    ageMs,
    backoff,
  }));
}

function handleWbBudget(res: ServerResponse): void {
  // The operator's policy always answers (defaults when the file is absent) —
  // it is config, not collected evidence, so it never goes 'unknown'.
  const policy = loadBudgetPolicy();
  const reading = readWbSnapshot();
  const spent = reading.seats.reduce<number | null>((sum, seat) => {
    if (seat.spentTodayUsd === null) return sum;
    return (sum ?? 0) + seat.spentTodayUsd;
  }, null);

  sendJson(res, 200, sanitizePublicJson({
    v: 1,
    state: reading.state,
    reason: reading.reason,
    publishedAt: reading.publishedAt,
    ageMs: reading.ageMs,
    policy: {
      mode: policy.mode,
      updatedAt: policy.updatedAt,
      seats: Object.keys(policy.seats),
    },
    spentTodayUsd: spent,
    seats: reading.seats.map(projectSeat),
  }));
}

/**
 * Dispatch `/api/wb/v1/*` routes. GET-only; unknown subpaths 404, wrong
 * methods 405. Returns true when the path belonged to this surface.
 */
export async function handleWbApi(
  req: IncomingMessage,
  res: ServerResponse,
  cfg: AshlrConfig,
  path: string,
  deps: WorkbenchFleetViewDeps = {},
): Promise<boolean> {
  if (!isWbApiPath(path)) return false;

  if (!WB_ROUTES.has(path)) {
    sendJson(res, 404, { error: `not found: GET ${path}` });
    return true;
  }
  const method = (req.method ?? 'GET').toUpperCase();
  if (method !== 'GET') {
    sendJson(res, 405, { error: 'method not allowed' }, { Allow: 'GET' });
    return true;
  }

  if (path === WB_SNAPSHOT_PATH) {
    handleWbSnapshot(res);
  } else if (path === WB_GH_PATH) {
    await handleWbGh(cfg, res, deps);
  } else if (path === WB_FLEET_PATH) {
    await handleWbFleetView(res, cfg, deps);
  } else {
    handleWbBudget(res);
  }
  return true;
}
