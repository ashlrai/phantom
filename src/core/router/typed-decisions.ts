import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  effortSchema, routeReasonSchema, speedTierSchema,
} from '../routing/decision-schema.js';
import { readLedgerTail } from './outcomes.js';

// Bounded read of the dispatcher's typed-routing decision journal,
// <runsDir>/metrics/route.explain.jsonl — the `route.explain.v1` rows
// dispatchd's per-tick `observe_typed_route` sample appends after each
// `phm route decide` call (contrib/mac/dispatchd.py). The journal has
// exactly one producer and, until this reader, no consumer: every recorded
// advisory pick, refusal and latency figure stopped at the file. The rows
// carry no job id — the sampled ready row's identity never reaches the
// record — so the digest is fleet-level evidence only: it can say what the
// typed layer decided and how the service behaved, never which job it
// decided for. Nothing here routes, weights or applies anything.

/** `<runsDir>/metrics/route.explain.jsonl` — dispatchd's append-only audit file. */
export const TYPED_DECISIONS_LEDGER_RELATIVE = join('metrics', 'route.explain.jsonl');
export const TYPED_DECISIONS_ROW_SCHEMA = 'route.explain.v1';
export const TYPED_DECISIONS_DIGEST_SCHEMA = 'route.typed-decisions.v1';
/**
 * Newest-bytes bound retained from the append-only journal. One sampled
 * row per dispatcher tick runs to a few hundred bytes, so the bound keeps
 * roughly a week of ticks; `truncated` marks a cut tail honestly.
 */
export const TYPED_DECISIONS_LEDGER_LIMIT = 8 * 1024 * 1024;
/** Tallies report the most frequent entries first, capped for bounded output. */
const MAX_TALLY_ENTRIES = 8;

/** The producer's safe_id alphabet for lane and model (dispatchd's allowlist). */
const JOURNAL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const EFFORTS: ReadonlySet<string> = new Set(effortSchema.options);
const SPEED_TIERS: ReadonlySet<string> = new Set(speedTierSchema.options);
const REASON_CODES: ReadonlySet<string> = new Set(routeReasonSchema.options);
const STATUSES: ReadonlySet<string> = new Set(['observed', 'unavailable']);
/** Producer bounds for the optional service metrics (dispatchd caps each at 1e6). */
const MAX_METRIC = 1_000_000;

type Row = Record<string, unknown>;

const isRow = (value: unknown): value is Row =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const str = (r: Row, ...keys: string[]): string | null => {
  for (const k of keys) {
    const v = r[k];
    if (typeof v === 'string' && v.trim()) return v.trim();
  }
  return null;
};

const boundedCount = (v: unknown): number | null =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= MAX_METRIC ? v : null;

interface JournalDecision {
  lane: string;
  model: string;
  effort: string;
  speed_tier: string;
  reason_codes: string[];
}

/**
 * Validate one row's recorded decision against the producer's closed
 * vocabulary — the same allowlist dispatchd applies before persisting
 * (bounded ids, the effort/speed-tier enums, 1..16 in-vocabulary reason
 * codes). Returns null when any part is missing or malformed: a row the
 * producer could not have written is corrupt evidence, never a decision.
 */
function decisionFrom(raw: unknown): JournalDecision | null {
  if (!isRow(raw)) return null;
  const lane = raw['lane'];
  const model = raw['model'];
  const effort = raw['effort'];
  const speedTier = raw['speed_tier'];
  const reasons = raw['reason_codes'];
  if (typeof lane !== 'string' || !JOURNAL_ID.test(lane)) return null;
  if (typeof model !== 'string' || !JOURNAL_ID.test(model)) return null;
  if (typeof effort !== 'string' || !EFFORTS.has(effort)) return null;
  if (typeof speedTier !== 'string' || !SPEED_TIERS.has(speedTier)) return null;
  if (!Array.isArray(reasons) || reasons.length < 1 || reasons.length > 16) return null;
  const codes: string[] = [];
  for (const code of reasons) {
    if (typeof code !== 'string' || !REASON_CODES.has(code)) return null;
    codes.push(code);
  }
  return { lane, model, effort, speed_tier: speedTier, reason_codes: codes };
}

