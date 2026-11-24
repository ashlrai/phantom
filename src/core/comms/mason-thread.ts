/** One thread with Mason, whatever channel he used: `phm mason thread`.
 *
 * Merges what already exists, writes nothing and sends nothing:
 *   - the owner thread (his messages and the leader's replies, every channel),
 *   - the shared inbox MASON-INBOX.md (what the bridges wrote, with the
 *     channels each entry was also seen on),
 *   - the order trace (which jobs each inbox entry was routed to),
 *   - the bus reply state (received, assigned, running, blocked, verified).
 *
 * The same request seen on two channels is one item (same text, 10 minutes,
 * a different channel or a different store). A source that cannot be read is
 * named in `gaps`; a state that cannot be known is UNKNOWN, never guessed. */
import { readOwnerThread, type OwnerThreadOptions } from './owner-thread.js';
import { deriveBusWorkItemEvidence, readBusInboxEvidence } from './work-item-bus-evidence.js';
import { MASON_THREAD_SCHEMA, type MasonThread, type MasonThreadItem, type MasonThreadState } from './mason-thread-model.js';
import { classifyWorkItem, type WorkItemState } from './work-item-state.js';
import { inspectBusWorkClaims, type BusWorkClaimView } from '../fleet/bus-work-claims.js';
import type { BusInboxReceipt } from '../fleet/bus-inbox.js';
import { CROSS_CHANNEL_WINDOW_MS, normalizeForDedupe } from '../fleet/cross-channel-dedupe.js';
import { readInboxEntries, readRecentChannelEntries } from '../fleet/mason-inbox.js';
import { readOrderTrace, type OrderTraceJob, type OrderTraceV1 } from '../fleet/order-trace.js';
import { scrubSecrets } from '../util/scrub.js';

const TEXT_MAX = 500;
/** Channel token the thread's `channel` filter accepts: the same lowercase label grammar every inbox `[src:]`/`[also:]` tag and owner channel satisfies, so a channel that can appear in the data can always be asked for. */
export const MASON_THREAD_CHANNEL = /^[a-z0-9._-]{1,32}$/;
/** Least to most settled; the thread shows the furthest one any source proves. */
const RANK: readonly WorkItemState[] = ['RECEIVED', 'ASSIGNED', 'RUNNING', 'BLOCKED', 'VERIFIED'];

export interface MasonThreadOptions {
  runsDir: string;
  /** Bus root (reply state); default is the fleet dir under the Ashlr home. */
  busRoot: string;
  owner: OwnerThreadOptions;
  /** Epoch ms; items older than this are left out. */
  sinceMs: number;
  /** Epoch ms; items at or after this are left out — the exclusive recorded-time ceiling pairing with `sinceMs`'s inclusive floor into the same `[since, before)` window every other comms and bus read applies, so a past slice of the thread is one bounded read instead of a page through everything newer. Items are filtered before the cross-channel merge, so a sighting outside the window never joins an item. */
  beforeMs?: number;
  /**
   * Keep only items with a sighting on this channel — the item's own `channel`
   * or any `also_on` entry, so a request seen on two channels stays whole
   * under either name and a reply matches every channel it was sent to. The
   * value is a `MASON_THREAD_CHANNEL` token; an exact match decides on the
   * merged item's channel set, never on raw source rows.
   */
  channel?: string;
  /** Keep only items in this direction — `inbound` for what Mason sent, `outbound` for the leader's replies. */
  direction?: 'inbound' | 'outbound';
  /**
   * Case-insensitive substring over the item's rendered `text` — the same
   * scrubbed, clipped line the read prints — with whitespace collapsed on
   * both sides, the same `--contains` rule `phm comms thread` and every bus
   * read applies. Bounded by `OWNER_THREAD_CONTAINS_MAX`.
   */
  contains?: string;
  now: number;
  /** Seam for tests; default reads the real order trace. */
  trace?: (runsDir: string, now: number) => Promise<OrderTraceV1>;
}

interface Draft {
  at: number;
  dir: 'in' | 'out';
  store: 'owner' | 'inbox';
  channel: string;
  text: string;
  channels: Set<string>;
  jobs: Map<string, OrderTraceJob>;
  busId: string | null;
}

const JOB_STATE: Record<OrderTraceJob['state'], WorkItemState> = { queued: 'ASSIGNED', launched: 'RUNNING', published: 'RUNNING', merged: 'VERIFIED' };
const clip = (text: string): string => scrubSecrets(text.length > TEXT_MAX ? `${text.slice(0, TEXT_MAX - 1)}…` : text);

/** Fold a later sighting into the first when it is the same request. */
function sameRequest(a: Draft, b: Draft): boolean {
  return a.dir === 'in' && b.dir === 'in' && normalizeForDedupe(a.text) === normalizeForDedupe(b.text)
    && Math.abs(a.at - b.at) < CROSS_CHANNEL_WINDOW_MS && (a.store !== b.store || !a.channels.has(b.channel));
}

