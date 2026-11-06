/**
 * Derive `ask.status.v1` events from a metrics jobs ledger (`metrics/jobs.jsonl`).
 *
 * The ledger is append-only task data: one JSON object per line recording job
 * lifecycle events (`enqueue`, `launch`, `finish`, `outcome`, …). Each ask job
 * is folded into the one-ask lifecycle
 *
 *   queued -> claimed -> running -> verifying -> pr_open -> in_merge_queue -> merged
 *
 * with `failed`, `refused`, `reverted` and `publish_only` as terminal exits.
 * A `finish` record carries the terminal outcome; when it also carries
 * `queued_at`/`started_at` timestamps, the earlier stages are derived from it
 * so one finish line still yields the full queued -> running -> merged arc.
 *
 * Pure projection: no I/O, no dispatch, no authority. Records that cannot
 * resolve an ask id (`RQ-ASK-*`), carry no recognized event, or lack a valid
 * timestamp are skipped; malformed JSON and non-object lines throw.
 */

export const ASK_STATUS_SCHEMA = 'ask.status.v1' as const;

export const ASK_STATUS_STATES = [
  'refused', 'queued', 'claimed', 'running', 'verifying', 'pr_open',
  'in_merge_queue', 'merged', 'reverted', 'publish_only', 'failed',
] as const;
export type AskStatusState = (typeof ASK_STATUS_STATES)[number];

export const ASK_POOLS = [
  'codex-cmp', 'codex-personal', 'claude', 'devin',
  'claude-api', 'local', 'cursor-cloud', 'grok-build',
] as const;
export type AskPool = (typeof ASK_POOLS)[number];

export interface AskStatusEvent {
  schema: typeof ASK_STATUS_SCHEMA;
  ask_id: string;
  job_id: string | null;
  state: AskStatusState;
  pool: AskPool | null;
  ts: string;
  pr: number | null;
  pr_url: string | null;
  merged_at: string | null;
  reverted_at: string | null;
  checks: 'pending' | 'success' | 'failure' | null;
  reason: string | null;
  tokens_total: number | null;
  wall_s: number | null;
}

const ASK_ID = /^RQ-ASK-\d{8}-[A-Z0-9]{4,12}$/;
/** `RQ-ASK-<date>-<rand>-<attempt>` splits into ask id + attempt job id. */
const ASK_JOB_ID = /^(RQ-ASK-\d{8}-[A-Z0-9]{4,12})-[A-Z0-9]{1,8}$/;
const JOB_ID = /^RQ-[A-Z0-9][A-Z0-9._-]{0,79}$/;
const ISO_TS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?([+-]\d{2}:?\d{2}|Z)$/;
const PR_URL = /^https:\/\/github\.com\/ashlrai\/[a-z0-9-]+\/pull\/\d{1,7}$/;
const CHECKS = ['pending', 'success', 'failure'] as const;

/** Forward progress rank; terminal states share the top rank. */
const RANK: Record<AskStatusState, number> = {
  refused: 7, queued: 1, claimed: 2, running: 3, verifying: 4,
  pr_open: 5, in_merge_queue: 6, merged: 7, reverted: 7,
  publish_only: 7, failed: 7,
};

/** Ledger event names -> lifecycle state. Finish/outcome resolve separately. */
const EVENT_STATE: Record<string, AskStatusState> = {
  enqueue: 'queued', enqueued: 'queued', queued: 'queued', submit: 'queued',
  submitted: 'queued', intake: 'queued', create: 'queued', created: 'queued',
  claim: 'claimed', claimed: 'claimed', acquire: 'claimed', acquired: 'claimed',
  launch: 'running', launched: 'running', start: 'running', started: 'running',
  running: 'running', dispatch: 'running', dispatched: 'running',
  verify: 'verifying', verifying: 'verifying', verification: 'verifying',
  review: 'verifying', checks: 'verifying',
  publish: 'pr_open', published: 'pr_open', pr: 'pr_open', pr_open: 'pr_open',
  'pr-open': 'pr_open', proposal: 'pr_open', proposed: 'pr_open',
  merge_queue: 'in_merge_queue', 'merge-queue': 'in_merge_queue',
  in_merge_queue: 'in_merge_queue', 'in-merge-queue': 'in_merge_queue',
  automerge: 'in_merge_queue',
  revert: 'reverted', reverted: 'reverted',
  refuse: 'refused', refused: 'refused', rejected: 'refused',
  cancel: 'failed', cancelled: 'failed', canceled: 'failed',
  abort: 'failed', aborted: 'failed', kill: 'failed', killed: 'failed',
};
const FINISH_EVENTS = new Set(['finish', 'finished', 'complete', 'completed', 'done', 'exit', 'exited']);
const OUTCOME_EVENTS = new Set(['outcome', 'result', 'resolved', 'resolution']);

