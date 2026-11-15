/**
 * core/fleet/claim-execution-evidence.ts: one read-only join between the
 * advisory coordination ledger and the live worker process table. A claim
 * says who CLAIMED a task; this report says whether a worker is actually
 * RUNNING it, turning "ASSIGNED" into "RUNNING (pid, lane, age)" or an
 * honest "CLAIMED, no live worker".
 *
 * A claim names a job when its id (checked first) or its task text carries
 * an `RQ-…` token. A worker matches a named job when `worker.job` equals the
 * token exactly (case-sensitive) and, when both repos are non-empty, the
 * worker repo's last path segment equals the claim repo's last segment —
 * launch.sh passes a bare repo name while claims carry `owner/repo`. Only a
 * record satisfying the process reader's contract — a positive safe-integer
 * pid, string job/repo/lane/tier and a null-or-non-negative-safe-integer
 * ageSeconds — is usable live-worker evidence: malformed matching records
 * never win selection and, when nothing usable matches, turn the row
 * UNKNOWN rather than a dishonest CLAIMED_NO_WORKER. Among several usable
 * matching workers the youngest ageSeconds wins; a first match is kept on
 * ties.
 *
 * Rows cover only live claims (`expiresAt > now`), newest `claimedAt` first,
 * capped at 50. A row is RUNNING only when the process table read healthy
 * AND a usable worker matches; CLAIMED_NO_WORKER when none does; UNKNOWN
 * when the process table is unavailable or malformed, the claim names no
 * job id, or every matching worker record is malformed. A RUNNING row
 * always carries the worker's real pid — a malformed pid is never emitted.
 * When the board is missing or unreadable the report carries no rows at all.
 *
 * Identity labels (claimId, agent, repo, jobId, lane, tier) pass the
 * surface-owner safe-token rule plus a scrubSecrets equality check; a label
 * that fails is reported as 'UNKNOWN'. Claim task text never leaves this
 * module. Both readers are injectable and each sits in its own try/catch, so
 * a throwing reader degrades only its own source. Pure read: no writes, no
 * locks, no network, never throws, grants no authority.
 */
import { readFleetBoard, type FleetBoard } from './coordination.js';
import { listLiveWorkers, type LiveWorker, type LiveWorkersSnapshot } from './runs-live-workers.js';
import { scrubSecrets } from '../util/scrub.js';

export const CLAIM_EXECUTION_SCHEMA = 'fleet.claim-execution.v1';
const UNKNOWN = 'UNKNOWN';
const MAX_ROWS = 50;
const JOB_ID_RE = /\bRQ-[A-Z0-9][A-Z0-9-]{2,80}\b/;
const LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const REPO_LABEL_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/;

export type ClaimExecutionState = 'RUNNING' | 'CLAIMED_NO_WORKER' | 'UNKNOWN';

export interface ClaimExecutionRow {
  claimId: string;
  agent: string;
  repo: string;
  jobId: string | null;
  state: ClaimExecutionState;
  worker: { pid: number; lane: string; tier: string; ageSeconds: number | null } | null;
  expiresInSeconds: number;
}

export interface ClaimExecutionReport {
  schema: typeof CLAIM_EXECUTION_SCHEMA;
  authority: 'none';
  asOf: string;
  ledger: 'known' | 'unavailable';
  processes: 'healthy' | 'unavailable';
  rows: ClaimExecutionRow[];
  counts: { running: number; claimedNoWorker: number; unknown: number };
  reasons: string[];
}

export interface ClaimExecutionDeps {
  /** Coordination board reader; defaults to readFleetBoard. */
  board?: (o?: { now?: number }) => FleetBoard;
  /** Live worker snapshot reader; defaults to listLiveWorkers. */
  workers?: () => Promise<LiveWorkersSnapshot>;
  /** Clock; defaults to Date.now. */
  now?: () => number;
}

const finite = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);

const iso = (n: unknown): string =>
  new Date(finite(n) && n >= 0 && n <= 8_640_000_000_000_000 ? n : 0).toISOString();

const text = (s: unknown): string => (typeof s === 'string' ? s : '');

/** Identity labels are single safe tokens; '/' is allowed for repos only. */
const label = (value: unknown, allowSlash = false): string => {
  const v = text(value);
  return (allowSlash ? REPO_LABEL_RE : LABEL_RE).test(v) && scrubSecrets(v) === v ? v : UNKNOWN;
};

const lastSegment = (repo: string): string => {
  const parts = repo.split('/').filter(part => part.length > 0);
  return parts.length === 0 ? '' : parts[parts.length - 1]!;
};

/** Loose claim shape so an injected or future-schema row can never throw here. */
interface ClaimLike { id: unknown; agent: unknown; repo: unknown; task: unknown; claimedAt: unknown; expiresAt: unknown }
const claimLike = (v: unknown): v is ClaimLike => v !== null && typeof v === 'object';

/** The first `RQ-…` token in claim.id, then claim.task; null when neither names one. */
function jobIdOf(claim: { id: unknown; task: unknown }): string | null {
  return JOB_ID_RE.exec(text(claim.id))?.[0] ?? JOB_ID_RE.exec(text(claim.task))?.[0] ?? null;
}

const ageOf = (worker: LiveWorker): number =>
  finite(worker.ageSeconds) ? worker.ageSeconds : Number.POSITIVE_INFINITY;

/**
 * The process reader's contract, applied to one matching record:
 * `listLiveWorkers` only ever emits a positive safe-integer pid, string
 * job/repo/lane/tier and a null-or-non-negative-safe-integer ageSeconds, so
 * a record failing this could not have come from a healthy process table
 * and is not usable live-worker evidence.
 */
