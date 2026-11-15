/** Slack order → work-board result bridge for Mason's Nov 12 22:30 and
 * Nov 13 13:13 orders: when the order trace proves that a job cited by a
 * Slack order has merged with a GitHub PR URL, record a result receipt on
 * that order's existing work-board item through the same writer
 * `ashlr fleet work-result` uses (postBusReply). The existing board
 * notifier (work-board-notify.ts) then sees the VERIFIED evidence and posts
 * it to the source Slack thread — no second Slack sender exists here, and
 * leader-network reply() is never called.
 *
 * An order is eligible only when its inbox heading carried the
 * `[leader-network:<64hex>]` tag (InboxEntry.requestId), its source is the
 * bare `slack` label, and a cited job is `merged` with a URL the existing
 * pullRequest() helper accepts. The result form is `verified {artifact:
 * <PR url>}` — the merge evidence carries no head sha, so none is
 * fabricated.
 *
 * `resolveItem` maps a leader-network request id to its work-board item id
 * from the durable route state alone: routes are keyed by
 * sha256(JSON.stringify([channel, envelope.id])) and store the envelope
 * published to the bus inbox, so `route.message.id` is the bus receipt id
 * the work board lists. The stored binding is recomputed before use; a
 * route that cannot prove it owns the request id resolves nothing.
 *
 * Once-only is durable: a JSONL ledger at <runsDir>/queue/order-results.jsonl
 * dedupes under the local-store lock, and a row is appended only after the
 * writer returns a durable receipt ('posted' or 'duplicate'). A failed
 * write leaves the row out and is retried on the next pass. Result receipts
 * are evidence, never authority: nothing here completes a claim, sends a
 * Slack message or calls the network. */
import { createHash } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { workResultBody, type WorkResultBody } from '../comms/work-result-body.js';
import { ashlrHome } from '../cloud/store.js';
import { ensurePrivateDirectory } from '../verse/preferences.js';
import { validateBusEnvelope } from './bus-envelope.js';
import { postBusReply, type ReplyResult } from './bus-reply-post.js';
import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock } from './local-store-lock.js';
import { pullRequest } from './order-work-state.js';
import type { OrderTraceV1 } from './order-trace.js';

export interface PlannedOrderResult {
  /** Stable dedupe identity `<requestId>:<jobId>`; also keys the ledger. */
  key: string;
  /** Leader-network request id from the inbox heading tag. */
  requestId: string;
  /** Work-board item id — the bus envelope id stored on the request's route. */
  itemId: string;
  jobId: string;
  /** The GitHub PR URL the merge evidence carried. */
  artifact: string;
  /** Evidence-shaped receipt body the board's evidence reader accepts. */
  body: WorkResultBody;
  /** Deterministic reply id; a retried apply reuses one bus receipt. */
  replyId: string;
}

export type OrderItemResolver = (requestId: string) => string | undefined;

/** Pure plan: one `verified {artifact}` result per eligible (order, merged
 * job) pair. A job without a github pull URL, a non-Slack source, a missing
 * request id or an unresolved item plans nothing — nothing is invented. */
