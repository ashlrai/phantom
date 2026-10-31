/**
 * Pool routing policy — RQ-MR-7-POOL-ROUTING.
 *
 * The dispatchd line rules, applied where the driver decides what may launch:
 * a queue line names its pool, and the pool is allowed to serve the line only
 * when the line's kind permits it. Two standing rules:
 *
 *   - `codex-personal` serves only LAND, FIXUP, DRAIN and DAILYFIX lines.
 *     Nothing else — including a line whose kind is not recognized — may be
 *     sent there.
 *   - GEN, PLAN, SELFOPT and DESK lines go only to `devin` or `codex-local`.
 *
 * Kinds the rules do not name keep their declared pool (other than
 * `codex-personal`, which they may never take). `codex-personal` is
 * additionally capped at its paced daily share: an optional `daily` window on
 * the pool vests `share` dispatches linearly, so the pool can never be ahead
 * of its even pace for the day. A stale or unstarted window admits nothing —
 * the bridge must supply the fresh window before the share re-opens.
 *
 * PURE: no clock reads (the caller passes `nowMs`), no I/O.
 */

/**
 * A line's kind is the uppercase token at the head of its job id after an
 * optional `RQ-` prefix — the same convention dispatchd's `_kind` uses
 * (`(LAND|FIXUP|RQ-FIXUP|RQ-LAND)` all count as landing work):
 * `RQ-GEN-…` → GEN, `LAND-phantom-1` → LAND, `RQ-MR-7-…` → MR.
 * `RQ-REFILL-…-LAND-…` is REFILL, not LAND: the series token leads. Lowercase
 * or malformed ids have no kind.
 */
const KIND = /^(?:RQ-)?([A-Z][A-Z0-9]*)(?=[-_]|$)/;

export function driveJobKind(jobId: string): string | null {
  return KIND.exec(jobId)?.[1] ?? null;
}

export const CODEX_PERSONAL_POOL = 'codex-personal';

/** The only kinds `codex-personal` may serve. */
export const PERSONAL_ONLY_KINDS: readonly string[] = Object.freeze(['LAND', 'FIXUP', 'DRAIN', 'DAILYFIX']);
const PERSONAL_ONLY = new Set<string>(PERSONAL_ONLY_KINDS);

/** Kinds pinned to the cloud/local pair — never a Codex subscription lane. */
export const CLOUD_ROUTE_KINDS: readonly string[] = Object.freeze(['GEN', 'PLAN', 'SELFOPT', 'DESK']);
const CLOUD_ROUTE = new Set<string>(CLOUD_ROUTE_KINDS);

/** The only pools a cloud-route kind may take. */
export const CLOUD_ROUTE_POOLS: readonly string[] = Object.freeze(['devin', 'codex-local']);
const CLOUD_POOLS = new Set<string>(CLOUD_ROUTE_POOLS);

/**
 * May this job id launch in this pool? `false` means the declared routing is a
 * policy violation: the line is held for review rather than re-routed — pool
 * is spend attribution, and silently moving spend between subscription lanes
 * would defeat the operator's own line.
 */
export function drivePoolAllowed(jobId: string, pool: string): boolean {
  const kind = driveJobKind(jobId);
  if (kind !== null && CLOUD_ROUTE.has(kind)) return CLOUD_POOLS.has(pool);
  if (pool === CODEX_PERSONAL_POOL) return kind !== null && PERSONAL_ONLY.has(kind);
  return true;
}

/**
 * A pool's paced daily share, as the bridge reports it. `share` is the count
 * of dispatches the pool may make across the whole window; `used` is the
 * bridge-verified count already spent in it. The window is defined by the
 * bridge (a provider day, not necessarily a calendar day) — the driver never
 * invents a day boundary of its own.
 */
export interface PoolDayShare {
  share: number;
  used: number;
  /** Epoch milliseconds; `startMs < endMs`. */
  startMs: number;
  endMs: number;
}

export function isPoolDayShare(value: unknown): value is PoolDayShare {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const day = value as Record<string, unknown>;
  return [day.share, day.used].every((n) => Number.isSafeInteger(n) && (n as number) >= 0 && (n as number) <= 100_000)
    && Number.isSafeInteger(day.startMs) && Number.isSafeInteger(day.endMs)
    && (day.endMs as number) > (day.startMs as number);
}

/**
 * Dispatches the share has vested by `nowMs`: `share` spread evenly across the
 * window, floored so the pool is never ahead of its even pace. Outside the
 * window (unstarted or stale) the allowance is zero — never interpret an old
 * window as a fresh one.
 */
export function pacedShareAllowance(day: PoolDayShare, nowMs: number): number {
  if (!Number.isSafeInteger(nowMs) || nowMs < day.startMs || nowMs >= day.endMs) return 0;
  return Math.floor(day.share * (nowMs - day.startMs) / (day.endMs - day.startMs));
}

/** How many more dispatches the pool may take now; never negative. */
export function pacedShareRemaining(day: PoolDayShare, nowMs: number): number {
  return Math.max(0, pacedShareAllowance(day, nowMs) - day.used);
}
