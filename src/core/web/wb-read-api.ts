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
import { homedir } from 'node:os';
import { join } from 'node:path';

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
import { readWorkbenchSecrets } from '../workbench/secrets.js';
import { fleetInventoryPath, readFleetInventory } from '../fleet/graph-seed.js';
import { QueueStore } from '../queue/store.js';
import { sendJson } from './read-session.js';

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export const WB_SNAPSHOT_PATH = '/api/wb/v1/snapshot';
export const WB_GH_PATH = '/api/wb/v1/gh';
export const WB_BUDGET_PATH = '/api/wb/v1/budget';
export const WB_SECRETS_PATH = '/api/wb/v1/secrets';
export const WB_STEER_PATH = '/api/wb/v1/steer';

const WB_ROUTES = new Set([WB_SNAPSHOT_PATH, WB_GH_PATH, WB_BUDGET_PATH, WB_SECRETS_PATH, WB_STEER_PATH]);

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

// ---------------------------------------------------------------------------
// GET /api/wb/v1/steer — the agent steer pane's read
// ---------------------------------------------------------------------------

/**
 * One composite read for the desktop steer pane: the fleet.v1 roster slice
 * (the #945 adapter's source), the public seat list, and the queue lines a
 * reprioritize acts on. Every source reports its own state — a missing
 * fleet.json is 'missing', never an empty roster.
 *
 * Projection is allowlist-only: agents carry the adapter's five fields with
 * `claim_id` reduced to a presence marker (lease ids stay on the host), pools
 * carry id + shared_with, and queue lines carry id, status, priority, pool,
 * tier and a bounded scope. sanitizePublicJson still runs over the whole body.
 */
export interface WbSteerDeps {
  /** fleet.json location; defaults to {@link fleetInventoryPath}. */
  fleetPath?: string;
  /** The public seat inventory; defaults to `discoverSeats(cfg).seats`. */
  listSeats?: (cfg: AshlrConfig) => Promise<readonly unknown[]> | readonly unknown[];
  /** queue.v1 directory parent; defaults to ASHLR_RUNS_DIR or ~/.ashlr-runs. */
  runsDir?: string;
}

type WbSteerSourceState = 'ok' | 'missing' | 'malformed' | 'too-large' | 'unreadable' | 'unavailable' | 'not-fleet-v1';

const WB_STEER_MAX_AGENTS = 1_000;
const WB_STEER_MAX_TEXT = 240;

const wbRecord = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const wbText = (value: unknown, max = WB_STEER_MAX_TEXT): string | null =>
  typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;

function projectFleetAgent(raw: unknown): Record<string, unknown> | null {
  const row = wbRecord(raw);
  const agent = wbText(row?.agent, 160);
  if (!row || !agent) return null;
  return {
    agent,
    repo: wbText(row.repo),
    task: wbText(row.task),
    // Presence marker only: the adapter needs claimed-or-not, never the lease id.
    claim_id: typeof row.claim_id === 'string' ? 'present' : null,
    expires_at: wbText(row.expires_at, 60),
  };
}

function projectFleetPool(raw: unknown): Record<string, unknown> | null {
  const row = wbRecord(raw);
  const id = wbText(row?.id, 80);
  if (!row || !id) return null;
  return { id, shared_with: wbText(row.shared_with, 80) };
}

function projectFleetSteer(read: ReturnType<typeof readFleetInventory>): { fleet: Record<string, unknown> | null; fleetState: WbSteerSourceState } {
  if (!read.ok) return { fleet: null, fleetState: read.reason === 'malformed' ? 'malformed' : read.reason === 'too-large' ? 'too-large' : read.reason === 'unreadable' ? 'unreadable' : 'missing' };
  const doc = wbRecord(read.inventory);
  if (!doc || doc.schema !== 'fleet.v1') return { fleet: null, fleetState: 'not-fleet-v1' };
  const generatedAt = wbText(doc.generated_at, 60);
  if (!generatedAt) return { fleet: null, fleetState: 'not-fleet-v1' };
  return {
    fleetState: 'ok',
    fleet: {
      schema: 'fleet.v1',
      generated_at: generatedAt,
      agents: (Array.isArray(doc.agents) ? doc.agents : []).slice(0, WB_STEER_MAX_AGENTS).map(projectFleetAgent).filter((row): row is Record<string, unknown> => row !== null),
      pools: (Array.isArray(doc.pools) ? doc.pools : []).map(projectFleetPool).filter((row): row is Record<string, unknown> => row !== null),
    },
  };
}

async function readWbQueue(runsDir: string): Promise<{ queue: Record<string, unknown>[]; queueState: 'ok' | 'unavailable' }> {
  try {
    const doc = await new QueueStore(join(runsDir, 'queue')).read();
    return {
      queueState: 'ok',
      queue: doc.jobs.map(job => ({ id: job.id, status: job.status, priority: job.priority, pool: job.pool, tier: job.tier, scope: job.scope.slice(0, WB_STEER_MAX_TEXT) })),
    };
  } catch {
    return { queue: [], queueState: 'unavailable' };
  }
}

async function handleWbSteer(cfg: AshlrConfig, res: ServerResponse, deps: WbSteerDeps = {}): Promise<void> {
  const { fleet, fleetState } = projectFleetSteer(readFleetInventory(deps.fleetPath ?? fleetInventoryPath()));
  const runsDir = deps.runsDir ?? process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs');
  const [queueRead, seats] = await Promise.all([
    readWbQueue(runsDir),
    (async (): Promise<{ seats: unknown[]; seatsState: 'ok' | 'unavailable' }> => {
      try {
        const list = deps.listSeats ?? (async (config: AshlrConfig) => (await import('../verse/seats.js')).discoverSeats(config).then(d => d.seats));
        const rows = await list(cfg);
        return { seats: rows.slice(0, WB_STEER_MAX_AGENTS) as unknown[], seatsState: 'ok' };
      } catch {
        return { seats: [], seatsState: 'unavailable' as const };
      }
    })(),
  ]);
  sendJson(res, 200, sanitizePublicJson({
    v: 1,
    generatedAt: new Date().toISOString(),
    fleet,
    fleetState,
    seats: seats.seats,
    seatsState: seats.seatsState,
    queue: queueRead.queue,
    queueState: queueRead.queueState,
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
  deps: WbGhDeps = {},
  steerDeps: WbSteerDeps = {},
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

  if (path === WB_SECRETS_PATH) {
    sendJson(res, 200, await readWorkbenchSecrets());
  } else if (path === WB_SNAPSHOT_PATH) {
    handleWbSnapshot(res);
  } else if (path === WB_GH_PATH) {
    await handleWbGh(cfg, res, deps);
  } else if (path === WB_STEER_PATH) {
    await handleWbSteer(cfg, res, steerDeps);
  } else {
    handleWbBudget(res);
  }
  return true;
}
