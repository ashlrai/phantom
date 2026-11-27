/**
 * `phm asks sync` (schema asks.sync.v1): raise the asks only Mason can answer from the pools' own verdicts,
 * and close them when the verdict clears. It reads; it never signs in and never spends.
 *
 *   signin   a pool whose spend-down verdict is "blocked: sign-in": one `password` ask (done / later).
 *   payment  a credits pool with a balance and a future expiry whose lane is set to zero: one `payment` ask (yes / no).
 *
 * One ask per pool and kind: an open ask for the same pool is kept, never doubled, so a re-run adds nothing.
 * The ask expires at the pool's reset or expiry time. When the verdict clears, the ask is resolved with the reply
 * "cleared" from source leader, not from Mason. Sync only closes asks it can recognise as its own (a pool subject, the
 * `would otherwise expire` note); a hand-raised ask is left alone.
 * An unreadable ledger or unreadable held reasons are reported as unknown: no ask is invented, none is closed.
 */
import { poolLabel } from '../usage/runway.js';
import { listAsks, raiseAsk, type AsksOptions } from './asks.js';
import { resolveNeedsMason } from './needs-mason-resolve.js';
import { monthDay, type PoolRow, type PoolsViewV1 } from './pools-view.js';
import { buildSpendDown } from './pools-spenddown.js';

export const ASKS_SYNC_SCHEMA = 'asks.sync.v1';
export type SyncKind = 'signin' | 'payment';
/** The ledger kind each sync kind uses: a sign-in is answered done / later, a credit yes / no. */
const ASK_KIND = { signin: 'password', payment: 'payment' } as const;
/** Ends the `unblocks` note of every ask sync raises (the older waste ask uses it too), so sync can tell its own. */
const OWNED_NOTE = /would otherwise expire$/;
export const CLEARED_REPLY = 'cleared: the pool no longer needs this';

export interface SyncItem {
  pool: string;
  kind: SyncKind;
  /** Plain one-line ask. */
  text: string;
  /** What Mason may answer. */
  replies: string[];
  /** When the pool resets or the credit ends; null when it is not known. */
  expires: string | null;
  /** The ask's ledger id; null for a dry run that would raise it. */
  askId: string | null;
}
export interface AsksSyncV1 {
  schema: typeof ASKS_SYNC_SCHEMA;
  asOf: string;
  dryRun: boolean;
  /** unknown: the ledger could not be read, so nothing was raised or closed. */
  status: 'ok' | 'unknown';
  reason: string | null;
  /** Asks added now (dry run: that would be added). */
  raised: SyncItem[];
  /** Asks already open, left as they are. */
  kept: SyncItem[];
  /** Asks closed because the verdict cleared (dry run: that would be closed). */
  resolved: SyncItem[];
  /** Pools whose verdict could not be told, so no ask was raised or closed for them. */
  unknown: Array<{ pool: string; reason: string }>;
}

/** What the pools say right now. heldReasons is null when the held lanes could not be read. */
export interface SyncInputs {
  view: Pick<PoolsViewV1, 'pools' | 'generatedAt'>;
  ledgerReadable: boolean;
  heldReasons: Readonly<Record<string, string | null>> | null;
}
export interface SyncOptions extends AsksOptions { dryRun?: boolean; read?: () => Promise<SyncInputs> }

const SUBJECT = /^[a-z0-9][a-z0-9-]{0,40}$/;
const futureIso = (iso: string | null, nowMs: number): string | null => {
  const ms = iso === null ? NaN : Date.parse(iso);
  return Number.isFinite(ms) && ms > nowMs ? new Date(ms).toISOString() : null;
};
const day = (iso: string): string => iso.slice(0, 10);

