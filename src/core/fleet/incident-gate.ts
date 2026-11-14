/**
 * core/fleet/incident-gate.ts — incident-to-gate hardening (digest item 8).
 *
 * When a failure class repeats — the same lane error, the same work failure
 * on a repo+kind, the same unmerged-PR pattern — the fleet tightens the gate
 * that owns it instead of writing another note. Built on the autobackoff
 * pattern (contrib/mac/dispatchd.py): detect a repeated signature, hold the
 * implicated scope for a bounded time, record every decision.
 *
 *   lane-error      lane-attributed repeats — autobackoff/autobackoff_skip/
 *                   authbackoff_skip metric rows, AUTH_FAILURE_SEEN /
 *                   USAGE_LIMIT_SEEN / MODEL_CAPACITY_SEEN / LAUNCH_FAILED /
 *                   LAUNCH_DEFERRED event lines, finish pool_error /
 *                   failure_class / nonzero exit / empty-diff, task_outcome
 *                   failed|deferred, precheck_skip / precheck_parked —
 *                   → a bounded lane hold through the same guarded
 *                   slots.json writer `fleet lane-hold` uses
 *                   (held_by 'phantom incident-gate', ≤ laneHoldMinutes).
 *   test-failure    repo+kind-attributed repeats of the same failure code
 *                   (finish / task_outcome / precheck rows) — the "same
 *                   test failure N times" class —
 *                   → a bounded repo 'cooldown' hold (setRepoHold, actor
 *                   'backpressure'; actor reuse keeps the FleetActor contract
 *                   untouched, the reason carries incident-gate attribution).
 *   merge-conflict  repeated PRs closed unmerged on one repo — the ledger's
 *                   merge-conflict proxy; real conflict state lives on GitHub
 *                   (fleet dirty-landed) — → the same repo cooldown.
 *
 * A class fires once per minRepeats NEW signals after its last fire: the
 * firedAt watermark in the state file plays the role backpressure's
 * lastXAt does, so reruns never double-hold and continued failure
 * re-tightens. Every tripped class produces exactly one tightening plan;
 * applying it is the caller's job through injected writers.
 *
 * PURE core + one small private state file (~/.ashlr/fleet/incident-gate.json,
 * 0600) holding firedAt watermarks, plus an append-only decision ledger
 * (~/.ashlr/fleet/incident-gates.jsonl). Missing or corrupt state is the
 * empty state; an unreadable evidence source is 'unreadable', never zero.
 * All recorded text is secret-scrubbed and bounded; failure codes are
 * normalized to a safe charset before they reach any hold reason or log.
 */
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';

import { localTimestamp, readSource } from './runs-parked-queue.js';
import { LANE_ID_RE } from './runs-lane-targets.js';
import { NAME_WITH_OWNER_RE } from './quarantine.js';
import { FLEET_OWNER } from './fleet-truth.js';
import { scrubSecrets } from '../util/scrub.js';
import { ensurePrivateDirectory, readPrivateFileCapped, writePrivateFileAtomic } from '../verse/preferences.js';

export const INCIDENT_GATE_SCHEMA = 'fleet.incident-gate.v1';
export const INCIDENT_WINDOW_MS = 7 * 24 * 3_600_000;
export const INCIDENT_MIN_REPEATS = 3;
/** Bounded lane hold; placeLaneHold itself caps at 24 h. */
export const INCIDENT_LANE_HOLD_MINUTES = 120;
/** Repo cooldown length — the same 6 h backpressure cooldowns use. */
export const INCIDENT_REPO_COOLDOWN_MS = 6 * 3_600_000;

