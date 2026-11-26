/**
 * `queue.supply.v1`: for each pool, does it have enough queued work for the usage it still has?
 * Behind `phm queue supply` and the `supply_low` line of the hourly digest.
 *
 * Joins three reads that already exist and measures nothing new:
 *   usage and reset  pools.v1 (`buildPoolsView`), the same numbers `phm pools` shows;
 *   ready jobs       queue/ready.tsv, counted by the lane hint the work market resolves
 *                    (requirements preferred_lane, else the row's lane cell, else the
 *                    router-queue.md envelope for spec-less rows). Parked rows are held
 *                    out of launch and never counted; rows the market would reject are
 *                    dead work; lane-open rows are shared supply any pool may take;
 *   starts per hour  LAUNCH lines of dispatch-events.log over the last 6 hours.
 * "Hours of work queued" = (hinted + lane-open rows) / starts per hour: the work this
 * pool could take at its recent start rate. A source that cannot be read is null and
 * shown as unknown, never as zero. Pure `buildQueueSupply`; `readQueueSupply` does the reads.
 */
import { constants } from 'node:fs';
import { open, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { poolLabel } from '../usage/runway.js';
import { defaultRunsDir } from './landed-closes-read.js';
import type { PoolRow, PoolsViewV1 } from './pools-view.js';
import { readReadyText } from './ready-row-edit.js';
import { parseReadyMarketRows } from './unfed-market.js';

export const QUEUE_SUPPLY_SCHEMA = 'queue.supply.v1';
/** How far back launches are counted to get a pool's starts per hour. */
export const SUPPLY_STARTS_WINDOW_H = 6;
/** The digest speaks when a pool at risk of waste has less work than this queued. */
export const SUPPLY_LOW_HOURS = 1;

/** empty: usage left and nothing it can take (no hinted or lane-open rows). low: under an hour of available work queued. healthy: enough queued. used-up and held: work waits on the pool. unknown: usage or queue could not be read. */
export type SupplyState = 'empty' | 'low' | 'healthy' | 'used-up' | 'held' | 'unknown';

export interface SupplyRow {
  id: string;
  label: string;
  state: SupplyState;
  /** Share of the window used, 0 to 100; null without a current reading. */
  used_pct: number | null;
  /** Share left, 0 to 100; null without a current reading. */
  left_pct: number | null;
  resets_in_h: number | null;
  reset_at: string | null;
  /** Ready jobs the market hints to this pool; lane-open rows are shared supply counted in open_rows, not here; null when the queue could not be read. */
  ready: number | null;
  /** Launches per hour over the last 6 hours; null when the launch log could not be read. */
  starts_per_hour: number | null;
  /** Work this pool could take at its recent start rate: (ready + lane-open rows) / starts_per_hour; 0 when nothing can run here; null when either input is unknown or nothing has started lately. */
  hours_queued: number | null;
  /** Hours the usage left would last at the current burn (capped at the reset): the time it sits idle with no work; null when unknown. */
  idle_hours: number | null;
  /** The pool is behind (would leave usage unused at reset) or has waste risk high or medium. */
  at_risk: boolean;
  /** at_risk with under 1 hour of work queued (or nothing queued): the digest names this pool. */
  supply_low: boolean;
  /** The whole story in plain words. */
  verdict: string;
  /** Why a figure is unknown; null when everything for this row is known. */
  reason: string | null;
}

export interface QueueSupplyV1 {
  schema: typeof QUEUE_SUPPLY_SCHEMA;
  generated_at: string;
  /** Pools with a supply problem first (empty, low), then used-up, then the rest as `phm pools` orders them. */
  pools: SupplyRow[];
  /** Lane-open ready rows: shared supply the market may place on any pool; the same rows can count toward more than one pool's hours of work. Null when the queue could not be read. */
  open_rows: number | null;
  /** Ready rows the market would reject before launch (bad job id, tier or spec): dead work, never counted as supply. Null when the queue could not be read. */
  invalid_rows: number | null;
  /** What this view cannot see. */
  gaps: string[];
}

export interface QueueSupplyInput {
  view: Pick<PoolsViewV1, 'pools' | 'generatedAt'>;
  /** Ready jobs per lane by the market's resolved hint; null when ready.tsv could not be read. */
  readyByLane: Readonly<Record<string, number>> | null;
  /** Lane-open ready rows (shared supply any pool may take); null when ready.tsv could not be read. */
  openRows: number | null;
  /** Ready rows the market would reject before launch; null when ready.tsv could not be read. */
  invalidRows: number | null;
  /** Launches per lane inside the window; null when the launch log could not be read. */
  startsByLane: Readonly<Record<string, number>> | null;
  /** Window the launches were counted over, in hours. */
  windowH?: number;
}

const round1 = (n: number): number => Math.round(n * 10) / 10;
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`;

/** "Sat 3:30 PM" in the reader's own time zone. */
function dayAndTime(iso: string): string {
  const at = new Date(iso);
  const day = at.toLocaleString('en-US', { weekday: 'short' });
  const time = at.toLocaleString('en-US', { hour: 'numeric', minute: at.getMinutes() === 0 ? undefined : '2-digit' });
  return `${day} ${time}`.replace(/\s/g, ' ');
}

/** "20 min", "1 hour", "3 hours". */
function span(hours: number): string {
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
  const h = Math.round(hours);
  return plural(h, 'hour', 'hours');
}

const atRisk = (row: PoolRow): boolean => row.wasteRisk === 'high' || row.wasteRisk === 'medium' || row.verdict === 'add work';

function rowFor(pool: PoolRow, input: QueueSupplyInput, nowMs: number, windowH: number): SupplyRow {
  const label = poolLabel(pool.id);
  const ready = input.readyByLane === null ? null : input.readyByLane[pool.id] ?? 0;
  // Lane-open rows are shared supply: the market may place them on any pool,
  // so each pool's available work is its hinted rows plus all of them.
  const open = input.openRows ?? 0;
  const available = ready === null ? null : ready + open;
  const starts = input.startsByLane === null ? null : round1((input.startsByLane[pool.id] ?? 0) / windowH);
  const hoursQueued = available === null ? null : available === 0 ? 0 : starts !== null && starts > 0 ? round1(available / starts) : null;
  const resetMs = pool.resetAt === null ? NaN : Date.parse(pool.resetAt);
  const resetsIn = Number.isFinite(resetMs) && resetMs > nowMs ? round1((resetMs - nowMs) / 3_600_000) : null;
  const used = pool.usedPct;
  const left = used === null ? null : round1(Math.max(0, 100 - used));
  const known = used !== null;
  const burn = pool.burnPctPerHour;
  const idle = !known || left === null || left <= 0 ? null
    : burn !== null && burn > 0 ? round1(Math.min(left / burn, resetsIn ?? Infinity)) : resetsIn;
  const risk = known && atRisk(pool);

  const reasons: string[] = [];
  if (ready === null) reasons.push('ready queue not readable');
  if (starts === null) reasons.push('launch log not readable');
  else if (available !== null && available > 0 && starts === 0) reasons.push(`no launches in the last ${windowH} h to size the queue`);
  if (!known) reasons.push(pool.reason ?? 'no usage reading');

  const base = { id: pool.id, label, used_pct: used, left_pct: left, resets_in_h: resetsIn, reset_at: pool.resetAt, ready, starts_per_hour: starts, hours_queued: hoursQueued, idle_hours: idle, at_risk: risk };
  const out = (state: SupplyState, verdict: string, supplyLow = false): SupplyRow =>
    ({ ...base, state, supply_low: supplyLow, verdict, reason: reasons.length ? reasons.join('; ') : null });

  const queued = ready === null ? 'queue unknown'
    : open === 0 ? `${plural(ready, 'job', 'jobs')} queued`
    : `${plural(ready, 'job', 'jobs')} queued for it, ${plural(open, 'lane-open row', 'lane-open rows')} shared`;
  if (!known) return out('unknown', `${label}: usage unknown (${pool.reason ?? 'no usage reading'}), ${queued}`);
  if (pool.held === true) return out('held', `${label}: ${queued}, held${pool.resetAt === null ? '' : ` until ${dayAndTime(pool.resetAt)}`}`);
  if (used >= 100 || pool.verdict === 'fully used') {
    return out('used-up', `${label}: ${queued}, plan used up${pool.resetAt === null ? '' : ` until ${dayAndTime(pool.resetAt)}`}`);
  }
  const leftText = `${Math.round(left!)}% left`;
  if (ready === null) return out('unknown', `${label}: queue unknown, ${leftText}`);
  const idleText = idle === null ? '' : `, about ${span(idle)} of usage idle`;
  if (available === 0) return out('empty', `${label}: 0 jobs queued, ${leftText}${idleText}`, risk);
  if (hoursQueued === null) return out('healthy', `${label}: ${queued}, ${leftText}, no recent starts to size the queue`);
  if (hoursQueued < SUPPLY_LOW_HOURS) return out('low', `${label}: ${queued}, about ${span(hoursQueued)} of work, ${leftText}${idleText}`, risk);
  return out('healthy', `${label}: ${queued}, about ${span(hoursQueued)} of work, ${leftText}`);
}

const ORDER: Record<SupplyState, number> = { empty: 0, low: 1, 'used-up': 2, held: 3, unknown: 4, healthy: 5 };

export function buildQueueSupply(input: QueueSupplyInput): QueueSupplyV1 {
  const nowMs = Date.parse(input.view.generatedAt);
  const windowH = input.windowH ?? SUPPLY_STARTS_WINDOW_H;
  const queueKnown = input.readyByLane !== null;
  const openRows = queueKnown ? input.openRows ?? 0 : null;
  const invalidRows = queueKnown ? input.invalidRows ?? 0 : null;
  const rows = input.view.pools.map(pool => rowFor(pool, input, nowMs, windowH));
  // Stable: pools of one state keep the order `phm pools` gave them.
  const pools = rows.map((row, index) => ({ row, index })).sort((a, b) => ORDER[a.row.state] - ORDER[b.row.state] || a.index - b.index).map(x => x.row);
  const gaps = [
    'Ready jobs are counted by the lane hint the work market resolves (requirements preferred_lane, else the row\'s lane cell, else the router-queue envelope); lane-open rows are shared supply any pool may take and count toward its hours of work.',
    `Starts per hour is the last ${windowH} hours of launches, so a pool that has not launched lately shows its hours of work as unknown.`,
  ];
  if (invalidRows !== null && invalidRows > 0) gaps.push(`${plural(invalidRows, 'ready row', 'ready rows')} fail the market's checks and never launch.`);
  if (input.readyByLane === null) gaps.unshift('The ready queue could not be read.');
  if (input.startsByLane === null) gaps.unshift('The dispatch event log could not be read.');
  return { schema: QUEUE_SUPPLY_SCHEMA, generated_at: input.view.generatedAt, pools, open_rows: openRows, invalid_rows: invalidRows, gaps };
}

