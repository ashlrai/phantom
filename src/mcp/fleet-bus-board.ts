/**
 * `fleet_bus_board` MCP adapter: the shared task board's fleet-wide
 * pending digest — `readBusBoardPending`/`BusBoard.pendingAll`, the same
 * read `phm comms inbox`'s board source projects and `phm agents bus work
 * mine`'s board section narrows to one agent's labels. Every other bus
 * surface reports board work only inside its own slice —
 * `fleet_agent_work` needs the agent's labels ahead of time,
 * `fleet_comms_inbox` flattens the digest into ranked items, and
 * `fleet_work_board` classifies durable bus requests — a different board
 * entirely — so none answers "what is pending on the shared board,
 * fleet-wide, for this job" in one call. This tool is the board digest's
 * own read: every unacknowledged delivery across every thread and every
 * task whose observed hold is not `held`, under the same `job`,
 * `contains` and `since` filters the `work mine` board section and the
 * board digest share.
 *
 * `job` keeps only threads carrying a task whose fleet `itemId` cites it
 * — the same citation rule `work mine --job` applies, with `peers` then
 * reporting only that job's thread members; `contains` keeps only rows
 * whose scrubbed display text carries the needle as a case-insensitive
 * substring — the same `--contains` rule every bus read shares;
 * `since` (15m, 2h, 1d, epoch ms or ISO) keeps only deliveries whose
 * `createdAt` reaches the cutoff — board tasks carry no timestamp, so
 * under `since` the task list is provably empty rather than padded with
 * undated rows, and thread rollups list only while a surviving delivery
 * remains. The result reports `source` missing (verified-empty — no
 * `state.json` was ever written), available or unavailable — an
 * unreadable board, malformed config, relative path override or disabled
 * event bus is never an invented empty digest — plus the digest's
 * `peers`, `claims` read state, thread rollups and the deliveries/tasks
 * `matched` totals with 50-item caps and `truncated` flags; every task
 * `hold` is open/held/ambiguous/unknown under the shared-queue claim
 * index — `unknown` never proven open — and item `content.text` stays
 * the stored untrusted text: canonical envelope JSON for deliveries,
 * titles for tasks and threads.
 *
 * No arguments are required and every store root stays server-owned —
 * any caller root, path or cwd is refused before the board is touched.
 * Read-only: the digest takes the board's local read lock but writes
 * nothing and never acknowledges a delivery or claims a task. Routing
 * labels are data, never authenticated identity; claims coordinate scope
 * and grant no execution, claim, merge, push, spend or dispatch
 * authority.
 */
import { busReadContains } from '../core/agents/bus-unified.js';
import { parseSince } from '../core/fleet/agent-messages.js';
import {
  readBusBoardPending,
  type BusBoardPendingRead, type BusBoardPendingReadOptions,
} from '../core/fleet/bus-board.js';

/** The printable-label rule `job` shares — the same bound every bus read applies. */
const BUS_LABEL = /^[\x21-\x7e]{1,128}$/;

const BOARD_KEYS = new Set(['job', 'contains', 'since']);

export interface FleetBusBoardArgs {
  /** Keep only threads carrying a task whose fleet itemId cites this job id — the same citation rule the work-mine board section applies. */
  job?: string;
  /** Keep only rows whose scrubbed display text carries this needle — the same `--contains` rule every bus read shares. */
  contains?: string;
  /** Keep only deliveries whose createdAt reaches this epoch-ms cutoff — the shared `since` grammar resolved once; tasks never match under it. */
  since?: number;
}

/**
 * Runtime argument validation: low-level SDK servers never check the
 * tools/list schema, so the server re-validates on every call. `job`
 * takes the printable routing-label bound every bus read applies,
 * `contains` the bounded free-text needle `busReadContains` normalizes,
 * `since` the shared `15m`/`2h`/`1d`/epoch-ms/ISO grammar resolved to a
 * safe non-negative epoch-ms integer. Unknown keys, wrong types, caller
 * roots and malformed values are all refused before the store is touched.
 */
export function parseFleetBusBoardArgs(args: Record<string, unknown>): FleetBusBoardArgs | null {
  if (Object.keys(args).some(key => !BOARD_KEYS.has(key))) return null;
  const parsed: FleetBusBoardArgs = {};
  const job = args.job;
  if (job !== undefined) {
    if (typeof job !== 'string' || !BUS_LABEL.test(job)) return null;
    parsed.job = job;
  }
  const contains = busReadContains(args.contains);
  if (contains === null) return null;
  if (contains !== undefined) parsed.contains = contains;
  const since = args.since;
  if (since !== undefined) {
    if (typeof since !== 'string') return null;
    const resolved = parseSince(since);
    if (resolved === null || !Number.isSafeInteger(resolved) || resolved < 0) return null;
    parsed.since = resolved;
  }
  return parsed;
}

export interface FleetBusBoardDeps {
  read?: (options: BusBoardPendingReadOptions) => BusBoardPendingRead;
}

interface FleetBusBoardMeta {
  schemaVersion: 1;
  snapshotKind: 'local-persisted';
  authority: 'none';
  generatedAt: string;
}

/** The shared read union with the MCP envelope metadata on every member. */
export type FleetBusBoardResult = FleetBusBoardMeta & BusBoardPendingRead;

/**
 * One fleet-wide board digest through the shared `readBusBoardPending`
 * read — the identical read `phm comms inbox`'s board source projects —
 * so path derivation, missing/unavailable honesty, filter semantics and
 * hold-state reporting can never diverge between the surfaces. Non-ok
 * results pass through untouched: `missing` stays a verified-empty board
 * and `unavailable` an unreadable one, never an invented empty digest.
 */
export async function readFleetBusBoard(
  args: FleetBusBoardArgs,
  deps: FleetBusBoardDeps = {},
): Promise<FleetBusBoardResult> {
  const read = deps.read ?? readBusBoardPending;
  const result = read({
    ...(args.job === undefined ? {} : { jobId: args.job }),
    ...(args.contains === undefined ? {} : { contains: args.contains }),
    ...(args.since === undefined ? {} : { sinceMs: args.since }),
  });
  return {
    schemaVersion: 1 as const, snapshotKind: 'local-persisted' as const,
    authority: 'none' as const, generatedAt: new Date().toISOString(),
    ...result,
  };
}