export interface TypedTally { key: string; decisions: number }

export interface TypedMetricSummary {
  /** Observed rows carrying a well-formed recorded figure. */
  known: number;
  mean: number | null;
  max: number | null;
}

export interface TypedDecisionsDigest {
  schema: typeof TYPED_DECISIONS_DIGEST_SCHEMA;
  /** Ledger read state; anything but 'read' leaves every tally empty — unknown, never zeroed. */
  state: 'read' | 'missing' | 'unreadable' | 'not-file';
  /** True when older bytes were not read; tallies cover the retained window only. */
  truncated: boolean;
  path: string;
  /** Valid route.explain.v1 rows in the retained window. */
  records: number;
  /** Non-blank lines that failed JSON parse or the producer contract. */
  invalid_rows: number;
  /** Rows whose typed decision service returned a validated decision. */
  observed: number;
  /** Rows whose service was unavailable (missing CLI, timeout, invalid output). */
  unavailable: number;
  /** Lane picks across observed rows, most frequent first. */
  lanes: TypedTally[];
  /** Model picks across observed rows, most frequent first. */
  models: TypedTally[];
  /** Reason codes across observed rows — each row contributes each code once. */
  reason_codes: TypedTally[];
  /** Service latency across observed rows carrying a recorded duration_ms. */
  duration_ms: TypedMetricSummary;
  /** Schema-retry attempts across observed rows carrying a recorded attempts. */
  attempts: TypedMetricSummary;
  /** Candidate pool size across observed rows carrying a recorded candidate_count. */
  candidate_count: TypedMetricSummary;
  /** Epoch-second window the retained valid rows span; null when none recorded. */
  oldest_ts: number | null;
  newest_ts: number | null;
}

const tallySort = (a: TypedTally, b: TypedTally) =>
  b.decisions - a.decisions || a.key.localeCompare(b.key);