/** `phm queue supply`: one verdict line per pool. */
export function formatQueueSupplyText(data: QueueSupplyV1): string {
  if (data.pools.length === 0) return 'No pools reported.';
  return data.pools.map(row => row.verdict).join('\n');
}

/** The digest line: `supply_low: Claude (0 queued, 16% left)`; null when no pool needs work. */
export function supplyLowLine(data: QueueSupplyV1): string | null {
  const low = data.pools.filter(row => row.supply_low);
  if (low.length === 0) return null;
  const part = (row: SupplyRow): string => {
    const available = (row.ready ?? 0) + (data.open_rows ?? 0);
    const queued = available === 0 ? '0 queued' : `${available} queued, about ${span(row.hours_queued ?? 0)} of work`;
    return `${row.label} (${queued}, ${Math.round(row.left_pct ?? 0)}% left)`;
  };
  return `supply_low: ${low.map(part).join(', ')}: add work`;
}

const EVENT_LINE = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\s+LAUNCH\s+\S+\s+\S+\s+(\S+)/;
const TAIL_BYTES = 2 * 1024 * 1024;

/** Launches per lane in the window. Event times are local wall time, as dispatchd writes them. */
export function countStarts(eventsText: string, nowMs: number, windowH = SUPPLY_STARTS_WINDOW_H): Record<string, number> {
  const since = nowMs - windowH * 3_600_000;
  const out: Record<string, number> = {};
  for (const line of eventsText.split('\n')) {
    const m = EVENT_LINE.exec(line);
    if (!m) continue;
    const at = new Date(m[1]!.replace(' ', 'T')).getTime();
    if (Number.isFinite(at) && at >= since && at <= nowMs) out[m[2]!] = (out[m[2]!] ?? 0) + 1;
  }
  return out;
}