const usableWorkerEvidence = (worker: LiveWorker): boolean =>
  Number.isSafeInteger(worker.pid) && worker.pid > 0 &&
  typeof worker.job === 'string' &&
  typeof worker.repo === 'string' && typeof worker.lane === 'string' && typeof worker.tier === 'string' &&
  (worker.ageSeconds === null || (Number.isSafeInteger(worker.ageSeconds) && worker.ageSeconds >= 0));

interface WorkerMatch {
  /** Youngest usable matching worker; null when none is usable. */
  best: LiveWorker | null;
  /** True when at least one nominally matching record was malformed. */
  malformedMatch: boolean;
}

/**
 * First usable matching worker, ties broken by youngest ageSeconds.
 * Malformed matching records never win but are still reported so the caller
 * can answer UNKNOWN instead of claiming a healthy absence.
 */
function workerFor(jobId: string, claimRepo: string, workers: unknown[]): WorkerMatch {
  const claimSegment = lastSegment(claimRepo);
  let best: LiveWorker | null = null;
  let malformedMatch = false;
  for (const candidate of workers) {
    if (candidate === null || typeof candidate !== 'object') continue;
    const worker = candidate as LiveWorker;
    if (worker.job !== jobId) continue;
    const workerSegment = lastSegment(text(worker.repo));
    if (claimSegment !== '' && workerSegment !== '' && workerSegment !== claimSegment) continue;
    if (!usableWorkerEvidence(worker)) {
      malformedMatch = true;
      continue;
    }
    if (best === null || ageOf(worker) < ageOf(best)) best = worker;
  }
  return { best, malformedMatch };
}

/**
 * Pure join of a board snapshot with a process snapshot. Either input may be
 * null (its reader failed); a null or non-'known' board yields an empty
 * ledger and a null or non-'healthy' snapshot marks every row UNKNOWN.
 */
export function joinClaimExecution(board: FleetBoard | null, workers: LiveWorkersSnapshot | null, nowMs: number): ClaimExecutionReport {
  const reasons = new Set<string>();
  const counts = { running: 0, claimedNoWorker: 0, unknown: 0 };
  const rows: ClaimExecutionRow[] = [];
  const processes: ClaimExecutionReport['processes'] =
    workers !== null && workers.sourceState === 'healthy' ? 'healthy' : 'unavailable';
  const ledgerKnown = board !== null && board.state === 'known';
  if (!ledgerKnown) reasons.add('coordination ledger: missing or unreadable');
  if (ledgerKnown) {
    const workerList: unknown[] | null =
      processes === 'healthy' ? (Array.isArray(workers!.workers) ? workers!.workers : null) : null;
    const live = ((Array.isArray(board!.claims) ? board!.claims : []) as unknown[])
      .filter(claimLike)
      .filter(claim => finite(claim.expiresAt) && claim.expiresAt > nowMs)
      .sort((a, b) => (finite(b.claimedAt) ? b.claimedAt : 0) - (finite(a.claimedAt) ? a.claimedAt : 0))
      .slice(0, MAX_ROWS);
    for (const claim of live) {
      const expiresAt = finite(claim.expiresAt) ? claim.expiresAt : nowMs;
      const jobId = jobIdOf(claim);
      const row: ClaimExecutionRow = {
        claimId: label(claim.id), agent: label(claim.agent), repo: label(claim.repo, true),
        jobId: jobId === null ? null : label(jobId), state: 'UNKNOWN', worker: null,
        expiresInSeconds: Math.floor((expiresAt - nowMs) / 1000),
      };
      if (processes !== 'healthy') {
        reasons.add('process table: unavailable');
      } else if (workerList === null) {
        reasons.add('process table: malformed worker list');
      } else if (jobId === null) {
        reasons.add('claim names no job id');
      } else {
        const { best: match, malformedMatch } = workerFor(jobId, text(claim.repo), workerList);
        if (match !== null) {
          row.state = 'RUNNING';
          row.worker = {
            pid: match.pid,
            lane: label(match.lane), tier: label(match.tier),
            ageSeconds: finite(match.ageSeconds) ? match.ageSeconds : null,
          };
        } else if (malformedMatch) {
          reasons.add('matching worker evidence malformed');
        } else {
          row.state = 'CLAIMED_NO_WORKER';
        }
      }
      counts[row.state === 'RUNNING' ? 'running' : row.state === 'CLAIMED_NO_WORKER' ? 'claimedNoWorker' : 'unknown']++;
      rows.push(row);
    }
  }
  return {
    schema: CLAIM_EXECUTION_SCHEMA, authority: 'none', asOf: iso(nowMs),
    ledger: ledgerKnown ? 'known' : 'unavailable', processes,
    rows, counts, reasons: [...reasons],
  };
}

/**
 * One bounded claim-execution snapshot. Each reader is isolated in its own
 * try/catch — a throwing board reader marks only the ledger unavailable and
 * a throwing workers reader only the process table — so the report never
 * throws and never carries exception text.
 */
export async function readClaimExecution(deps: ClaimExecutionDeps = {}): Promise<ClaimExecutionReport> {
  let now: number;
  try {
    now = (deps.now ?? Date.now)();
  } catch {
    now = Date.now();
  }
  if (!finite(now)) now = Date.now();
  let board: FleetBoard | null = null;
  try {
    board = (deps.board ?? readFleetBoard)({ now }) ?? null;
  } catch { /* an unreadable ledger is reported, never thrown */ }
  let workers: LiveWorkersSnapshot | null = null;
  try {
    workers = (await (deps.workers ?? listLiveWorkers)()) ?? null;
  } catch { /* same: a throwing reader degrades only its own source */ }
  return joinClaimExecution(board, workers, now);
}
