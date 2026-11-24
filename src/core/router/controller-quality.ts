/**
 * controller-quality.ts — bounded read of the fleet controller's recorded
 * lane-quality verdicts for the advisory router-weight report.
 *
 * dispatchd's fleet controller scores each lane's post-merge outcome quality
 * every tick (contrib/mac/fleet_controller.py `outcome_quality`) and persists
 * the newest verdict per lane as `route.quality.v1` receipts inside
 * `<runsDir>/queue/fleet-controller.json` (`FC_STATE["quality_receipts"]`,
 * enriched with `mode`/`target_from`/`target_to` by the dispatcher). Until
 * now the only consumer was `phm route explain`; the weight-proposals report
 * — the surface that already folds every other recorded outcome signal —
 * could not see which lanes the controller was actively penalizing.
 *
 * Honesty rules (same stance as outcomes.ts):
 *   - the state file is one bounded JSON document; anything past the limit,
 *     non-JSON, or a `quality_receipts` member that is not an array is
 *     reported as its own state, never silently treated as "no verdicts";
 *   - a missing `quality_receipts` member means the controller never
 *     recorded verdicts — 'read' with an empty list is a real measurement;
 *   - each receipt must carry the v1 schema, a lane-shaped id and a finite
 *     decision timestamp to join at all; every other field joins only in
 *     its recorded shape and stays null when malformed;
 *   - `reason` and `mode` are closed producer vocabularies; unrecognized
 *     spellings join as null, never echoed raw;
 *   - when the file records the same lane twice the newest `ts` wins (ties
 *     go to the later row), matching the append-only ledger convention;
 *   - nothing here routes, weights or applies anything — the receipts are
 *     reported as evidence context only.
 */

import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { readLedgerFile, type LedgerReadState } from './outcomes.js';

/** `<runsDir>/queue/fleet-controller.json` — dispatchd's atomic controller state. */
export const CONTROLLER_QUALITY_STATE_RELATIVE = join('queue', 'fleet-controller.json');
export const CONTROLLER_QUALITY_RECEIPT_SCHEMA = 'route.quality.v1';
/** The state file is small; a megabyte is already generous headroom. */
const CONTROLLER_QUALITY_STATE_LIMIT = 1024 * 1024;
/** Defensive bound on distinct lanes reported; the producer writes ~one per configured lane. */
const MAX_QUALITY_LANES = 64;

/** Same bound the market lane-blocked hints use for lane identifiers. */
const LANE_ID = /^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/;

/** fleet_controller.py outcome_quality reason vocabulary. */
const QUALITY_REASONS = new Set([
  'unmeasured',
  'minimum_samples',
  'deadband',
  'minimum_residency',
  'quality_adjustment',
  'same_quality',
]);
/** dispatchd's controller-mode enrichment vocabulary. */
const QUALITY_MODES = new Set(['enforce', 'shadow']);

export interface ControllerQualityReceipt {
  lane: string;
  /** Epoch seconds the controller recorded the verdict; required — it orders newest-wins. */
  ts: number;
  /** Epoch seconds the quality decision was computed; null when unrecorded. */
  decided_at: number | null;
  /** ISO timestamp of the eval report the score came from; null when unrecorded. */
  report_at: string | null;
  /** Resolved (stable + adverse) merges behind the score; null when unmeasured. */
  resolved: number | null;
  /** Post-merge quality score in [0, 1]; null when unmeasured. */
  score: number | null;
  /** CI-adverse correlation behind the score in [-1, 1]; null when unmeasured. */
  ci_adverse_delta: number | null;
  /** Router weight before the verdict; null when unrecorded. */
  from: number | null;
  /** Router weight after the verdict; null when unrecorded. */
  to: number | null;
  /** Closed-vocabulary verdict reason; null when absent or unrecognized. */
  reason: string | null;
  /** Controller mode the verdict ran under; null when absent or unrecognized. */
  mode: string | null;
  /** Slot target before the verdict; null when unrecorded. */
  target_from: number | null;
  /** Slot target after the verdict; null when unrecorded. */
  target_to: number | null;
}

export type ControllerQualityState = LedgerReadState | 'invalid';