function tallyAdd(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

const tallyOut = (map: ReadonlyMap<string, number>): TypedTally[] =>
  [...map.entries()]
    .map(([key, decisions]) => ({ key, decisions }))
    .sort(tallySort)
    .slice(0, MAX_TALLY_ENTRIES);

const round1 = (v: number): number => Math.round(v * 10) / 10;

/** The empty digest every degraded read shares — tallies and means stay empty/null, never zeroed. */
const emptyDigest = (state: TypedDecisionsDigest['state'], path: string): TypedDecisionsDigest => ({
  schema: TYPED_DECISIONS_DIGEST_SCHEMA,
  state,
  truncated: false,
  path,
  records: 0,
  invalid_rows: 0,
  observed: 0,
  unavailable: 0,
  lanes: [],
  models: [],
  reason_codes: [],
  duration_ms: { known: 0, mean: null, max: null },
  attempts: { known: 0, mean: null, max: null },
  candidate_count: { known: 0, mean: null, max: null },
  oldest_ts: null,
  newest_ts: null,
});

/**
 * Fold journal text into the digest. Rows count only when they carry the
 * exact producer contract — schema route.explain.v1, the route.explain
 * event name (event|type|kind alias set like the sibling ledger readers),
 * a finite non-negative epoch-second ts, advisory:true and a status inside
 * the producer's observed/unavailable vocabulary. An observed row must
 * also carry a decision passing the producer's own allowlist; anything
 * less is an invalid row — counted, never partially trusted. Optional
 * service metrics join only as bounded non-negative integers and a
 * malformed value drops to unrecorded without discarding the decision.
 */
export function foldTypedDecisions(text: string, path: string, truncated: boolean): TypedDecisionsDigest {
  const digest: TypedDecisionsDigest = {
    schema: TYPED_DECISIONS_DIGEST_SCHEMA,
    state: 'read',
    truncated,
    path,
    records: 0,
    invalid_rows: 0,
    observed: 0,
    unavailable: 0,
    lanes: [],
    models: [],
    reason_codes: [],
    duration_ms: { known: 0, mean: null, max: null },
    attempts: { known: 0, mean: null, max: null },
    candidate_count: { known: 0, mean: null, max: null },
    oldest_ts: null,
    newest_ts: null,
  };
  const lanes = new Map<string, number>();
  const models = new Map<string, number>();
  const reasons = new Map<string, number>();
  let durationSum = 0;
  let durationMax = 0;
  let attemptsSum = 0;
  let attemptsMax = 0;
  let candidateSum = 0;
  let candidateMax = 0;
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    let row: unknown;
    try {
      row = JSON.parse(trimmed);
    } catch {
      digest.invalid_rows += 1;
      continue;
    }
    if (!isRow(row) || row['schema'] !== TYPED_DECISIONS_ROW_SCHEMA ||
        str(row, 'event', 'type', 'kind') !== 'route.explain' ||
        row['advisory'] !== true) {
      digest.invalid_rows += 1;
      continue;
    }
    const ts = row['ts'];
    const status = row['status'];
    if (typeof ts !== 'number' || !Number.isFinite(ts) || ts < 0 ||
        typeof status !== 'string' || !STATUSES.has(status)) {
      digest.invalid_rows += 1;
      continue;
    }
    let decision: JournalDecision | null = null;
    if (status === 'observed') {
      decision = decisionFrom(row['decision']);
      if (decision === null) {
        digest.invalid_rows += 1;
        continue;
      }
    }
    digest.records += 1;
    digest.oldest_ts = digest.oldest_ts === null ? ts : Math.min(digest.oldest_ts, ts);
    digest.newest_ts = digest.newest_ts === null ? ts : Math.max(digest.newest_ts, ts);
    if (status === 'unavailable') {
      digest.unavailable += 1;
      continue;
    }
    digest.observed += 1;
    tallyAdd(lanes, decision!.lane);
    tallyAdd(models, decision!.model);
    for (const code of new Set(decision!.reason_codes)) tallyAdd(reasons, code);
    const duration = boundedCount(row['duration_ms']);
    if (duration !== null) {
      digest.duration_ms.known += 1;
      durationSum += duration;
      durationMax = Math.max(durationMax, duration);
    }
    const attempts = boundedCount(row['attempts']);
    if (attempts !== null) {
      digest.attempts.known += 1;
      attemptsSum += attempts;
      attemptsMax = Math.max(attemptsMax, attempts);
    }
    const candidates = boundedCount(row['candidate_count']);
    if (candidates !== null) {
      digest.candidate_count.known += 1;
      candidateSum += candidates;
      candidateMax = Math.max(candidateMax, candidates);
    }
  }
  digest.lanes = tallyOut(lanes);
  digest.models = tallyOut(models);
  digest.reason_codes = tallyOut(reasons);
  if (digest.duration_ms.known > 0) {
    digest.duration_ms.mean = round1(durationSum / digest.duration_ms.known);
    digest.duration_ms.max = durationMax;
  }
  if (digest.attempts.known > 0) {
    digest.attempts.mean = round1(attemptsSum / digest.attempts.known);
    digest.attempts.max = attemptsMax;
  }
  if (digest.candidate_count.known > 0) {
    digest.candidate_count.mean = round1(candidateSum / digest.candidate_count.known);
    digest.candidate_count.max = candidateMax;
  }
  return digest;
}

/**
 * Read `<runsDir>/metrics/route.explain.jsonl` and fold it into the digest.
 * `runsDir` resolves like explainRoutes' root (the caller's runs dir,
 * ASHLR_RUNS_DIR, then ~/.ashlr-runs). A missing journal is state 'missing'
 * — an absent append-only audit file means no recorded samples, not an
 * error; 'unreadable' and 'not-file' mean evidence exists but cannot be
 * trusted. The read is a bounded tail: an oversized journal reports
 * truncated:true and tallies cover the newest bytes only. Never throws on
 * file content — degraded input is a state, not an exception.
 */
export async function readTypedDecisions(opts: { runsDir?: string; limit?: number } = {}): Promise<TypedDecisionsDigest> {
  const runsDir = opts.runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
  const path = join(runsDir, TYPED_DECISIONS_LEDGER_RELATIVE);
  const read = await readLedgerTail(path, opts.limit ?? TYPED_DECISIONS_LEDGER_LIMIT);
  if (read.state !== 'read') return emptyDigest(read.state, path);
  return foldTypedDecisions(read.text, path, read.truncated);
}