const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
/** Bare repo name as ready.tsv/dispatchd carry it (REPO_RANK keys). */
const BARE_REPO = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;
const MAX_JOBS_BYTES = 8 * 1024 * 1024;
const MAX_EVENTS_BYTES = 8 * 1024 * 1024;
const MAX_STATE_BYTES = 64 * 1024;
const MAX_FIRED_KEYS = 500;
const MAX_CLASSES = 200;
const MAX_SIGNALS = 50_000;
const SKEW_MS = 60_000;
const cut = (s: string, n = 120): string => scrubSecrets(s.replace(/\s+/g, ' ').trim()).slice(0, n);

export type IncidentClassKind = 'lane-error' | 'test-failure' | 'merge-conflict';
export type IncidentSourceState = 'read' | 'missing' | 'unreadable';

export interface IncidentSignal {
  /** Epoch ms of the evidence row. */
  at: number;
  cls: IncidentClassKind;
  /** Stable group key, e.g. 'lane-error:codex:launch-failed'. */
  key: string;
  lane: string | null;
  /** owner/name when known (bare ledger names resolve under FLEET_OWNER). */
  repo: string | null;
  /** Job-kind prefix for test-failure classes; null elsewhere. */
  kind: string | null;
  /** Normalized failure code, safe charset only. */
  code: string;
  /** One scrubbed evidence line. */
  detail: string;
}

export interface IncidentGateInput {
  jobs?: string | null;
  events?: string | null;
  /** Explicit per-source health; absent sources report presence of their text. */
  sourceStates?: Partial<Record<'jobs' | 'events', IncidentSourceState>>;
  nowMs: number;
  windowMs?: number;
}

export interface IncidentMineResult {
  signals: IncidentSignal[];
  /** In-window failure signals before watermark filtering. */
  observed: number;
  sources: Record<'jobs' | 'events', IncidentSourceState>;
}

export interface IncidentClassReport {
  key: string;
  cls: IncidentClassKind;
  lane: string | null;
  repo: string | null;
  kind: string | null;
  code: string;
  /** Signals inside the window AND after the class watermark. */
  count: number;
  /** All in-window signals for the key, watermark aside. */
  total: number;
  newestAt: string | null;
  tripped: boolean;
}

export type IncidentGateAction =
  | { gate: 'lane-hold'; lane: string; minutes: number; reason: string }
  | { gate: 'repo-cooldown'; repo: string; kind: 'cooldown'; until: string; reason: string };

export interface IncidentTighteningPlan {
  key: string;
  cls: IncidentClassKind;
  count: number;
  action: IncidentGateAction;
}

export interface IncidentGateStateV1 {
  v: 1;
  /** classKey → ISO instant the class last fired; only NEWER signals count again. */
  firedAt: Record<string, string>;
  updatedAt: string;
}

export interface IncidentGateLimits {
  windowMs?: number;
  minRepeats?: number;
  laneHoldMinutes?: number;
  repoCooldownMs?: number;
}

export interface IncidentGateEvaluation {
  classes: IncidentClassReport[];
  /** Classes that crossed minRepeats this run, with their tightening action. */
  fired: IncidentTighteningPlan[];
}

// ---------------------------------------------------------------------------
// Normalization
// ---------------------------------------------------------------------------

/** Failure codes land inside hold reasons and log lines — safe charset only. */
function normCode(raw: unknown): string {
  const s = typeof raw === 'string' ? raw : typeof raw === 'number' && Number.isFinite(raw) ? String(raw) : '';
  const n = s.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/-{2,}/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return n || 'unknown';
}

/** owner/name stays; a bare fleet repo name resolves under FLEET_OWNER. GitHub
 * owner/repo is case-insensitive and the fleet canonical form is lowercase, so
 * the qualified id is lowercased — hold keys then cannot split on case. */
export function qualifyIncidentRepo(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const r = raw.trim();
  if (NAME_WITH_OWNER_RE.test(r)) return r.toLowerCase();
  if (BARE_REPO.test(r)) return `${FLEET_OWNER}/${r.toLowerCase()}`;
  return null;
}

/** github.com/<owner>/<repo>/pull/<n> → lowercase owner/name (eval-report's
 * prKeyOf shape, inlined: that module's import chain is too heavy for this
 * miner). Null when the value is not a GitHub pull URL. */
