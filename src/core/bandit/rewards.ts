/**
 * rewards.ts — the outcome-log record and the reward the bandit optimizes.
 *
 * The queue's recorder appends one `phantom-router-outcome/v1` JSONL row per
 * settled routing decision: which lane actually ran the line, the line's
 * context (size, repo, tier, declared pool), and what the world did next —
 * whether the resulting PR merged within 24h with green CI, what the work
 * cost, and how long CI took on the final head.
 *
 * REWARD (the task's formula, made exact):
 *
 *   success   = 1 when mergedAt exists AND mergedAt − at ≤ 24h AND ciGreen
 *   unit      = clip01(success − cost·min(1, costUsd/costNormUsd)
 *                              − wall·min(1, ciWallMs/wallNormMs))
 *   raw       = the same expression without clipping (reporting only)
 *
 * "cost per merged PR" is the record's costUsd — the cost attributed to the
 * PR this job produced (a job that never merged still spent, so the penalty
 * still applies). Unknown cost or CI wall are treated as ZERO penalty, never
 * synthesized as free or maximal: an absent field is an absence of evidence,
 * not a claim. `raw` may go below 0; `unit` is what the Beta posterior
 * consumes, so it is clipped to [0,1].
 */

export const ROUTER_OUTCOME_SCHEMA = 'phantom-router-outcome/v1';

/** Merge window for the success term: merged within 24 hours. */
export const MERGE_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface OutcomeRecord {
  readonly schema: typeof ROUTER_OUTCOME_SCHEMA;
  /** Queue job id (the RQ-* line's identity). */
  readonly job: string;
  /** ISO timestamp of the routing decision the record describes. */
  readonly at: string;
  /** Lane that actually ran the job (the logged arm). */
  readonly lane: string;
  /** The line's declared pool — context, and the arm when `lane` is absent. */
  readonly pool: string;
  readonly repo: string;
  readonly tier: string;
  /** Line size in lines of change, when known. */
  readonly sizeLines?: number;
  /** Merge timestamp; absent or unparseable = never merged. */
  readonly mergedAt?: string;
  /** CI outcome on the final head; absent = unknown (not green). */
  readonly ciGreen?: boolean;
  /** Wall time of the deciding CI run in ms. */
  readonly ciWallMs?: number;
  /** Cost attributed to this job's PR, in USD. */
  readonly costUsd?: number;
  /** Optional per-pool remaining credits at decision time (floor in replay). */
  readonly credits?: Readonly<Record<string, number>>;
}

export interface RecordReward {
  /** Clipped to [0,1] — what the Beta posterior consumes. */
  readonly unit: number;
  /** Unclipped composite, for honest reporting. */
  readonly raw: number;
  readonly success: boolean;
}

const ID_TOKEN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,159}$/;
const ISO_MS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isoTime(value: unknown): number | null {
  if (typeof value !== 'string' || !ISO_MS.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Strict row validation in the style of queue-metrics: a malformed row is a
 * hard error naming the field, never a silently skipped sample. `lane`
 * defaults to `pool` — a queue line routes to its declared pool unless a
 * router (static or learned) overrode it.
 */
export function outcomeRecordFrom(value: unknown): OutcomeRecord {
  const bad = (field: string): never => {
    throw new Error(`Invalid router outcome row: ${field}`);
  };
  if (!isRecord(value)) return bad('row must be an object');
  const row = value;
  if (row['schema'] !== ROUTER_OUTCOME_SCHEMA) bad(`schema must be ${ROUTER_OUTCOME_SCHEMA}`);
  for (const field of ['job', 'pool', 'repo', 'tier'] as const) {
    if (typeof row[field] !== 'string' || !ID_TOKEN.test(row[field] as string)) bad(`${field} must be an id token`);
  }
  if (isoTime(row['at']) === null) bad('at must be an ISO timestamp');
  const lane = row['lane'] === undefined ? row['pool'] : row['lane'];
  if (typeof lane !== 'string' || !ID_TOKEN.test(lane)) return bad('lane must be an id token');
  if (row['sizeLines'] !== undefined && (typeof row['sizeLines'] !== 'number' || !Number.isFinite(row['sizeLines']))) bad('sizeLines must be finite');
  if (row['mergedAt'] !== undefined && row['mergedAt'] !== null && isoTime(row['mergedAt']) === null) bad('mergedAt must be an ISO timestamp');
  if (row['ciGreen'] !== undefined && typeof row['ciGreen'] !== 'boolean') bad('ciGreen must be boolean');
  for (const field of ['ciWallMs', 'costUsd'] as const) {
    if (row[field] !== undefined && (typeof row[field] !== 'number' || !Number.isFinite(row[field] as number) || (row[field] as number) < 0)) bad(`${field} must be a non-negative number`);
  }
  let credits: Record<string, number> | undefined;
  if (row['credits'] !== undefined) {
    const creditRows = row['credits'];
    if (!isRecord(creditRows)) return bad('credits must be an object');
    credits = {};
    for (const [poolId, remaining] of Object.entries(creditRows)) {
      if (!ID_TOKEN.test(poolId) || typeof remaining !== 'number' || !Number.isFinite(remaining)) return bad('credits entries must be pool ids to finite numbers');
      credits[poolId] = remaining;
    }
  }
  return {
    schema: ROUTER_OUTCOME_SCHEMA,
    job: row['job'] as string,
    at: row['at'] as string,
    lane,
    pool: row['pool'] as string,
    repo: row['repo'] as string,
    tier: row['tier'] as string,
    ...(row['sizeLines'] !== undefined ? { sizeLines: row['sizeLines'] as number } : {}),
    ...(row['mergedAt'] != null ? { mergedAt: row['mergedAt'] as string } : {}),
    ...(row['ciGreen'] !== undefined ? { ciGreen: row['ciGreen'] as boolean } : {}),
    ...(row['ciWallMs'] !== undefined ? { ciWallMs: row['ciWallMs'] as number } : {}),
    ...(row['costUsd'] !== undefined ? { costUsd: row['costUsd'] as number } : {}),
    ...(credits !== undefined ? { credits } : {}),
  };
}

/** The task's reward, exact. See the module header for the formula. */
export function rewardOf(
  record: Pick<OutcomeRecord, 'at' | 'mergedAt' | 'ciGreen' | 'ciWallMs' | 'costUsd'>,
  weights: {
    success: number;
    cost: number;
    wall: number;
    costNormUsd: number;
    wallNormMs: number;
  },
): RecordReward {
  const atMs = isoTime(record.at);
  const mergedMs = record.mergedAt == null ? null : isoTime(record.mergedAt);
  const mergedInWindow = atMs !== null && mergedMs !== null && mergedMs - atMs >= 0 && mergedMs - atMs <= MERGE_WINDOW_MS;
  const success = mergedInWindow && record.ciGreen === true;
  const costTerm = typeof record.costUsd === 'number' && weights.costNormUsd > 0
    ? weights.cost * Math.min(1, record.costUsd / weights.costNormUsd)
    : 0;
  const wallTerm = typeof record.ciWallMs === 'number' && weights.wallNormMs > 0
    ? weights.wall * Math.min(1, record.ciWallMs / weights.wallNormMs)
    : 0;
  const raw = (success ? weights.success : 0) - costTerm - wallTerm;
  return { unit: Math.min(1, Math.max(0, raw)), raw, success };
}