/** The asks the pools call for, plus the pools whose verdict could not be told. Pure. */
export function wantedAsks(input: SyncInputs, nowMs: number): { wanted: SyncItem[]; unknown: AsksSyncV1['unknown']; checked: Set<string> } {
  const wanted: SyncItem[] = [];
  const unknown: AsksSyncV1['unknown'] = [];
  const checked = new Set<string>();
  const byId = new Map<string, PoolRow>(input.view.pools.map(row => [row.id, row]));
  if (input.heldReasons === null) unknown.push({ pool: '*', reason: 'held lanes could not be read, so sign-in blocks are unknown' });
  else {
    for (const row of buildSpendDown(input.view, { heldReasons: input.heldReasons }).pools) {
      const key = `${row.id}:signin`;
      checked.add(key);
      if (row.blocked !== 'sign-in') continue;
      const label = poolLabel(row.id);
      const step = row.blocked_fix ? `${row.blocked_fix[0]!.toUpperCase()}${row.blocked_fix.slice(1)}` : `Sign in to ${label} once`;
      wanted.push({
        pool: row.id, kind: 'signin', replies: ['done', 'later'], askId: null, expires: futureIso(row.reset_at, nowMs),
        text: `${step}. Its included usage goes unused until it resets.`,
      });
    }
  }
  for (const row of byId.values()) {
    if (row.kind !== 'credits') continue;
    const expires = futureIso(row.resetAt, nowMs);
    // A closed lane (open: false) is set to zero by definition: its credit ends unspent.
    const target = row.creditClosed === true ? 0 : row.target;
    if (row.creditsRemaining === null || row.resetAt === null || target === null) {
      // A dollar gift names what is missing; a stale or unreported balance is unknown, never 0.
      const missing = row.creditUnit === 'usd'
        ? [row.creditsRemaining === null ? 'balance (not reported, or no reading date)' : '', row.resetAt === null ? 'expiry' : '', target === null ? 'lane target' : ''].filter(Boolean).join(', ')
        : '';
      unknown.push({ pool: row.id, reason: row.creditUnit === 'usd' ? `${poolLabel(row.id)} credit ${missing} unknown, so no ask was raised` : 'credit balance, expiry or lane target is not reported' });
      continue;
    }
    checked.add(`${row.id}:payment`);
    // Only a credit that ends unused: a balance left, a future expiry and a lane set to zero.
    if (target !== 0 || !(row.creditsRemaining > 0) || expires === null) continue;
    const stale = row.creditAsOf != null && nowMs - Date.parse(row.creditAsOf) > 24 * 3_600_000;
    wanted.push({
      pool: row.id, kind: 'payment', replies: ['yes', 'no'], askId: null, expires,
      text: row.creditUnit === 'usd'
        ? `${stale ? `Last reading ${monthDay(row.creditAsOf!)}: about` : 'About'} ${Math.round(row.creditsRemaining)} USD of ${poolLabel(row.id)} credit expires ${monthDay(expires)}${row.creditClosed ? ' and its lane is closed' : ''}. Use it? yes / no`
        : `Use the ${poolLabel(row.id)} credit before it ends ${day(expires)}? Its lane is set to zero. Yes records use it, no records skip; nothing is spent.`,
    });
  }
  return { wanted, unknown, checked };
}

/** Reads the resource ledger, usage history and held lanes (read-only). A failed read is reported, never guessed. */
export async function readSyncInputs(opts: { runsDir?: string; now: () => number }): Promise<SyncInputs> {
  const nowMs = opts.now();
  const [{ readResourceLedger }, { buildPoolsView }, { readUsageSamples }, { readFleetRunsDirState }] = await Promise.all([
    import('./runs-resource-ledger.js'), import('./pools-view.js'), import('./usage-history.js'), import('./runs-dir-state.js'),
  ]);
  const runs = opts.runsDir === undefined ? {} : { runsDir: opts.runsDir };
  const ledger = await readResourceLedger({ ...runs, now: () => nowMs }).catch(() => null);
  const view = buildPoolsView(ledger ?? { v: 1, generatedAt: new Date(nowMs).toISOString(), sources: { status: 'missing', apiSpend: 'missing', jobs: 'missing' }, asOf: null, lanes: [], apiSpend: null, jobsMalformedRows: null },
    nowMs, await readUsageSamples({ ...runs, nowMs }).catch(() => []));
  const state = await readFleetRunsDirState({ ...runs, now: () => nowMs }).catch(() => null);
  const heldReasons = state === null ? null : Object.fromEntries(state.lanes.filter(l => l.held).map(l => [l.lane, l.heldReason]));
  return { view, ledgerReadable: ledger !== null && ledger.sources.status === 'healthy', heldReasons };
}