export function planOrderResults(trace: OrderTraceV1, resolveItem: OrderItemResolver): PlannedOrderResult[] {
  const planned: PlannedOrderResult[] = [];
  const seen = new Set<string>();
  for (const order of trace.orders) {
    if (order.requestId === undefined || order.source !== 'slack') continue;
    const itemId = resolveItem(order.requestId);
    if (itemId === undefined) continue;
    for (const job of order.jobs) {
      if (job.state !== 'merged') continue;
      const pull = pullRequest(job.url);
      if (pull === null) continue;
      const body = workResultBody({ artifact: pull.url });
      if (body === null) continue;
      const key = `${order.requestId}:${job.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      planned.push({ key, requestId: order.requestId, itemId, jobId: job.id, artifact: pull.url,
        body, replyId: `order-result-${createHash('sha256').update(key).digest('hex').slice(0, 32)}` });
    }
  }
  return planned;
}

/** The same request-key formula leader-network.ts computes for route keys:
 * sha256 of the JSON [channel, envelope.id] pair. Recomputed here so the
 * stored route must prove it owns the request id, read-only. */
const leaderRequestKey = (channel: string, envelopeId: string): string =>
  createHash('sha256').update(JSON.stringify([channel, envelopeId])).digest('hex');

const NETWORK_STATE_MAX_BYTES = 8 * 1024 * 1024;

/** requestId → work-board item id from the durable leader-network route
 * state at <runsDir>/leader/network-state.json. Read-only: takes no lock,
 * writes nothing. The state file is read once; each lookup returns the
 * stored envelope id only when the route is a slack route whose stored
 * envelope is valid and whose [channel, id] hash recomputes to the request
 * id — the same invariant the network's own transaction enforces. A
 * missing file, unreadable state or an unproven route resolves nothing
 * rather than guessing from text or timestamps. */
export function leaderNetworkItemResolver(runsDir: string): OrderItemResolver {
  let routes: Record<string, unknown> = {};
  try {
    const text = readFileSync(join(runsDir, 'leader', 'network-state.json'), 'utf8');
    if (Buffer.byteLength(text, 'utf8') <= NETWORK_STATE_MAX_BYTES) {
      const state = JSON.parse(text) as { version?: unknown; routes?: unknown };
      if (state.version === 1 && state.routes !== null && typeof state.routes === 'object' && !Array.isArray(state.routes)) {
        routes = state.routes as Record<string, unknown>;
      }
    }
  } catch { /* Missing or unreadable state resolves nothing. */ }
  return requestId => {
    if (!Object.hasOwn(routes, requestId)) return undefined;
    const route = routes[requestId];
    if (route === null || typeof route !== 'object' || Array.isArray(route)) return undefined;
    const record = route as { channel?: unknown; message?: unknown };
    if (record.channel !== 'slack') return undefined;
    const checked = validateBusEnvelope(record.message);
    if (!checked.ok || checked.value.channel !== 'slack') return undefined;
    return leaderRequestKey(checked.value.channel, checked.value.id) === requestId
      ? checked.value.id : undefined;
  };
}

export function orderResultsLedgerPath(runsDir: string): string {
  return join(runsDir, 'queue', 'order-results.jsonl');
}

/** Ledger rows that already wrote; malformed rows are ignored so a torn
 * line retries on the next pass, matching the order-notices ledger. */
export function readOrderResultsLedger(runsDir: string): Set<string> {
  let text: string;
  try { text = readFileSync(orderResultsLedgerPath(runsDir), 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Set(); throw error; }
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    try {
      const row: unknown = JSON.parse(line);
      if (row !== null && typeof row === 'object' && 'key' in row && typeof row.key === 'string'
        && 'status' in row && row.status === 'written') seen.add(row.key);
    } catch { /* Partial or malformed rows do not prevent retries. */ }
  }
  return seen;
}

export type OrderResultWriter = (itemId: string, replyId: string, body: WorkResultBody) => ReplyResult | Promise<ReplyResult>;

export interface ApplyOrderResultsOptions {
  /** Bus inbox root; defaults to the same `~/.ashlr/fleet` the leader publishes to. */
  busRoot?: string;
  write?: OrderResultWriter;
  now?: () => number;
}

/** Write each planned result through the work-result writer, once. The
 * ledger lock serializes writers; a row is appended only after the writer
 * returns a durable receipt, so a failed write retries next pass and a
 * repeated apply writes nothing. */
export async function applyOrderResults(runsDir: string, planned: readonly PlannedOrderResult[],
  opts: ApplyOrderResultsOptions = {}): Promise<{ written: number; skipped: number; failed: number }> {
  const counts = { written: 0, skipped: 0, failed: 0 };
  if (!planned.length) return counts;
  const write = opts.write ?? ((itemId: string, replyId: string, body: WorkResultBody) =>
    postBusReply(itemId, replyId, body, { root: opts.busRoot ?? join(ashlrHome(), 'fleet') }));
  const ledger = orderResultsLedgerPath(runsDir);
  try {
    ensurePrivateDirectory(dirname(ledger));
    const acquired = acquireLocalStoreLockWithOutcome(`${ledger}.lock`, 0);
    if (acquired.state !== 'acquired') return counts;
    try {
      const sent = readOrderResultsLedger(runsDir);
      for (const result of planned) {
        if (sent.has(result.key)) { counts.skipped++; continue; }
        let outcome: ReplyResult;
        try { outcome = await write(result.itemId, result.replyId, result.body); }
        catch { counts.failed++; continue; }
        if (outcome.outcome === 'posted' || outcome.outcome === 'duplicate') {
          // A leading newline also isolates any truncated final row.
          appendFileSync(ledger, `\n${JSON.stringify({ key: result.key, status: 'written',
            itemId: result.itemId, jobId: result.jobId, replyId: result.replyId, artifact: result.artifact,
            at: new Date((opts.now ?? Date.now)()).toISOString() })}\n`, { mode: 0o600 });
          sent.add(result.key);
          counts.written++;
        } else counts.failed++;
      }
    } finally { releaseLocalStoreLock(acquired.lock); }
  } catch { counts.failed++; }
  return counts;
}