async function readTail(path: string): Promise<string> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } finally { await handle.close(); }
}

/** Ready supply counts from queue/ready.tsv, resolved the way the work market resolves them. */
export interface ReadySupplyCounts {
  /** Resolved lane hint → ready rows the market routes there. */
  byLane: Record<string, number>;
  /** Lane-open rows: shared supply the market may place on any pool. */
  openRows: number;
  /** Rows the market would reject before launch (bad job id, tier or spec): dead work, never counted as supply. */
  invalidRows: number;
}

/**
 * Ready jobs per lane the way the work market resolves them: the requirements
 * cell's preferred_lane wins, else the row's lane cell, else the router-queue.md
 * `(attrs)` envelope for spec-less rows. Parked rows, comments and rows the
 * market would reject are never counted; lane-open rows are shared supply.
 */
export function countReady(readyText: string, routerQueue?: string | null): ReadySupplyCounts {
  const { rows, invalid } = parseReadyMarketRows(readyText, routerQueue);
  const byLane: Record<string, number> = {};
  let openRows = 0;
  for (const row of rows) {
    if (row.hint === null) openRows++;
    else byLane[row.hint] = (byLane[row.hint] ?? 0) + 1;
  }
  return { byLane, openRows, invalidRows: invalid };
}

/** router-queue.md is append-mostly Markdown history; give it the same wider bound as the unfed read. */
const ROUTER_QUEUE_MAX_BYTES = 32 * 1024 * 1024;

