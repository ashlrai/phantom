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
 * bounds the CLI flags enforce and the core read clamps to. The result
 * reports `archives` (retained archive files found) and `skipped`
 * (files that could not be read or validated — counted, never fatal),
 * so a partially readable history stays honest rather than passing an
 * empty page off as fact.
 *
 * The runs dir stays server-owned — `fixedOwnerRunsDir` resolves the
 * real account home and cannot be retargeted by HOME or ASHLR_*
 * variables, the same root the native gateway's owner-thread tools use —
 * so every key outside `before`/`limit`, caller root, path, cwd or
 * environment override is refused before the read runs. Read-only: the
 * projection only joins existing reads, writes nothing and sends
 * nothing; message text is the stored scrubbed intake content — never a
 * secret value — and routing labels are untrusted data. The tool grants
 * no reply, send, pairing, dispatch or delivery authority.
 */
import { fixedOwnerRunsDir } from '../core/comms/owner-channel.js';
import { readOwnerThreadHistory } from '../core/comms/owner-thread-archive.js';

/** Bounds shared with the CLI read: the history read itself clamps limit at 500. */
export const FLEET_OWNER_HISTORY_LIMIT_DEFAULT = 50;
export const FLEET_OWNER_HISTORY_LIMIT_MAX = 500;

const HISTORY_KEYS = new Set(['before', 'limit']);

export interface FleetOwnerHistoryArgs {
  /** Keep only archived messages with seq below this sequence number. */
  before?: number;
  /** Cap on returned archived messages; the read itself clamps at 500. */
  limit: number;
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
  return { limit, ...(before === undefined ? {} : { before }) };
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
 * overlap dedupe and the skipped-file count can never diverge between
 * surfaces. The projection's own fields stay beside the envelope's
 * `generatedAt`; a throwing read reports `unavailable` — never an
 * invented empty or healthy history.
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
      { ...(args.before === undefined ? {} : { before: args.before }), limit: args.limit });
    return { ...meta, ...view };
  } catch {
    return { ...meta, status: 'unavailable' as const, reason: 'owner-thread-history-unreadable' as const };
  }
}