const PR_URL_RE = /^https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/\d+\/?$/i;
function prRepoOf(raw: Record<string, unknown>): string | null {
  for (const field of ['url', 'prUrl', 'pr_url', 'pr', 'html_url'] as const) {
    const value = raw[field];
    if (typeof value !== 'string') continue;
    const m = PR_URL_RE.exec(value.trim());
    if (m) return qualifyIncidentRepo(`${m[1]}/${m[2]}`);
  }
  return null;
}

function laneOf(raw: unknown): string | null {
  return typeof raw === 'string' && LANE_ID_RE.test(raw) ? raw : null;
}

/** Job-kind prefix: the segment after an optional RQ- (dispatchd's _kind convention). */
export function incidentJobKind(job: string): string {
  const m = /^(?:RQ-)?([A-Za-z0-9]+)/.exec(job);
  return (m?.[1] ?? job).slice(0, 24) || 'unknown';
}

// ---------------------------------------------------------------------------
// Mining (pure)
// ---------------------------------------------------------------------------

interface RawRow {
  at: number;
  event: string;
  job: string | null;
  lane: string | null;
  repo: string | null;
  /** owner/name parsed from a PR URL on the row, when present. */
  prRepo: string | null;
  raw: Record<string, unknown>;
}

const tsMs = (v: unknown): number => {
  const t = typeof v === 'string' ? Date.parse(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(t) ? t : NaN;
};

const jobIdOf = (r: Record<string, unknown>): string | null => {
  for (const field of ['job', 'jobId', 'job_id'] as const) {
    const v = r[field];
    if (typeof v === 'string' && JOB_ID.test(v)) return v;
  }
  return null;
};

function jobRows(text: string): RawRow[] {
  const rows: RawRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const raw: unknown = JSON.parse(line);
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;
      const r = raw as Record<string, unknown>;
      // metrics-outcomes reconciler rows are publish-shaped (they keep the
      // PUBLISHED row's event/jobId/prUrl fields) but carry a terminal
      // outcome — batcher.read_rows projects them to event:"outcome" at read
      // time; this miner applies the same projection. Event-less rows with an
      // outcome/status/state marker are outcome rows too.
      let event = typeof r.event === 'string' ? r.event : null;
      const terminal = r.outcome === 'MERGED' || r.outcome === 'CLOSED' ||
        r.status === 'MERGED' || r.status === 'CLOSED';
      if (r.source === 'metrics-outcomes-reconciler' && terminal) event = 'outcome';
      if (event === null &&
          (typeof r.outcome === 'string' || typeof r.status === 'string' || typeof r.state === 'string')) {
        event = 'outcome';
      }
      if (event === null) continue;
      rows.push({
        at: tsMs(r.ts ?? r.at ?? r.timestamp),
        event,
        job: jobIdOf(r),
        lane: laneOf(r.lane ?? r.pool),
        repo: qualifyIncidentRepo(r.repo ?? r.repository ?? r.nameWithOwner ?? r.name_with_owner),
        prRepo: prRepoOf(r),
        raw: r,
      });
    } catch { /* malformed ledger line */ }
  }
  return rows;
}

/** The finish row's failure identity: classified pool/class error, else exit, else empty-diff. */
function finishFailureCode(raw: Record<string, unknown>): string | null {
  const pool = typeof raw.pool_error === 'string' ? raw.pool_error.trim() : '';
  if (pool) return `pool-${normCode(pool)}`;
  const fc = typeof raw.failure_class === 'string' ? raw.failure_class.trim() : '';
  if (fc) return `class-${normCode(fc)}`;
  const ec = raw.exit_code;
  if (typeof ec === 'number' && Number.isFinite(ec) && ec !== 0) return `exit-${Math.trunc(ec)}`;
  if (raw.empty === true) return 'empty-diff';
  return null;
}

