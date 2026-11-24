/**
 * `fleet_owner_history` MCP adapter: the archived owner-thread read —
 * `readOwnerThreadHistory`, the same `comms.owner-thread-history.v1`
 * projection `phm fleet owner-history` serves. `fleet_comms_thread`
 * reads only the live thread window; once rotation moves the oldest
 * messages into `owner-thread-archive-<first>-<last>.json` files beside
 * the live record, this is the only read that pages them back, so an
 * MCP-connected agent can answer "what did the owner say before the
 * live window" without shelling out to `phm`.
 *
 * `before` keeps only archived messages whose seq sits below that
 * sequence number — page back with the oldest seq a previous page
 * returned — and `limit` caps the page (1–500, default 50), the same
 * bounds the CLI flags enforce and the core read clamps to.
 * `channel`, `direction`, `since`, `beforeAt`, `contains` and `replyTo`
 * apply the same view slice `fleet_comms_thread` exposes — one channel's
 * lines, one direction's lines, a recorded-time window (`since` the
 * inclusive floor, `beforeAt` the exclusive ceiling), a case-insensitive
 * text needle or the one-key exchange `replyTo` names — to the archived
 * pages through the shared
 * `ownerThreadViewPredicate`, so a filtered archive read keeps exactly
 * the rows the live read would. `beforeAt` is named apart from `before`
 * because `before` already pages by seq on this read. The result reports `archives` (retained
 * archive files found) and `skipped` (files that could not be read or
 * validated — counted, never fatal), so a partially readable history
 * stays honest rather than passing an empty page off as fact.
 *
 * The runs dir stays server-owned — `fixedOwnerRunsDir` resolves the
 * real account home and cannot be retargeted by HOME or ASHLR_*
 * variables, the same root the native gateway's owner-thread tools use —
 * so every key outside `before`/`limit`/`channel`/`direction`/`since`/
 * `beforeAt`/`contains`/`replyTo`, caller root, path, cwd or environment override is refused
 * before the read runs. Read-only: the projection only joins existing
 * reads, writes nothing and sends nothing; message text is the stored
 * scrubbed intake content — never a secret value — and routing labels
 * are untrusted data. The tool grants no reply, send, pairing, dispatch
 * or delivery authority.
 */
import { fixedOwnerRunsDir } from '../core/comms/owner-channel.js';
import { isOwnerChannel } from '../core/comms/leader-mailbox.js';
import { readOwnerThreadHistory } from '../core/comms/owner-thread-archive.js';
import { OWNER_THREAD_CONTAINS_MAX, isOwnerThreadKey, type OwnerThreadReadFilter } from '../core/comms/owner-thread.js';
import { parseSince } from '../core/fleet/agent-messages.js';

/** Bounds shared with the CLI read: the history read itself clamps limit at 500. */
export const FLEET_OWNER_HISTORY_LIMIT_DEFAULT = 50;
export const FLEET_OWNER_HISTORY_LIMIT_MAX = 500;

const HISTORY_KEYS = new Set(['before', 'limit', 'channel', 'direction', 'since', 'beforeAt', 'contains', 'replyTo']);

export interface FleetOwnerHistoryArgs {
  /** Keep only archived messages with seq below this sequence number. */
  before?: number;
  /** Cap on returned archived messages; the read itself clamps at 500. */
  limit: number;
  /** Optional view narrowing — the same slice `fleet_comms_thread` and `phm comms thread` expose, applied to the archived pages. */
  filter?: OwnerThreadReadFilter;
}

export function parseFleetOwnerHistoryArgs(args: Record<string, unknown>): FleetOwnerHistoryArgs | null {
  if (Object.keys(args).some(key => !HISTORY_KEYS.has(key))) return null;
  const limit = args.limit === undefined ? FLEET_OWNER_HISTORY_LIMIT_DEFAULT : args.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > FLEET_OWNER_HISTORY_LIMIT_MAX) return null;
  let before: number | undefined;
  if (args.before !== undefined) {
    if (typeof args.before !== 'number' || !Number.isSafeInteger(args.before) || args.before < 1) return null;
    before = args.before;
  }
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
  if (args.replyTo !== undefined) {
    if (typeof args.replyTo !== 'string' || !isOwnerThreadKey(args.replyTo)) return null;
    filter.replyTo = args.replyTo;
  }
  return { limit, ...(before === undefined ? {} : { before }), ...(Object.keys(filter).length === 0 ? {} : { filter }) };
}

export interface FleetOwnerHistoryDeps {
  /** Server-owned runs dir; tests inject crafted runs dirs. */
  runsDir?: string;
  /** The shared read; tests inject a spy or a bound real read. */
  history?: typeof readOwnerThreadHistory;
}

interface FleetOwnerHistoryMeta {
  schemaVersion: 1;
  snapshotKind: 'local-persisted';
  authority: 'none';
  generatedAt: string;
}

/** The shared history union with the MCP envelope metadata on every member. */
export type FleetOwnerHistoryResult = FleetOwnerHistoryMeta & (
  | ReturnType<typeof readOwnerThreadHistory>
  | { status: 'unavailable'; reason: 'owner-thread-history-unreadable' }
);

/**
 * One archived owner-thread page through the shared
 * `readOwnerThreadHistory` read — the identical projection
 * `phm fleet owner-history` runs, so archive discovery, seq paging,
 * overlap dedupe, the view slice and the skipped-file count can never
 * diverge between surfaces. The projection's own fields stay beside the
 * envelope's `generatedAt`; a throwing read reports `unavailable` —
 * never an invented empty or healthy history.
 */
export async function readFleetOwnerHistory(
  args: FleetOwnerHistoryArgs,
  deps: FleetOwnerHistoryDeps = {},
): Promise<FleetOwnerHistoryResult> {
  const meta: FleetOwnerHistoryMeta = {
    schemaVersion: 1, snapshotKind: 'local-persisted', authority: 'none',
    generatedAt: new Date().toISOString(),
  };
  try {
    const view = (deps.history ?? readOwnerThreadHistory)(
      { runsDir: deps.runsDir ?? fixedOwnerRunsDir() },
      { ...(args.before === undefined ? {} : { before: args.before }), limit: args.limit, ...(args.filter ?? {}) });
    return { ...meta, ...view };
  } catch {
    return { ...meta, status: 'unavailable' as const, reason: 'owner-thread-history-unreadable' as const };
  }
}
