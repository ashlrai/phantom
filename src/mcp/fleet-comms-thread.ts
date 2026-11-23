/**
 * `fleet_comms_thread` MCP adapter: the single owner thread —
 * `readOwnerThread`, the same `comms.owner-thread.v1` projection
 * `phm comms thread --json`, the native `ashlr_comms_thread` tool and the
 * owner-thread API serve. `fleet_comms_inbox` lists the pending owner items
 * and `fleet_comms_status` reports counts and adapter states; neither
 * answers "what did the owner last say and what did we reply" — this is
 * the ordered read behind both: every live thread message newest-last with
 * the per-channel delivery receipts joined onto outbound rows and the
 * `awaitingReply` mark on inbound rows no recorded reply cites.
 *
 * `channel`, `direction`, `since`, `beforeAt` and `contains` narrow the
 * same view the CLI flags and the native tool take — one channel's lines,
 * one direction's lines, a recorded-time window (`since` the inclusive
 * floor, `beforeAt` the exclusive ceiling — the `[since, before)` bound
 * every other comms read applies) or a case-insensitive text
 * needle (the only text search the thread offers: iMessage bodies are
 * redacted on the bus mirror, so this private read is the one place they
 * can be found). `limit` caps the newest messages kept (1–200, default
 * 50). An unreadable thread keeps `unavailable: true` and
 * `awaitingReply: null` — unknown stays unknown, never an empty list
 * passed off as fact.
 *
 * The owner config dir and runs dir stay server-owned —
 * fixedOwnerConfigDir/fixedOwnerRunsDir resolve the real account home and
 * cannot be retargeted by HOME or ASHLR_* variables, the same roots the
 * native gateway's owner-thread tools use — so every key outside the six
 * filters, caller root, path, cwd or environment override is refused
 * before the read runs. Read-only: the projection joins existing reads,
 * writes nothing and sends nothing; message text is the stored scrubbed
 * intake content — never a secret value — and routing labels are
 * untrusted data. The tool grants no reply, send, pairing, dispatch or
 * delivery authority.
 */
import { fixedOwnerConfigDir, fixedOwnerRunsDir, loadOwnerThreadSettings } from '../core/comms/owner-channel.js';
import { isOwnerChannel } from '../core/comms/leader-mailbox.js';
import {
  OWNER_THREAD_CONTAINS_MAX, readOwnerThread,
  type OwnerThreadOptions, type OwnerThreadReadFilter,
} from '../core/comms/owner-thread.js';
import { parseSince } from '../core/fleet/agent-messages.js';

/** Bounds shared with the CLI read: the thread caps its own slice at 200. */
export const FLEET_COMMS_THREAD_LIMIT_DEFAULT = 50;
export const FLEET_COMMS_THREAD_LIMIT_MAX = 200;

const THREAD_KEYS = new Set(['limit', 'channel', 'direction', 'since', 'beforeAt', 'contains']);

export interface FleetCommsThreadArgs {
  /** Newest messages kept after filtering; the read itself caps at 200. */
  limit: number;
  /** Optional view narrowing — the same dimensions `phm comms thread` filters expose. */
  filter?: OwnerThreadReadFilter;
}

export function parseFleetCommsThreadArgs(args: Record<string, unknown>): FleetCommsThreadArgs | null {
  if (Object.keys(args).some(key => !THREAD_KEYS.has(key))) return null;
  const limit = args.limit === undefined && !('limit' in args) ? FLEET_COMMS_THREAD_LIMIT_DEFAULT : args.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > FLEET_COMMS_THREAD_LIMIT_MAX) return null;

  const filter: OwnerThreadReadFilter = {};
  if (args.channel !== undefined) {
    if (typeof args.channel !== 'string' || !isOwnerChannel(args.channel)) return null;
    filter.channel = args.channel;
  }
  if (args.direction !== undefined) {
    if (args.direction !== 'inbound' && args.direction !== 'outbound') return null;
    filter.direction = args.direction;
  }
  if (args.since !== undefined) {
    if (typeof args.since !== 'string') return null;
    const since = parseSince(args.since);
    if (since === null || !Number.isSafeInteger(since) || since < 0) return null;
    filter.since = since;
  }
  if (args.beforeAt !== undefined) {
    if (typeof args.beforeAt !== 'string') return null;
    const beforeAt = parseSince(args.beforeAt);
    if (beforeAt === null || !Number.isSafeInteger(beforeAt) || beforeAt < 0) return null;
    filter.beforeAt = beforeAt;
  }
  if (args.contains !== undefined) {
    if (typeof args.contains !== 'string' || args.contains.trim() === '' || args.contains.length > OWNER_THREAD_CONTAINS_MAX) return null;
    filter.contains = args.contains;
  }
  return { limit, ...(Object.keys(filter).length === 0 ? {} : { filter }) };
}

export interface FleetCommsThreadDeps {
  /** Server-owned thread options; tests inject crafted runs dirs. */
  options?: OwnerThreadOptions;
  /** The shared read; tests inject a spy or a bound real read. */
  thread?: typeof readOwnerThread;
}

interface FleetCommsThreadMeta {
  schemaVersion: 1;
  snapshotKind: 'local-persisted';
  authority: 'none';
  generatedAt: string;
}

/** The shared thread union with the MCP envelope metadata on every member. */
export type FleetCommsThreadResult = FleetCommsThreadMeta & (
  | ReturnType<typeof readOwnerThread>
  | { status: 'unavailable'; reason: 'owner-thread-unreadable' }
);

/** The server-owned owner-thread options: real-home config and runs dirs. */
function defaultCommsThreadOptions(): OwnerThreadOptions {
  return {
    runsDir: fixedOwnerRunsDir(),
    settings: loadOwnerThreadSettings(fixedOwnerConfigDir()),
  };
}

/**
 * One owner-thread slice through the shared `readOwnerThread` read — the
 * identical projection `phm comms thread --json` and `ashlr_comms_thread`
 * run, so message order, receipt joins, the awaiting-reply mark and the
 * unreadable-thread verdict can never diverge between surfaces. The
 * projection's own fields stay beside the envelope's `generatedAt`; an
 * unreadable thread reports `unavailable: true` with `awaitingReply: null`
 * from the read itself, and a throwing options build reports `unavailable`
 * — never an invented empty or healthy thread.
 */
export async function readFleetCommsThread(
  args: FleetCommsThreadArgs,
  deps: FleetCommsThreadDeps = {},
): Promise<FleetCommsThreadResult> {
  const meta: FleetCommsThreadMeta = {
    schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
    generatedAt: new Date().toISOString(),
  };
  try {
    const view = (deps.thread ?? readOwnerThread)(
      deps.options ?? defaultCommsThreadOptions(), args.limit, args.filter);
    return { ...meta, ...view };
  } catch {
    return { ...meta, status: 'unavailable' as const, reason: 'owner-thread-unreadable' as const };
  }
}