const TERMINAL_OUTCOME: Record<string, AskStatusState> = {
  merged: 'merged', merge: 'merged',
  reverted: 'reverted', revert: 'reverted',
  publish_only: 'publish_only', 'publish-only': 'publish_only', published: 'publish_only',
  refused: 'refused', rejected: 'refused', declined: 'refused',
  failed: 'failed', failure: 'failed', closed: 'failed',
  not_merged: 'failed', 'not-merged': 'failed', error: 'failed',
  cancelled: 'failed', canceled: 'failed', expired: 'failed',
  timeout: 'failed', timed_out: 'failed', abandoned: 'failed', stuck: 'failed',
};

type Row = Record<string, unknown>;

interface JobFold {
  askId: string | null;
  jobId: string | null;
  pool: AskPool | null;
  pr: number | null;
  prUrl: string | null;
  checks: AskStatusEvent['checks'];
  tokens: number | null;
  lastRank: number;
  /** Earliest queued-stage timestamp seen, from an event or a carried field. */
  queuedTs: string | null;
  /** Earliest running-stage timestamp seen, from an event or a carried field. */
  startedTs: string | null;
  startedMs: number | null;
}

function object(value: unknown): Row | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Row : undefined;
}
function field(row: Row, ...names: string[]): unknown {
  for (const name of names) if (row[name] !== undefined && row[name] !== null) return row[name];
  return undefined;
}
function stringField(row: Row, ...names: string[]): string | undefined {
  const value = field(row, ...names);
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined;
}

/** ISO timestamp as the schema writes it: second precision, offset kept. */
function tsOf(row: Row, ...names: string[]): string | undefined {
  const value = field(row, ...names);
  if (typeof value !== 'string' || !ISO_TS.test(value) || !Number.isFinite(Date.parse(value))) return undefined;
  return value.replace(/(\.\d+)([+-]\d{2}:?\d{2}|Z)$/, '$2');
}
function msOf(ts: string | undefined): number | null {
  if (ts === undefined) return null;
  const ms = Date.parse(ts);
  return Number.isFinite(ms) ? ms : null;
}

function poolOf(row: Row): AskPool | null {
  const value = stringField(row, 'pool', 'arm', 'lane');
  return (ASK_POOLS as readonly string[]).includes(value ?? '') ? value as AskPool : null;
}
function prOf(row: Row): number | null {
  const value = field(row, 'pr', 'pr_number', 'prNumber', 'pull');
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 1_000_000 ? value : null;
}
function prUrlOf(row: Row): string | null {
  const value = stringField(row, 'pr_url', 'prUrl', 'pull_url', 'pullUrl');
  return value !== undefined && PR_URL.test(value) ? value : null;
}
function checksOf(row: Row): AskStatusEvent['checks'] {
  const value = stringField(row, 'checks', 'check', 'ci');
  return (CHECKS as readonly string[]).includes(value ?? '') ? value as AskStatusEvent['checks'] : null;
}
function tokensOf(row: Row): number | null {
  const value = field(row, 'tokens_total', 'tokens', 'total_tokens');
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= 1_000_000_000 ? value : null;
}
function reasonOf(row: Row): string | null {
  const raw = stringField(row, 'reason', 'refusal_reason', 'error_code', 'code');
  if (raw === undefined) return null;
  const cleaned = raw.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60);
  return cleaned === '' ? null : cleaned;
}

/** The ledger's ask identity: explicit ask id, or an RQ-ASK-shaped job id. */
function askIdOf(row: Row, jobId: string | null): string | null {
  const explicit = stringField(row, 'ask_id', 'askId');
  if (explicit !== undefined) return ASK_ID.test(explicit) ? explicit : null;
  if (jobId === null) return null;
  if (ASK_ID.test(jobId)) return jobId;
  const attempt = ASK_JOB_ID.exec(jobId);
  return attempt ? attempt[1]! : null;
}