const TASK_FAILURES: Record<string, string> = { failed: 'task-failed', deferred: 'task-deferred' };
const AB_EVENTS: Record<string, string> = {
  autobackoff_hold: 'ab', autobackoff_skip: 'abskip', authbackoff_skip: 'authskip',
};
const PRECHECK_EVENTS = new Set(['precheck_skip', 'precheck_parked']);
const EVENT_CODES: Record<string, string> = {
  AUTH_FAILURE_SEEN: 'event-auth-failure',
  USAGE_LIMIT_SEEN: 'event-usage-limit',
  MODEL_CAPACITY_SEEN: 'event-model-capacity',
  LAUNCH_FAILED: 'event-launch-failed',
  LAUNCH_DEFERRED: 'event-launch-deferred',
};

/**
 * Fold bounded jobs.jsonl + dispatch-events.log text into failure signals.
 * Out-of-window rows still feed the job→lane/repo joins (a finish's launch
 * row is usually in-window too, but the join is cheap and order-free).
 */
export function mineIncidentSignals(input: IncidentGateInput): IncidentMineResult {
  const nowMs = input.nowMs;
  const windowMs = input.windowMs ?? INCIDENT_WINDOW_MS;
  const floor = nowMs - windowMs;
  const inWindow = (at: number): boolean => Number.isFinite(at) && at >= floor && at <= nowMs + SKEW_MS;
  const sources: IncidentMineResult['sources'] = {
    jobs: input.sourceStates?.jobs ?? (input.jobs == null ? 'missing' : 'read'),
    events: input.sourceStates?.events ?? (input.events == null ? 'missing' : 'read'),
  };
  const signals: IncidentSignal[] = [];

  const jobLane = new Map<string, string>();
  const jobRepo = new Map<string, string>();
  const rows = input.jobs == null ? [] : jobRows(input.jobs);
  for (const r of rows) {
    if (r.job) {
      if (r.lane && !jobLane.has(r.job)) jobLane.set(r.job, r.lane);
      const joined = r.repo ?? r.prRepo;
      if (joined && !jobRepo.has(r.job)) jobRepo.set(r.job, joined);
    }
  }

  const push = (cls: IncidentClassKind, key: string, lane: string | null, repo: string | null,
    kind: string | null, code: string, at: number, detail: string): void => {
    if (signals.length >= MAX_SIGNALS) return;
    signals.push({ at, cls, key, lane, repo, kind, code, detail: cut(detail, 140) });
  };
  /** A work failure feeds both the lane-error and test-failure classes. */
  const workFailure = (code: string, lane: string | null, repo: string | null, kind: string | null,
    at: number, detail: string): void => {
    if (lane) push('lane-error', `lane-error:${lane}:${code}`, lane, repo, null, code, at, detail);
    if (repo) push('test-failure', `test-failure:${repo}:${kind ?? 'unknown'}:${code}`, lane, repo, kind, code, at, detail);
  };

  /** Lane for a row: explicit field, then the job's launch/claim row. */
  const laneFor = (r: RawRow): string | null =>
    r.lane ?? (r.job ? jobLane.get(r.job) ?? null : null);
  /** Repo for a row: explicit field, then its PR URL, then the job's launch row. */
  const repoFor = (r: RawRow): string | null =>
    r.repo ?? r.prRepo ?? (r.job ? jobRepo.get(r.job) ?? null : null);

  let observed = 0;
  for (const r of rows) {
    if (!inWindow(r.at)) continue;
    const detail = `jobs.jsonl ${r.event} job=${r.job ?? 'unknown'}`;
    if (r.event === 'finish') {
      const code = finishFailureCode(r.raw);
      if (code === null) continue;
      observed++;
      workFailure(code, laneFor(r), repoFor(r),
        r.job ? incidentJobKind(r.job) : null, r.at, `${detail} ${code}`);
    } else if (r.event === 'task_outcome') {
      const outcome = typeof r.raw.outcome === 'string' ? r.raw.outcome : '';
      const code = TASK_FAILURES[outcome];
      if (code === undefined) continue;
      observed++;
      workFailure(code, laneFor(r), repoFor(r),
        r.job ? incidentJobKind(r.job) : null, r.at, `${detail} outcome=${outcome}`);
    } else if (r.event in AB_EVENTS) {
      const lane = r.lane;
      if (!lane) continue;
      const pattern = normCode(r.raw.pattern);
      const code = `${AB_EVENTS[r.event]}-${pattern}`;
      observed++;
      push('lane-error', `lane-error:${lane}:${code}`, lane, r.repo, null, code, r.at, `${detail} pattern=${pattern}`);
    } else if (PRECHECK_EVENTS.has(r.event)) {
      const code = `precheck-${normCode(r.raw.code)}`;
      observed++;
      workFailure(code, laneFor(r), repoFor(r),
        r.job ? incidentJobKind(r.job) : null, r.at, `${detail} code=${String(r.raw.code ?? '?')}`);
    } else if (r.event === 'outcome') {
      const state = String(r.raw.state ?? r.raw.outcome ?? r.raw.status ?? '').toUpperCase();
      const repo = repoFor(r);
      if (state !== 'CLOSED' || repo === null) continue;
      observed++;
      push('merge-conflict', `merge-conflict:${repo}`, r.lane, repo, null, 'pr-closed-unmerged', r.at,
        `${detail} state=CLOSED`);
    }
  }

  if (input.events != null) {
    for (const line of input.events.split(/\r?\n/)) {
      const m = /^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\s+(.*)$/.exec(line.trim());
      if (!m) continue;
      const at = localTimestamp(m[1]!).ms;
      if (!inWindow(at)) continue;
      const tok = m[2]!.split(/\s+/);
      const verb = tok[0] ?? '';
      const code = EVENT_CODES[verb];
      if (code === undefined) continue;
      let lane: string | null = null;
      if (verb === 'LAUNCH_FAILED' || verb === 'LAUNCH_DEFERRED') {
        const job = typeof tok[1] === 'string' && JOB_ID.test(tok[1]) ? tok[1] : null;
        lane = job ? jobLane.get(job) ?? null : null;
      } else {
        lane = typeof tok[1] === 'string' && LANE_ID_RE.test(tok[1]) ? tok[1] : null;
      }
      if (!lane) continue;
      observed++;
      push('lane-error', `lane-error:${lane}:${code}`, lane, null, null, code, at, `dispatch-events.log "${cut(m[2]!, 110)}"`);
    }
  }

  return { signals: signals.slice(0, MAX_SIGNALS), observed, sources };
}

