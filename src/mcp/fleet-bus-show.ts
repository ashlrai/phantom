/**
 * `fleet_bus_show` MCP adapter: the single-envelope bus lookup —
 * `readBusEnvelopeById`, the same read `phm agents bus show <id>` serves.
 * Every other bus read cites wire ids — inbox rows, channel posts, work
 * `postId`/`statusId`/`result` receipts, handoff and wake-hint citations —
 * and this is the one read that resolves them: the live receipt with its
 * cursor and receipt time, the resolved sender handle, the tri-state
 * `held`/`holder` hold evidence claimable work and worker-handoffs carry,
 * the `job` live-feed state a job-citing body names, and `wh-…`
 * claim-holder wake-hint ids resolved through the wake queue to the
 * terminal `work.status` receipt that cites them.
 *
 * `id` is required and takes the same printable-label rule the CLI flag
 * applies, validated before any store read; unknown keys, caller roots,
 * paths and working directories are refused the same way. Read-only: the
 * store, registry, hold table, wake queue and feed roots stay
 * server-owned, and the tool never claims, acks, replies, posts or renews
 * TTL. Routing labels are data, never authenticated identity; the bounded
 * page walk sees live receipts only, so an expired or never-posted id
 * answers `not-found`, an unreadable store `unavailable`/`retryable`, and
 * `fromAgent`/`held`/`job` degrade to null or unknown — never an invented
 * envelope or proven-free work passed off as fact.
 */
import { readBusEnvelopeById, type BusEnvelopeLookup } from '../core/agents/bus-unified.js';

/** The printable-label rule `agents bus show` applies to envelope and `wh-…` wake-hint ids. */
const BUS_ID = /^[\x21-\x7e]{1,128}$/;

const SHOW_KEYS = new Set(['id']);

export interface FleetBusShowArgs {
  /** Envelope wire id, or a `wh-…` claim-holder wake-hint id. */
  id: string;
}

/**
 * Runtime argument validation: low-level SDK servers never check the
 * tools/list schema, so the server re-validates on every call. `id` is
 * required — the lookup has no meaningful default — and takes the same
 * printable routing-label rule every bus read shares; unknown keys, wrong
 * types, caller roots and malformed values are all refused before the
 * store is touched.
 */
export function parseFleetBusShowArgs(args: Record<string, unknown>): FleetBusShowArgs | null {
  if (Object.keys(args).some(key => !SHOW_KEYS.has(key))) return null;
  const id = args.id;
  if (typeof id !== 'string' || !BUS_ID.test(id)) return null;
  return { id };
}

export interface FleetBusShowDeps {
  read?: typeof readBusEnvelopeById;
}

interface FleetBusShowMeta {
  schemaVersion: 1;
  snapshotKind: 'local-persisted';
  authority: 'none';
  generatedAt: string;
}

/** The shared lookup union with the MCP envelope metadata on every member, so `status` still narrows. */
export type FleetBusShowResult = BusEnvelopeLookup extends infer Member
  ? Member extends BusEnvelopeLookup ? FleetBusShowMeta & Member : never
  : never;

/**
 * One envelope lookup through the shared `readBusEnvelopeById` projection —
 * the identical read `phm agents bus show` runs, so the bounded page walk,
 * `wh-…` wake-hint resolution, hold evidence and job annotation can never
 * diverge between the CLI and this tool. Every lookup status passes through
 * untouched: `ok` keeps the message, `held`/`holder`, `job` and
 * `wakeHint` fields the read resolved, `not-found`/`invalid`/
 * `unavailable`/`retryable` keep their own status and reason — never an
 * invented envelope or an empty result passed off as a miss.
 */
export async function readFleetBusShow(
  args: FleetBusShowArgs,
  deps: FleetBusShowDeps = {},
): Promise<FleetBusShowResult> {
  const read = deps.read ?? readBusEnvelopeById;
  const lookup = read(args.id);
  return {
    schemaVersion: 1 as const, snapshotKind: 'local-persisted' as const,
    authority: 'none' as const, generatedAt: new Date().toISOString(),
    ...lookup,
  };
}
