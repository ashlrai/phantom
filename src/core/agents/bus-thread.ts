/**
 * `agents bus thread <id>`: the reply-chain read on the unified surface —
 * the same `readBusThread` projection `phm fleet bus-thread` and
 * `fleet_bus_thread` serve, always with the live evidence every unified bus
 * read annotates (`held`/`holder` on claimable work and worker-handoff
 * bodies, `job` on job-citing bodies, `fromAgent` on every row), so an agent
 * working `agents bus` reconstructs one exchange's raw `inReplyTo` chain —
 * kindless `{inReplyTo, text}` replies included — without dropping to the
 * fleet command family. The read stays read-only: it walks the same bounded
 * live pages, rechecks TTL before projecting and reports
 * `rootFound`/`complete`/`sourceFailure` so a proven miss never reads as an
 * unreadable walk. A `wh-…` claim-holder wake-hint id is not an envelope id
 * and reports `not-found` here exactly as it does on the fleet read — hint
 * resolution stays `show`'s alone.
 */
import { readBusThread, type BusThreadResult } from '../fleet/bus-thread-context.js';
import type { UnifiedBusOptions } from './bus-unified.js';

/** The printable routing-label rule every bus id filter shares. */
const THREAD = /^[\x21-\x7e]{1,128}$/;

export type AgentBusThread =
  | { status: 'invalid'; reason: string }
  | { status: 'ok'; thread: BusThreadResult };

/**
 * Resolve the reply chain rooted at one retained envelope id. An id that is
 * not a printable routing label is `invalid` before any store read; a valid
 * id returns the `fleet.bus-thread.v1` result verbatim — `rootFound` false
 * is a proven miss (expired, reclaimed or never posted), `complete` false
 * with `sourceFailure` naming why means the bounded walk could not finish,
 * never an invented empty thread.
 */
export function readAgentBusThread(id: string, options: UnifiedBusOptions = {}): AgentBusThread {
  if (typeof id !== 'string' || !THREAD.test(id)) {
    return { status: 'invalid', reason: 'Invalid message id.' };
  }
  return { status: 'ok', thread: readBusThread(id, { ...options, liveEvidence: true }) };
}