// ---------------------------------------------------------------------------
// State (firedAt watermarks) — private JSON, 0600 in a 0700 dir
// ---------------------------------------------------------------------------

export function emptyIncidentGateState(): IncidentGateStateV1 {
  return { v: 1, firedAt: {}, updatedAt: new Date(0).toISOString() };
}

export function incidentGateStatePath(stateDir: string): string {
  return join(stateDir, 'incident-gate.json');
}

export function incidentGateLedgerPath(stateDir: string): string {
  return join(stateDir, 'incident-gates.jsonl');
}

/** Total: a missing or mangled file is the empty state (classes may refire — bounded by the holds themselves). */
export function loadIncidentGateState(stateDir: string): IncidentGateStateV1 {
  const read = readPrivateFileCapped(incidentGateStatePath(stateDir), MAX_STATE_BYTES);
  if (!read || read.truncated) return emptyIncidentGateState();
  try {
    const raw = JSON.parse(read.text) as Record<string, unknown>;
    if (raw['v'] !== 1 || typeof raw['firedAt'] !== 'object' || raw['firedAt'] === null || Array.isArray(raw['firedAt'])) {
      return emptyIncidentGateState();
    }
    const firedAt: Record<string, string> = {};
    let kept = 0;
    for (const [key, value] of Object.entries(raw['firedAt'] as Record<string, unknown>)) {
      if (kept >= MAX_FIRED_KEYS) break;
      if (key.length > 200 || typeof value !== 'string' || value.length > 40 || !Number.isFinite(Date.parse(value))) continue;
      firedAt[key] = value;
      kept += 1;
    }
    return {
      v: 1,
      firedAt,
      updatedAt: typeof raw['updatedAt'] === 'string' && Number.isFinite(Date.parse(raw['updatedAt']))
        ? raw['updatedAt'] : new Date(0).toISOString(),
    };
  } catch {
    return emptyIncidentGateState();
  }
}