function terminalOf(row: Row, event: string): AskStatusState | null {
  const outcome = stringField(row, 'outcome', 'result', 'status', 'conclusion');
  if (outcome !== undefined) {
    const mapped = TERMINAL_OUTCOME[outcome.toLowerCase()];
    if (mapped !== undefined) return mapped;
  }
  const merged = field(row, 'merged');
  if (merged === true) return 'merged';
  if (merged === false) return 'failed';
  // A bare finish means execution ended with the outcome still pending: the
  // ask moved into verification. A bare outcome record says nothing.
  return FINISH_EVENTS.has(event) ? 'verifying' : null;
}

function eventNameOf(row: Row): string | null {
  const name = stringField(row, 'event', 'type', 'kind');
  return name === undefined ? null : name.toLowerCase();
}

function jobIdOf(row: Row): string | null {
  const id = stringField(row, 'job_id', 'jobId', 'id', 'job');
  return id !== undefined && JOB_ID.test(id) ? id : null;
}

const CANCEL_EVENTS = new Set(['cancel', 'cancelled', 'canceled', 'abort', 'aborted', 'kill', 'killed']);

function emit(fold: JobFold, state: AskStatusState, ts: string, row: Row, out: AskStatusEvent[]): void {
  if (state === 'running') {
    const ms = msOf(ts);
    if (ms !== null) fold.startedMs = ms;
  }
  fold.lastRank = RANK[state];
  const wall = field(row, 'wall_s', 'wall_seconds');
  const wallMs = field(row, 'wall_time_ms', 'wall_ms');
  let wallS: number | null = null;
  if (typeof wall === 'number' && Number.isInteger(wall) && wall >= 0 && wall <= 604_800) wallS = wall;
  else if (typeof wallMs === 'number' && Number.isFinite(wallMs) && wallMs >= 0) wallS = Math.min(604_800, Math.round(wallMs / 1000));
  else if (RANK[state] === RANK.merged && fold.startedMs !== null) {
    const finishedMs = msOf(ts);
    if (finishedMs !== null && finishedMs >= fold.startedMs) {
      wallS = Math.min(604_800, Math.round((finishedMs - fold.startedMs) / 1000));
    }
  }
  out.push({
    schema: ASK_STATUS_SCHEMA,
    ask_id: fold.askId!,
    job_id: fold.jobId,
    state,
    pool: fold.pool,
    ts,
    pr: fold.pr,
    pr_url: fold.prUrl,
    merged_at: state === 'merged' ? tsOf(row, 'merged_at') ?? ts : null,
    reverted_at: state === 'reverted' ? tsOf(row, 'reverted_at') ?? ts : null,
    checks: fold.checks,
    reason: reasonOf(row) ??
      (state === 'failed' && CANCEL_EVENTS.has(eventNameOf(row) ?? '') ? 'cancelled' : null),
    tokens_total: fold.tokens,
    wall_s: wallS,
  });
}

/**
 * Fold one ledger into ask.status.v1 events, in ledger order. Transitions are
 * forward-only per job: a repeated or regressive stage is skipped. Stage
 * timestamps carried on a record (`queued_at`/`started_at`) or journaled by a
 * line that could not yet emit backfill the stages the stream is missing, so a
 * single finish line still yields the full arc.
 */
