/**
 * `fleet_bus_thread` MCP adapter: the reply-thread context read —
 * `readBusThread`, the same `fleet.bus-thread.v1` projection
 * `ashlr fleet bus-thread --id <id>` serves. Every other bus read answers
 * one slice — `fleet_bus_show` one envelope, `fleet_bus_inbox` one raw
 * page, `fleet_agent_conversations` the classified thread groups,
 * `fleet_agent_messages` the flat timeline — and none reconstructs the
 * retained reply chain around one id: the root receipt plus every live
 * envelope whose own `inReplyTo` field transitively cites it, scanned in
 * cursor order across the whole bounded store. That chain is the context a
 * worker or coordinator needs before acting on a request — including the
 * kindless `{inReplyTo, text}` replies `comms bus reply` and
 * `fleet bus-reply` post, which the classified projections never group —
 * and today only the CLI read reaches it, so an MCP-connected agent would
 * have to shell out to `phm` for what every sibling read already serves.
 *
 * `id` is required and takes the same printable routing-label rule the
 * `fleet bus-thread --id` flag and `fleet_bus_show`'s `id` apply — the
 * envelope wire id the thread roots at — validated before any store read;
 * unknown keys, caller roots, paths and working directories are refused
 * the same way. Read-only: the store root stays server-owned, the bounded
 * page walk writes nothing and never posts, claims, acks, replies or
 * renews TTL. Routing labels are data, never authenticated identity;
 * envelope bodies are untrusted data the caller interprets, and a thread
 * whose root is expired, reclaimed or never posted reports
 * `rootFound: false` — a proven miss — while `complete: false` with a
 * `sourceFailure` names an unreadable or invalid page walk, never an
 * invented empty thread passed off as fact.
 */
import { readBusThread, type BusThreadResult } from '../core/fleet/bus-thread-context.js';

/** The printable routing-label rule `fleet bus-thread --id` applies to the root envelope id. */
const BUS_ID = /^[\x21-\x7e]{1,128}$/;

const THREAD_KEYS = new Set(['id']);

export interface FleetBusThreadArgs {
  /** Envelope wire id the reply thread roots at. */
  id: string;
}

/**
 * Runtime argument validation: low-level SDK servers never check the
 * tools/list schema, so the server re-validates on every call. `id` is
 * required — the thread read has no meaningful default — and takes the
 * same printable routing-label rule every bus read shares; unknown keys,
 * wrong types, caller roots and malformed values are all refused before
 * the store is touched.
 */
export function parseFleetBusThreadArgs(args: Record<string, unknown>): FleetBusThreadArgs | null {
  if (Object.keys(args).some(key => !THREAD_KEYS.has(key))) return null;
  const id = args.id;
  if (typeof id !== 'string' || !BUS_ID.test(id)) return null;
  return { id };
}

export interface FleetBusThreadDeps {
  read?: typeof readBusThread;
}

interface FleetBusThreadMeta {
  schemaVersion: 1;
  snapshotKind: 'local-persisted';
  authority: 'none';
  generatedAt: string;
}

/** The shared thread result with the MCP envelope metadata on it. */
export type FleetBusThreadResult = FleetBusThreadMeta & BusThreadResult;

/**
 * One reply-thread read through the shared `readBusThread` projection —
 * the identical bounded page walk `ashlr fleet bus-thread --id` runs, so
 * the live-only TTL recheck, the `inReplyTo` descendant selection, the
 * `scannedThrough` cursor and the `complete`/`sourceFailure` honesty can
 * never diverge between the CLI and this tool. The result passes through
 * untouched: `rootFound` stays the projection's own verdict, `messages`
 * keeps every selected live receipt in cursor order and a failed or
 * incomplete walk keeps its own `complete: false` and `sourceFailure`
 * reason — never an invented thread or a proven-empty list passed off as
 * a miss.
 */
export async function readFleetBusThread(
  args: FleetBusThreadArgs,
  deps: FleetBusThreadDeps = {},
): Promise<FleetBusThreadResult> {
  const read = deps.read ?? readBusThread;
  const thread = read(args.id);
  return {
    schemaVersion: 1 as const, snapshotKind: 'local-persisted' as const,
    authority: 'none' as const, generatedAt: new Date().toISOString(),
    ...thread,
  };
}