export function saveIncidentGateState(state: IncidentGateStateV1, stateDir: string): void {
  ensurePrivateDirectory(stateDir);
  // Keep the newest MAX_FIRED_KEYS watermarks; older classes simply refire sooner.
  const entries = Object.entries(state.firedAt)
    .sort((a, b) => Date.parse(b[1]) - Date.parse(a[1]))
    .slice(0, MAX_FIRED_KEYS);
  const pruned: IncidentGateStateV1 = { v: 1, firedAt: Object.fromEntries(entries), updatedAt: state.updatedAt };
  writePrivateFileAtomic(incidentGateStatePath(stateDir), `${JSON.stringify(pruned, null, 2)}\n`);
}

/** Advance the watermark for the classes whose tightening reached a terminal state. */
export function advanceIncidentGateState(
  state: IncidentGateStateV1, keys: readonly string[], nowMs: number,
): IncidentGateStateV1 {
  const firedAt = { ...state.firedAt };
  const iso = new Date(nowMs).toISOString();
  for (const key of keys) firedAt[key] = iso;
  return { v: 1, firedAt, updatedAt: iso };
}

// ---------------------------------------------------------------------------
// Evaluation (pure)
// ---------------------------------------------------------------------------

function windowDays(windowMs: number): number {
  return Math.max(1, Math.round(windowMs / 86_400_000));
}

/** Build the tightening action for one tripped class. Reasons are ASCII-safe and bounded. */
function actionFor(
  cls: IncidentClassKind, lane: string | null, repo: string | null, kind: string | null,
  code: string, count: number, nowMs: number, limits: Required<IncidentGateLimits>,
): IncidentGateAction | null {
  const days = windowDays(limits.windowMs);
  if (cls === 'lane-error') {
    if (!lane) return null;
    return {
      gate: 'lane-hold', lane, minutes: limits.laneHoldMinutes,
      reason: `incident-gate ${cls}/${code}: ${count} repeats in ${days}d`,
    };
  }
  if (!repo) return null;
  const scope = kind ? ` ${kind}` : '';
  const until = new Date(nowMs + limits.repoCooldownMs).toISOString();
  return {
    gate: 'repo-cooldown', repo, kind: 'cooldown', until,
    reason: cut(`incident-gate ${cls}: ${count} repeats of ${code} on ${repo}${scope} in ${days}d — repo production paused`, 480),
  };
}

/**
 * Group signals into classes and trip the ones with ≥ minRepeats NEW signals
 * (after the class's firedAt watermark, inside the window). Pure: returns the
 * class report and the tightening plans; it never writes.
 */
