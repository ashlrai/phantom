/**
 * `pools.waste.v1`: which pools are about to waste included usage, and the one fix for each. Behind
 * `phm pools waste`, the first waste line of the hourly digest and the phone Asks card.
 *
 * A pool is flagged when it resets within 12 hours AND (waste risk is high OR at least 25% would go unused).
 * Derived from pools.v1 (`buildPoolsView`) and queue.supply.v1 (`buildQueueSupply`); nothing is re-measured.
 * A pool with no current reading is listed as unknown, never flagged and never counted as healthy.
 *
 * One fix per alert, in plain words, picked in this order:
 *   sign-in    the lane is held and its held reason says sign in: "sign in to Gemini once: run gemini in a terminal"
 *   lane-held  the lane is held for another reason: "lane held: <reason>"
 *   add-work   the queue is short: "queue more work for Claude"
 *   check-lane work is queued but the pool is not spending it: "Claude has 9 jobs queued but is not taking them: check the lane"
 * Only a sign-in needs Mason; every other fix is the fleet's own.
 */
import { poolLabel } from '../usage/runway.js';
import type { PoolRow, PoolsViewV1 } from './pools-view.js';
import type { QueueSupplyV1 } from './queue-supply.js';

export const POOLS_WASTE_SCHEMA = 'pools.waste.v1';
/** Only a pool resetting within this many hours is flagged: there is still time to fix it. */
export const WASTE_WINDOW_HOURS = 12;
/** Flag a pool whose projected unused share at reset is at least this many percent, even below waste risk high. */
export const WASTE_UNUSED_PCT = 25;

export type WasteFixKind = 'sign-in' | 'lane-held' | 'add-work' | 'check-lane';

export interface WasteAlert {
  pool: string;
  label: string;
  fix_kind: WasteFixKind;
  /** The one fix, in plain words. */
  fix: string;
  /** True only when Mason must do the fix (a one-time sign-in); the phone Asks card carries it. */
  needs_mason: boolean;
  used_pct: number;
  projected_unused_pct: number;
  hours_to_reset: number;
  reset_at: string | null;
  waste_risk: PoolRow['wasteRisk'];
  /** The alert in one line: "Gemini: 85% will go unused in 5 h. Sign in to Gemini once: run gemini in a terminal." */
  summary: string;
}
export interface WasteUnknown { pool: string; label: string; reason: string }
export interface PoolsWasteV1 {
  schema: typeof POOLS_WASTE_SCHEMA;
  generated_at: string;
  window_hours: number;
  unused_pct_threshold: number;
  /** Largest projected waste first, then soonest reset. */
  alerts: WasteAlert[];
  /** The first alert, or null when nothing is about to be wasted. */
  top: WasteAlert | null;
  /** Pools with no current reading: not flagged, not healthy. */
  unknown: WasteUnknown[];
  /** Pools with a reading and no alert. */
  ok: string[];
  gaps: string[];
}

export interface PoolsWasteInput {
  view: Pick<PoolsViewV1, 'pools' | 'generatedAt'>;
  /** Null when the queue could not be read: the fix then reads as "queue more work". */
  supply: Pick<QueueSupplyV1, 'pools'> | null;
  /** Why each held lane is held, from the dispatcher status; absent or null when not given. */
  heldReasons?: Readonly<Record<string, string | null>>;
}

const SIGN_IN_REASON = /sign[ -]?in|log[ -]?in|logged out|not authenticated|unauthori[sz]ed|auth(?:entication)? (?:expired|required|missing)/i;
/** What to run, by pool. A pool not listed gets the generic sentence. */
const SIGN_IN_STEP: Readonly<Record<string, string>> = {
  gemini: 'run gemini in a terminal',
  claude: 'run phm authority claude-signin',
};

const round1 = (n: number): number => Math.round(n * 10) / 10;
const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim().replace(/[.\s]+$/, '');

/** The one rule for "this lane waits on a sign-in": held, and the held reason says sign in. Shared by the waste check and the spend-down chart. */
export function signInFix(row: Pick<PoolRow, 'id' | 'held'>, heldReasons: Readonly<Record<string, string | null>> | undefined): string | null {
  if (row.held !== true || !SIGN_IN_REASON.test(oneLine(heldReasons?.[row.id] ?? ''))) return null;
  const step = SIGN_IN_STEP[row.id];
  return `sign in to ${poolLabel(row.id)} once${step ? `: ${step}` : ''}`;
}

function fixFor(row: PoolRow, label: string, input: PoolsWasteInput): { kind: WasteFixKind; fix: string } {
  const reason = row.held === true ? oneLine(input.heldReasons?.[row.id] ?? '') : '';
  const signIn = signInFix(row, input.heldReasons);
  if (signIn !== null) return { kind: 'sign-in', fix: signIn };
  if (row.held === true) return { kind: 'lane-held', fix: `lane held: ${reason || 'no reason recorded'}` };
  const queued = input.supply?.pools.find(p => p.id === row.id);
  if (queued && queued.ready !== null && queued.ready > 0 && queued.state === 'healthy') {
    return { kind: 'check-lane', fix: `${label} has ${queued.ready} ${queued.ready === 1 ? 'job' : 'jobs'} queued but is not spending it: check the lane` };
  }
  return { kind: 'add-work', fix: `queue more work for ${label}` };
}

const upperFirst = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