export async function syncAsks(options: SyncOptions = {}): Promise<AsksSyncV1> {
  const now = options.now ?? Date.now;
  const nowMs = now();
  const dryRun = options.dryRun === true;
  const out: AsksSyncV1 = { schema: ASKS_SYNC_SCHEMA, asOf: new Date(nowMs).toISOString(), dryRun, status: 'ok', reason: null, raised: [], kept: [], resolved: [], unknown: [] };
  const stop = (reason: string): AsksSyncV1 => ({ ...out, status: 'unknown', reason });
  let input: SyncInputs;
  try { input = await (options.read ?? (() => readSyncInputs({ ...(options.runsDir ? { runsDir: options.runsDir } : {}), now })))(); }
  catch { return stop('The resource ledger could not be read, so no ask was raised or closed.'); }
  if (!input.ledgerReadable) return stop('The resource ledger is missing or degraded, so no ask was raised or closed.');
  const open = listAsks({ ...options, now });
  if (open.ledger === 'unavailable') return stop('The needs-you ledger could not be read, so no ask was raised or closed.');

  const { wanted, unknown, checked } = wantedAsks(input, nowMs);
  out.unknown = unknown;
  const owned = open.asks.filter(ask => ask.subject !== null && (ask.kind === 'signin' || ask.kind === 'password' || ask.kind === 'payment') && OWNED_NOTE.test(ask.unblocks ?? ''));
  // Sign-in asks read back as `signin` (stored `password`); either spelling is the same ask.
  const kindOf = (ask: { kind: string }): SyncKind => ask.kind === 'payment' ? 'payment' : 'signin';
  const ownedFor = (pool: string, kind: SyncKind) => owned.find(ask => ask.subject === pool && kindOf(ask) === kind);
  const unblocksOf = (item: SyncItem) => `${poolLabel(item.pool)} ${item.kind === 'signin' ? 'usage' : 'credit'} that would otherwise expire`;

  for (const item of wanted) {
    const have = ownedFor(item.pool, item.kind);
    if (have) { out.kept.push({ ...item, askId: have.id, expires: have.expires }); continue; }
    if (!SUBJECT.test(item.pool)) { out.unknown.push({ pool: item.pool, reason: 'the pool name cannot be an ask subject' }); continue; }
    if (dryRun) { out.raised.push(item); continue; }
    const raised = raiseAsk(ASK_KIND[item.kind], item.text, { ...options, now }, {
      subject: item.pool, unblocks: unblocksOf(item), ...(item.expires ? { expires: item.expires } : {}),
    });
    if (raised.ok) (raised.duplicate ? out.kept : out.raised).push({ ...item, askId: raised.id });
    else out.unknown.push({ pool: item.pool, reason: raised.reason });
  }
  // Close an ask only when its pool was checked this run and no longer calls for it.
  for (const ask of owned) {
    const kind = kindOf(ask);
    if (!checked.has(`${ask.subject}:${kind}`) || wanted.some(item => item.pool === ask.subject && item.kind === kind)) continue;
    const item: SyncItem = { pool: ask.subject!, kind, text: ask.request, replies: ask.replies, expires: ask.expires, askId: ask.id };
    if (dryRun) { out.resolved.push(item); continue; }
    const closed = resolveNeedsMason({ itemId: ask.id, reply: CLEARED_REPLY }, { ...(options.runsDir ? { runsDir: options.runsDir } : {}), source: 'leader', now, ...(options.bus ? { bus: options.bus } : {}) });
    if (closed.ok || closed.code === 'already-resolved') out.resolved.push(item);
    else out.unknown.push({ pool: item.pool, reason: 'the ask could not be closed' });
  }
  return out;
}

/** Plain words for the terminal: what was raised, kept, closed, and what could not be told. */
export function asksSyncText(sync: AsksSyncV1): string {
  if (sync.status === 'unknown') return `Asks: unknown. ${sync.reason}`;
  const verb = sync.dryRun ? ['Would raise', 'Would close'] : ['Raised', 'Closed'];
  const lines = [
    ...sync.raised.map(item => `${verb[0]}: ${item.text}${item.expires ? ` (expires ${item.expires.slice(0, 10)})` : ''}`),
    ...sync.resolved.map(item => `${verb[1]} (cleared): ${item.pool}`),
    ...sync.unknown.map(item => `Unknown: ${item.pool}: ${item.reason}`),
  ];
  if (sync.raised.length === 0 && sync.resolved.length === 0) lines.unshift(sync.kept.length ? `Nothing new: ${sync.kept.length} already open.` : 'Nothing to ask.');
  return lines.join('\n');
}