export function evaluateIncidentGate(input: {
  signals: readonly IncidentSignal[];
  state: IncidentGateStateV1;
  nowMs: number;
  limits?: IncidentGateLimits;
}): IncidentGateEvaluation {
  const limits: Required<IncidentGateLimits> = {
    windowMs: input.limits?.windowMs ?? INCIDENT_WINDOW_MS,
    minRepeats: input.limits?.minRepeats ?? INCIDENT_MIN_REPEATS,
    laneHoldMinutes: input.limits?.laneHoldMinutes ?? INCIDENT_LANE_HOLD_MINUTES,
    repoCooldownMs: input.limits?.repoCooldownMs ?? INCIDENT_REPO_COOLDOWN_MS,
  };
  const floor = input.nowMs - limits.windowMs;
  const groups = new Map<string, { cls: IncidentClassKind; lane: string | null; repo: string | null; kind: string | null; code: string; ats: number[] }>();
  for (const s of input.signals) {
    if (!Number.isFinite(s.at) || s.at < floor || s.at > input.nowMs + SKEW_MS) continue;
    const g = groups.get(s.key) ?? { cls: s.cls, lane: s.lane, repo: s.repo, kind: s.kind, code: s.code, ats: [] };
    g.ats.push(s.at);
    groups.set(s.key, g);
  }
  const classes: IncidentClassReport[] = [];
  const fired: IncidentTighteningPlan[] = [];
  const sorted = [...groups.entries()].sort((a, b) => b[1].ats.length - a[1].ats.length || a[0].localeCompare(b[0]));
  for (const [key, g] of sorted.slice(0, MAX_CLASSES)) {
    g.ats.sort((a, b) => a - b);
    const watermark = input.state.firedAt[key] !== undefined ? Date.parse(input.state.firedAt[key]!) : Number.NEGATIVE_INFINITY;
    const fresh = g.ats.filter(at => at > watermark);
    const tripped = fresh.length >= limits.minRepeats;
    classes.push({
      key, cls: g.cls, lane: g.lane, repo: g.repo, kind: g.kind, code: g.code,
      count: fresh.length, total: g.ats.length,
      newestAt: g.ats.length ? new Date(g.ats[g.ats.length - 1]!).toISOString() : null,
      tripped,
    });
    if (!tripped) continue;
    const action = actionFor(g.cls, g.lane, g.repo, g.kind, g.code, fresh.length, input.nowMs, limits);
    if (action !== null) fired.push({ key, cls: g.cls, count: fresh.length, action });
  }
  return { classes, fired };
}

// ---------------------------------------------------------------------------
// Bounded reads (same sources and caps as the friction ledger)
// ---------------------------------------------------------------------------

export interface IncidentGateSources {
  jobs: string | null;
  events: string | null;
  sources: Record<'jobs' | 'events', IncidentSourceState>;
}

/** metrics/jobs.jsonl + dispatch-events.log (queue/ then runs root, like friction). */
export async function readIncidentGateSources(runsDir: string): Promise<IncidentGateSources> {
  const read = async (path: string, max: number): Promise<{ text: string | null; state: IncidentSourceState }> => {
    const r = await readSource(path, max, true);
    return {
      text: r.state === 'healthy' ? r.text : null,
      state: r.state === 'healthy' ? 'read' : r.state === 'missing' ? 'missing' : 'unreadable',
    };
  };
  const [jobs, queuedEvents, rootEvents] = await Promise.all([
    read(join(runsDir, 'metrics', 'jobs.jsonl'), MAX_JOBS_BYTES),
    read(join(runsDir, 'queue', 'dispatch-events.log'), MAX_EVENTS_BYTES),
    read(join(runsDir, 'dispatch-events.log'), MAX_EVENTS_BYTES),
  ]);
  const events = queuedEvents.text !== null ? queuedEvents : rootEvents;
  return {
    jobs: jobs.text,
    events: events.text,
    sources: { jobs: jobs.state, events: events.state },
  };
}

/** Append decision rows to incident-gates.jsonl — the only ledger this module writes. */
export async function appendIncidentGateLedger(stateDir: string, lines: readonly string[]): Promise<void> {
  if (lines.length === 0) return;
  ensurePrivateDirectory(stateDir);
  const path = incidentGateLedgerPath(stateDir);
  const handle = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    for (const line of lines) await handle.write(line.endsWith('\n') ? line : `${line}\n`);
  } finally {
    await handle.close();
  }
}