export async function readMasonThread(opts: MasonThreadOptions): Promise<MasonThread> {
  const gaps: string[] = [];
  const drafts: Draft[] = [];

  const owner = readOwnerThread(opts.owner);
  if ('unavailable' in owner) gaps.push('Owner thread could not be read: messages from every channel may be missing.');
  for (const m of owner.messages) {
    const at = Date.parse(m.at);
    if (!Number.isFinite(at) || at < opts.sinceMs || (opts.beforeMs !== undefined && at >= opts.beforeMs)) continue;
    const inbound = m.direction === 'inbound';
    drafts.push({
      at, dir: inbound ? 'in' : 'out', store: 'owner', channel: m.channel, text: m.text,
      channels: new Set(inbound ? [m.channel] : (m.fanout ?? []).filter(c => c !== m.channel)),
      jobs: new Map(), busId: inbound ? `ot-${m.idempotencyKey}` : null,
    });
  }

  // Inbox entries: precise times and every channel from one read, jobs from the trace.
  const entries = readRecentChannelEntries(opts.runsDir, opts.now, Math.max(1, opts.now - opts.sinceMs), opts.beforeMs);
  const inbox = await readInboxEntries({ runsDir: opts.runsDir, limit: Number.MAX_SAFE_INTEGER });
  if (inbox.sourceState === 'degraded') gaps.push('The shared inbox could not be read: some messages may be missing.');
  let trace: OrderTraceV1 | null = null;
  try { trace = await (opts.trace ?? ((dir, now) => readOrderTrace({ runsDir: dir, now: () => now })))(opts.runsDir, opts.now); } catch { /* named below */ }
  if (trace === null || trace.sources.inbox === 'degraded') gaps.push('Jobs for inbox messages are unknown: the order trace could not be read.');
  for (const e of entries) {
    const entry = inbox.entries.find(x => x.id === e.id);
    const order = trace?.orders.find(o => entry !== undefined && o.at === entry.at && o.source === entry.source && o.requestId === entry.requestId);
    drafts.push({
      at: e.receivedAt, dir: 'in', store: 'inbox', channel: e.channels[0] ?? 'unknown', text: e.text,
      channels: new Set(e.channels), jobs: new Map((order?.jobs ?? []).map(j => [j.id, j])), busId: e.id,
    });
  }

  // One bus read for every item's state.
  let receipts: BusInboxReceipt[] = [];
  let claims: BusWorkClaimView[] = [];
  let busOk = false;
  try { const read = readBusInboxEvidence(opts.busRoot); busOk = read.status === 'ok'; receipts = read.receipts; } catch { /* busOk stays false */ }
  try { claims = inspectBusWorkClaims(opts.busRoot).claims; } catch { /* no claims */ }
  if (!busOk) gaps.push('Reply states are unknown where no job is linked: the bus inbox could not be read.');

  drafts.sort((a, b) => a.at - b.at);
  const kept: Draft[] = [];
  const busIds = new Map<Draft, string[]>();
  for (const d of drafts) {
    const first = kept.find(k => sameRequest(k, d));
    if (!first) { kept.push(d); busIds.set(d, d.busId ? [d.busId] : []); continue; }
    d.channels.forEach(c => first.channels.add(c));
    d.jobs.forEach((job, id) => first.jobs.set(id, job));
    if (d.busId) busIds.get(first)?.push(d.busId);
  }

  const nowIso = new Date(opts.now).toISOString();
  const items = kept.map((d): MasonThreadItem => {
    let state: MasonThreadState | null = null;
    if (d.dir === 'in') {
      const found: WorkItemState[] = [...d.jobs.values()].map(j => JOB_STATE[j.state]);
      for (const id of busIds.get(d) ?? []) {
        const derived = deriveBusWorkItemEvidence(id, receipts, claims, opts.now);
        if (derived.inbox === 'found') found.push(classifyWorkItem(derived.evidence, nowIso).state);
      }
      state = found.length > 0 ? found.reduce((a, b) => (RANK.indexOf(b) > RANK.indexOf(a) ? b : a))
        : busOk ? 'RECEIVED' : 'UNKNOWN';
    }
    const channels = [...d.channels].filter(c => c !== d.channel);
    return { at: new Date(d.at).toISOString(), dir: d.dir, channel: d.channel, text: clip(d.text), state, job_ids: [...d.jobs.keys()].sort(), also_on: channels };
  });
  // The slice filters run on merged items, not drafts: a request seen on two
  // channels is one item under either channel name, and --contains matches the
  // same clipped text the row prints, never the raw source bodies.
  const needle = opts.contains === undefined ? undefined
    : opts.contains.toLowerCase().replace(/\s+/g, ' ').trim();
  const dir = opts.direction === undefined ? undefined : opts.direction === 'inbound' ? 'in' as const : 'out' as const;
  const slice = items.filter(item =>
    (opts.channel === undefined || item.channel === opts.channel || item.also_on.includes(opts.channel)) &&
    (dir === undefined || item.dir === dir) &&
    (needle === undefined || needle === '' || item.text.toLowerCase().replace(/\s+/g, ' ').includes(needle)));
  return { schema: MASON_THREAD_SCHEMA, as_of: nowIso, since: new Date(opts.sinceMs).toISOString(),
    ...(opts.beforeMs === undefined ? {} : { before: new Date(opts.beforeMs).toISOString() }), items: slice, gaps };
}

export { MASON_THREAD_EMPTY, MASON_THREAD_SCHEMA, masonStateWord, masonThreadText, type MasonThread, type MasonThreadItem, type MasonThreadState } from './mason-thread-model.js';