export function buildPoolsWaste(input: PoolsWasteInput): PoolsWasteV1 {
  const alerts: WasteAlert[] = [];
  const unknown: WasteUnknown[] = [];
  const ok: string[] = [];
  for (const row of input.view.pools) {
    const label = poolLabel(row.id);
    if (row.usedPct === null || row.projectedUnusedPct === null || row.hoursLeft === null || row.wasteRisk === 'unknown') {
      unknown.push({ pool: row.id, label, reason: row.reason ?? 'no current reading' });
      continue;
    }
    const waste = row.wasteRisk === 'high' || row.projectedUnusedPct >= WASTE_UNUSED_PCT;
    if (!waste || row.hoursLeft <= 0 || row.hoursLeft > WASTE_WINDOW_HOURS) { ok.push(row.id); continue; }
    const { kind, fix } = fixFor(row, label, input);
    const hours = Math.max(1, Math.round(row.hoursLeft));
    alerts.push({
      pool: row.id, label, fix_kind: kind, fix, needs_mason: kind === 'sign-in',
      used_pct: row.usedPct, projected_unused_pct: row.projectedUnusedPct, hours_to_reset: row.hoursLeft,
      reset_at: row.resetAt, waste_risk: row.wasteRisk,
      summary: `${label}: ${Math.round(row.projectedUnusedPct)}% will go unused in ${hours} h. ${upperFirst(fix)}.`,
    });
  }
  alerts.sort((a, b) => b.projected_unused_pct - a.projected_unused_pct || a.hours_to_reset - b.hours_to_reset || (a.pool < b.pool ? -1 : 1));
  const gaps = [`Only pools that reset within ${WASTE_WINDOW_HOURS} hours are flagged; a pool further out is not listed here, see phm pools.`];
  if (input.supply === null) gaps.unshift('The queue could not be read, so a short queue is assumed.');
  return {
    schema: POOLS_WASTE_SCHEMA, generated_at: input.view.generatedAt, window_hours: WASTE_WINDOW_HOURS,
    unused_pct_threshold: WASTE_UNUSED_PCT, alerts, top: alerts[0] ?? null, unknown, ok, gaps,
  };
}

/** `phm pools waste`: one line per alert, the fix in plain words; unknown pools named so silence is not read as healthy. */
export function formatPoolsWasteText(data: PoolsWasteV1): string {
  const lines: string[] = [];
  if (data.alerts.length === 0) lines.push(`No pool is about to waste usage (checked pools resetting within ${data.window_hours} h).`);
  for (const alert of data.alerts) {
    lines.push(alert.summary);
    lines.push(`  used ${round1(alert.used_pct)}%; resets in ${round1(alert.hours_to_reset)} h${alert.needs_mason ? '; needs you: one-time step, also on your phone Asks card' : ''}`);
  }
  for (const item of data.unknown) lines.push(`${item.label}: unknown (${item.reason})`);
  return lines.join('\n');
}

/** The digest line for the top alert, or null when nothing is about to be wasted. */
export const wasteDigestLine = (data: PoolsWasteV1): string | null => data.top?.summary ?? null;

/** The phone Asks card text for an alert that needs Mason. */
export function wasteAskRequest(alert: WasteAlert): string {
  return `${upperFirst(alert.fix)}. ${alert.label} will waste about ${Math.round(alert.projected_unused_pct)}% of its included usage at its reset in ${Math.max(1, Math.round(alert.hours_to_reset))} h.`;
}

/** Reads the ledger, usage history, queue and held reasons, then builds the waste check. Read-only. */
export async function readPoolsWaste(opts: { runsDir?: string; now?: () => number } = {}): Promise<PoolsWasteV1> {
  const nowMs = (opts.now ?? Date.now)();
  const [{ readResourceLedger }, { buildPoolsView }, { readUsageSamples }, { readQueueSupply }, { readFleetRunsDirState }] = await Promise.all([
    import('./runs-resource-ledger.js'), import('./pools-view.js'), import('./usage-history.js'), import('./queue-supply.js'), import('./runs-dir-state.js'),
  ]);
  const runs = opts.runsDir === undefined ? {} : { runsDir: opts.runsDir };
  const view = buildPoolsView(await readResourceLedger({ ...runs, now: () => nowMs }), nowMs, await readUsageSamples({ nowMs }));
  const [supply, state] = await Promise.all([
    readQueueSupply({ ...runs, now: () => nowMs }).catch(() => null),
    readFleetRunsDirState({ ...runs, now: () => nowMs }).catch(() => null),
  ]);
  const heldReasons = Object.fromEntries((state?.lanes ?? []).filter(l => l.held).map(l => [l.lane, l.heldReason]));
  return buildPoolsWaste({ view, supply, heldReasons });
}

/**
 * Puts a sign-in alert on the phone Asks card (an open `password` ask about the pool). Idempotent: the same open ask is
 * returned, not duplicated. Returns the ask id, or null when the top alert needs no one or the ledger is unwritable.
 */
export async function raiseWasteAsk(data: PoolsWasteV1, options: { runsDir?: string; now?: () => number } = {}): Promise<string | null> {
  const alert = data.alerts.find(a => a.needs_mason);
  if (!alert) return null;
  const { raiseAsk } = await import('./asks.js');
  const raised = raiseAsk('password', wasteAskRequest(alert), options, { subject: alert.pool, unblocks: `${alert.label} usage that would otherwise expire` });
  return raised.ok ? raised.id : null;
}
