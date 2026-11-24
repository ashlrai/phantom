/**
 * empty-finishes.ts — the jobs-ledger finish fold shared by the empty-job
 * readers (`phm empties`, `phm jobs empty`, fleet empties-why, job gaps and
 * the daemon's empty-tag sync). Pure projection over `empty-cause.ts`'s
 * ledger dialect: newest finish per job inside the window, nothing read
 * from disk here. Split out of empties.ts so evidence-only consumers do not
 * pull the reason-classification subtree.
 */
import { ledgerEventName, ledgerRows, ledgerStateTokens, type LedgerRow } from './empty-cause.js';

/** One job's newest finish in the window. `skipped` means the dispatcher never launched it. */
export interface EmptiesFinish {
  id: string; lane: string; empty: boolean; skipped: boolean;
  tokens: number | null; exitCode: number | null; poolError: boolean;
}

const SKIP_EVENTS = new Set(['precheck_skip', 'skipped_empty']);
const whole = (value: unknown): number | null => typeof value === 'number' && Number.isSafeInteger(value) ? value : null;

/** Pure: the newest finish per job among rows already read, with its time. Shared with `phm throughput`. */
export function finishesIn(rows: readonly LedgerRow[]): (EmptiesFinish & { at: number })[] {
  const newest = new Map<string, EmptiesFinish & { at: number }>();
  const launches = new Map<string, number>();
  for (const { row, id, lane, at } of [...rows].sort((a, b) => a.at - b.at)) {
    if (!id) continue;
    const eventName = ledgerEventName(row);
    if (eventName === 'launch') {
      launches.set(id, at);
      continue;
    }
    // `applied: false` is the skip gate's dry run: the job still launched, so only its finish row counts.
    const skipped = eventName !== null && SKIP_EVENTS.has(eventName) && row.applied !== false;
    const marked = ledgerStateTokens(row).includes('EMPTY_DONE');
    const ended = eventName === 'finish' || (eventName === 'outcome' && typeof row.empty === 'boolean');
    if (!skipped && !marked && !ended) continue;
    const previous = newest.get(id);
    const launch = launches.get(id);
    const prior = previous && (launch === undefined || launch <= previous.at) ? previous : undefined;
    const tokens = whole(row.tokens_total);
    newest.set(id, {
      id, at, skipped,
      lane: lane === 'unknown' && prior ? prior.lane : lane,
      empty: skipped || marked || row.empty === true,
      tokens: tokens !== null && tokens >= 0 ? tokens : prior?.tokens ?? null,
      exitCode: whole(row.exit_code) ?? prior?.exitCode ?? null,
      poolError: (typeof row.pool_error === 'string' && row.pool_error !== '') || (prior?.poolError ?? false),
    });
  }
  return [...newest.values()];
}

/** Pure: every job that finished in the window, newest row per job. */
export function ledgerFinishes(ledger: string, now: number, hours: number): { finishes: EmptiesFinish[]; malformed: number } {
  const { rows, malformed } = ledgerRows(ledger, now, hours);
  return { finishes: finishesIn(rows).map(({ at: _at, ...finish }) => finish), malformed };
}