export function deriveAskStatusEvents(text: string): AskStatusEvent[] {
  const out: AskStatusEvent[] = [];
  const folds = new Map<string, JobFold>();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!.trim();
    if (raw === '' || raw.startsWith('#')) continue;
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { throw new Error(`Invalid JSON at jobs line ${i + 1}`); }
    const row = object(parsed);
    if (!row) throw new Error(`Invalid event at jobs line ${i + 1}`);

    const jobId = jobIdOf(row);
    const askId = askIdOf(row, jobId);
    const key = jobId ?? (askId !== null ? `ask:${askId}` : null);
    if (key === null) continue;
    const fold = folds.get(key) ?? {
      askId, jobId, pool: null, pr: null, prUrl: null, checks: null,
      tokens: null, lastRank: 0, queuedTs: null, startedTs: null, startedMs: null,
    };
    folds.set(key, fold);
    if (fold.askId === null) fold.askId = askId;
    if (fold.jobId === null) fold.jobId = jobId;
    fold.pool = poolOf(row) ?? fold.pool;
    fold.pr = prOf(row) ?? fold.pr;
    fold.prUrl = prUrlOf(row) ?? fold.prUrl;
    fold.checks = checksOf(row) ?? fold.checks;
    fold.tokens = tokensOf(row) ?? fold.tokens;

    const event = eventNameOf(row);
    const ts = tsOf(row, 'ts', 'timestamp', 'at', 'time', 'emitted_at',
      'finished_at', 'completed_at', 'merged_at');
    const state = event === null ? null
      : FINISH_EVENTS.has(event) || OUTCOME_EVENTS.has(event)
        ? terminalOf(row, event)
        : EVENT_STATE[event] ?? null;
    // Remember stage evidence even from lines that cannot emit yet: an ask id
    // stamped only on the finish record still recovers the whole arc.
    fold.queuedTs ??= tsOf(row, 'queued_at', 'enqueued_at', 'created_at') ??
      (state === 'queued' ? ts ?? null : null);
    fold.startedTs ??= tsOf(row, 'started_at', 'launched_at', 'dispatched_at') ??
      (state === 'running' ? ts ?? null : null);
    if (fold.askId === null) continue;

    // Backfill stages evidenced only by accumulated lifecycle timestamps. The
    // empty row keeps the triggering record's reason/wall off earlier stages.
    if (fold.queuedTs !== null && fold.lastRank < RANK.queued) {
      emit(fold, 'queued', fold.queuedTs, {}, out);
    }
    if (fold.startedTs !== null && fold.lastRank < RANK.running) {
      emit(fold, 'running', fold.startedTs, {}, out);
    }

    if (event === null || ts === undefined) continue;
    if (state === null || RANK[state] <= fold.lastRank) continue;
    emit(fold, state, ts, row, out);
  }
  return out;
}

const EVENT_KEYS = new Set<keyof AskStatusEvent>([
  'schema', 'ask_id', 'job_id', 'state', 'pool', 'ts', 'pr', 'pr_url',
  'merged_at', 'reverted_at', 'checks', 'reason', 'tokens_total', 'wall_s',
]);

/** Validate one decoded record against the ask.status.v1 contract. */
export function isAskStatusEvent(value: unknown): value is AskStatusEvent {
  const row = object(value);
  if (!row || !Object.keys(row).every((key) => EVENT_KEYS.has(key as keyof AskStatusEvent))) return false;
  const state = stringField(row, 'state');
  return row['schema'] === ASK_STATUS_SCHEMA &&
    typeof row['ask_id'] === 'string' && ASK_ID.test(row['ask_id']) &&
    (row['job_id'] === null || (typeof row['job_id'] === 'string' && JOB_ID.test(row['job_id']))) &&
    state !== undefined && (ASK_STATUS_STATES as readonly string[]).includes(state) &&
    (row['pool'] === null || (typeof row['pool'] === 'string' && (ASK_POOLS as readonly string[]).includes(row['pool']))) &&
    typeof row['ts'] === 'string' && tsOf(row, 'ts') === row['ts'] &&
    (row['pr'] === null || prOf({ pr: row['pr'] }) === row['pr']) &&
    (row['pr_url'] === null || (typeof row['pr_url'] === 'string' && PR_URL.test(row['pr_url']))) &&
    (row['merged_at'] === null || (typeof row['merged_at'] === 'string' && tsOf(row, 'merged_at') === row['merged_at'])) &&
    (row['reverted_at'] === null || (typeof row['reverted_at'] === 'string' && tsOf(row, 'reverted_at') === row['reverted_at'])) &&
    (row['checks'] === null || (CHECKS as readonly string[]).includes(row['checks'] as string)) &&
    (row['reason'] === null || (typeof row['reason'] === 'string' && /^[a-z0-9_]{1,60}$/.test(row['reason']))) &&
    (row['tokens_total'] === null || tokensOf({ tokens_total: row['tokens_total'] }) === row['tokens_total']) &&
    (row['wall_s'] === null ||
      (typeof row['wall_s'] === 'number' && Number.isInteger(row['wall_s']) && row['wall_s'] >= 0 && row['wall_s'] <= 604_800));
}