export interface ControllerQualityRead {
  state: ControllerQualityState;
  path: string;
  /** Newest validated receipt per lane, sorted by lane; empty unless state==='read'. */
  receipts: ControllerQualityReceipt[];
  /** Receipt rows rejected by validation; null unless state==='read'. */
  invalid_rows: number | null;
}

const finiteIn = (v: unknown, lo: number, hi: number): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null;
const countOrNull = (v: unknown): number | null =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null;
const boundedTextOrNull = (v: unknown): string | null =>
  typeof v === 'string' && v.length > 0 && v.length <= 64 ? v : null;

/** Parse one raw receipt row; null when it cannot be attributed to a lane verdict at all. */
function receiptFrom(raw: unknown): ControllerQualityReceipt | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  if (row['schema'] !== CONTROLLER_QUALITY_RECEIPT_SCHEMA) return null;
  const lane = row['lane'];
  if (typeof lane !== 'string' || !LANE_ID.test(lane)) return null;
  const ts = row['ts'];
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts < 0) return null;
  const reason = row['reason'];
  const mode = row['mode'];
  return {
    lane,
    ts,
    decided_at: finiteIn(row['decided_at'], 0, Number.MAX_SAFE_INTEGER),
    report_at: boundedTextOrNull(row['report_at']),
    resolved: countOrNull(row['resolved']),
    score: finiteIn(row['score'], 0, 1),
    ci_adverse_delta: finiteIn(row['ci_adverse_delta'], -1, 1),
    from: finiteIn(row['from'], 0, 1),
    to: finiteIn(row['to'], 0, 1),
    reason: typeof reason === 'string' && QUALITY_REASONS.has(reason) ? reason : null,
    mode: typeof mode === 'string' && QUALITY_MODES.has(mode) ? mode : null,
    target_from: countOrNull(row['target_from']),
    target_to: countOrNull(row['target_to']),
  };
}

/**
 * Read `<runsDir>/queue/fleet-controller.json` and return the newest
 * `route.quality.v1` receipt per lane. `runsDir` resolves like
 * readRouterOutcomes (ASHLR_RUNS_DIR, then ~/.ashlr-runs) and must be
 * absolute when given. Never throws on file content — degraded input is a
 * state, not an exception.
 */
export async function readControllerQuality(opts: { runsDir?: string } = {}): Promise<ControllerQualityRead> {
  const runsDir = opts.runsDir ?? process.env['ASHLR_RUNS_DIR'] ?? join(homedir(), '.ashlr-runs');
  if (!isAbsolute(runsDir)) throw new RangeError('runsDir must be an absolute path');
  const path = join(runsDir, CONTROLLER_QUALITY_STATE_RELATIVE);
  const read = await readLedgerFile(path, CONTROLLER_QUALITY_STATE_LIMIT);
  if (read.state !== 'read') {
    return { state: read.state, path, receipts: [], invalid_rows: null };
  }
  let doc: unknown;
  try {
    doc = JSON.parse(read.text);
  } catch {
    return { state: 'invalid', path, receipts: [], invalid_rows: null };
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return { state: 'invalid', path, receipts: [], invalid_rows: null };
  }
  const raw = (doc as Record<string, unknown>)['quality_receipts'];
  if (raw === undefined) {
    // The controller state predates quality verdicts (or never reached the
    // quality pass): the file is healthy and zero verdicts is the truth.
    return { state: 'read', path, receipts: [], invalid_rows: 0 };
  }
  if (!Array.isArray(raw)) {
    return { state: 'invalid', path, receipts: [], invalid_rows: null };
  }
  const newest = new Map<string, ControllerQualityReceipt>();
  let invalid = 0;
  for (const row of raw) {
    const receipt = receiptFrom(row);
    if (receipt === null) {
      invalid += 1;
      continue;
    }
    const held = newest.get(receipt.lane);
    if (held === undefined || receipt.ts >= held.ts) newest.set(receipt.lane, receipt);
  }
  const receipts = [...newest.values()]
    .sort((a, b) => a.lane.localeCompare(b.lane))
    .slice(0, MAX_QUALITY_LANES);
  return { state: 'read', path, receipts, invalid_rows: invalid };
}