/** Optional queue inputs degrade to "unknown", never to a wrong count. */
async function readOptional(path: string, maxBytes: number): Promise<string | null> {
  try {
    const info = await stat(path);
    if (!info.isFile() || info.size > maxBytes) return null;
    return await readFile(path, 'utf8');
  } catch { return null; }
}

export async function readQueueSupply(opts: { runsDir?: string; now?: () => number } = {}): Promise<QueueSupplyV1> {
  const runsDir = opts.runsDir ?? defaultRunsDir();
  const nowMs = (opts.now ?? Date.now)();
  const [{ readResourceLedger }, { buildPoolsView }, { readUsageSamples }] = await Promise.all([
    import('./runs-resource-ledger.js'), import('./pools-view.js'), import('./usage-history.js'),
  ]);
  const [view, readyText, routerQueue, startsByLane] = await Promise.all([
    readResourceLedger({ runsDir, now: () => nowMs }).then(async ledger => buildPoolsView(ledger, nowMs, await readUsageSamples({ nowMs }))),
    readReadyText(join(runsDir, 'queue', 'ready.tsv')).catch((error: NodeJS.ErrnoException) => error.code === 'ENOENT' ? '' : null),
    readOptional(join(runsDir, 'queue', 'router-queue.md'), ROUTER_QUEUE_MAX_BYTES),
    readTail(join(runsDir, 'dispatch-events.log')).then(text => countStarts(text, nowMs), () => null),
  ]);
  const ready = readyText === null ? null : countReady(readyText, routerQueue);
  return buildQueueSupply({
    view,
    readyByLane: ready?.byLane ?? null,
    openRows: ready?.openRows ?? null,
    invalidRows: ready?.invalidRows ?? null,
    startsByLane,
  });
}
