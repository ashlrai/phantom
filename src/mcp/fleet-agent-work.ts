/**
 * `fleet_agent_work` MCP adapter: the per-agent pending-work digest —
 * `readBusWorkMineWithSeats`, the same read `phm agents bus work mine`
 * serves. `fleet_agent_inbox` answers "what mail is addressed to me" and
 * `fleet_work_feed` answers "what jobs exist"; this tool answers the
 * question an MCP-connected agent actually asks first — "what is pending
 * for me" — with the projection's own join of live claims (message-id
 * leases resolved to the retained envelope they cover), open and
 * announced work-feed jobs with per-key hold coverage — each blocked
 * key's shown holders (owner label, lease expiry, claim class) named
 * inline — claimable work
 * envelopes and worker-handoff assignments in bus-next order, the
 * conversation threads waiting on its answer, its own unanswered asks,
 * blocked threads it is party to, wake hints, the next inbox page,
 * legacy `phm bus` mailbox mail, the shared task board digest, its
 * registry channels and its bot-seat handoff records. Every section
 * reports its own read state, so one unreadable store degrades only its
 * own section and unknown stays unknown — never an empty list passed
 * off as fact.
 *
 * `agent` is required and resolves through the server-owned identity
 * registry with the same handle/`agent:`/stable-id/alias refs
 * `resolveAgent` accepts; `job`, `since`, `before`, `contains`,
 * `priority`, `channel`, `from` and `excludeFrom` apply the same rules the
 * `phm agents bus work mine` flags share and are validated before any
 * store read. Read-only: no caller
 * root, path or cwd is
 * accepted — the store, registry, hold table, feed, mailbox, board,
 * wake-queue and seat roots stay server-owned — and the tool never
 * claims, acks, replies, posts, releases or writes. Routing labels are
 * data, never authenticated identity; claims coordinate scope and grant
 * no execution, claim, merge, push, spend or dispatch authority.
 */
import { busReadContains } from '../core/agents/bus-unified.js';
import { agentChannelNameSchema } from '../core/agents/bus-identity.js';
import { BUS_PRIORITIES, type BusPriority } from '../core/fleet/bus-envelope.js';
import type { BusWorkMineOptions, BusWorkMineResult } from '../core/agents/bus-work-mine.js';
import { readBusWorkMineWithSeats } from '../core/agents/bus-work-mine-seats.js';
import { parseSince } from '../core/fleet/agent-messages.js';

/** The printable-label rule `agent` and `job` share — the same bound every bus read applies. */
const BUS_LABEL = /^[\x21-\x7e]{1,128}$/;

const WORK_KEYS = new Set(['agent', 'job', 'contains', 'since', 'before', 'priority', 'channel', 'from', 'excludeFrom']);

export interface FleetAgentWorkArgs {
  /** Agent ref — handle, `agent:<handle>`, stable `agt_` id or alias — resolved through the server-side registry. */
  agent: string;
  /** Keep only pending work that names this job id — the same citation rule `work mine --job` applies. */
  job?: string;
  /** Keep only pending items whose displayed text carries this needle — the same `--contains` rule every bus read shares. */
  contains?: string;
  /** Keep only pending items whose recorded time reaches this epoch-ms cutoff — the shared `since` grammar resolved once. */
  since?: number;
  /** Keep only pending items whose recorded time is strictly before this epoch-ms cutoff — the shared `before` grammar resolved once, exclusive like every bus read's upper bound. */
  before?: number;
  /** Keep only pending items stamped with this exact P0..P3 band — the same `--priority` rule every bus read shares. */
  priority?: BusPriority;
  /** Keep only pending items provably addressed to `group:<name>:*` of one bus channel — the same `--channel` rule every bus read shares. */
  channel?: string;
  /** Keep only pending items provably sent by this agent ref — the same `--from` rule every bus read shares. */
  from?: string;
  /** Keep only pending items NOT provably sent by this agent ref — the same `--exclude-from` rule every bus read shares. */
  excludeFrom?: string;
}

/**
 * Runtime argument validation: low-level SDK servers never check the
 * tools/list schema, so the server re-validates on every call. `agent`
 * is required — the digest has no meaningful default — and every other
 * key takes the same value rules `phm agents bus work mine` flags share:
 * `job` a printable routing label, `contains` the bounded free-text
 * needle `busReadContains` normalizes, `since` the shared `15m`/`2h`/`1d`/
 * epoch-ms/ISO grammar resolved to a safe non-negative epoch-ms integer,
 * `priority` one exact P0..P3 band, `channel` the strict channel-name
 * grammar every bus `--channel` read validates, `from`/`excludeFrom` the
 * same printable-label bound every bus sender filter shares. Unknown
 * keys, wrong
 * types, caller roots and malformed values are all refused before the
 * store is touched.
 */
export function parseFleetAgentWorkArgs(args: Record<string, unknown>): FleetAgentWorkArgs | null {
  if (Object.keys(args).some(key => !WORK_KEYS.has(key))) return null;
  const agent = args.agent;
  if (typeof agent !== 'string' || !BUS_LABEL.test(agent)) return null;

  const parsed: FleetAgentWorkArgs = { agent };
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
  const before = args.before;
  if (before !== undefined) {
    if (typeof before !== 'string') return null;
    const resolved = parseSince(before);
    if (resolved === null || !Number.isSafeInteger(resolved) || resolved < 0) return null;
    parsed.before = resolved;
  }
  const priority = args.priority;
  if (priority !== undefined) {
    if (typeof priority !== 'string' || !(BUS_PRIORITIES as readonly string[]).includes(priority)) return null;
    parsed.priority = priority as BusPriority;
  }
  const channel = args.channel;
  if (channel !== undefined) {
    if (typeof channel !== 'string' || !agentChannelNameSchema.safeParse(channel).success) return null;
    parsed.channel = channel;
  }
  for (const key of ['from', 'excludeFrom'] as const) {
    const value = args[key];
    if (value !== undefined) {
      if (typeof value !== 'string' || !BUS_LABEL.test(value)) return null;
      parsed[key] = value;
    }
  }
  return parsed;
}

export interface FleetAgentWorkDeps {
  mine?: (agent: string, options: BusWorkMineOptions) => Promise<BusWorkMineResult>;
}

/**
 * The full pending-work digest through the shared
 * `readBusWorkMineWithSeats` projection — the identical read
 * `phm agents bus work mine` runs, seats section included, so sections,
 * counts, read states and filter echoes can never diverge between the
 * CLI and this tool. Non-ok results pass through untouched: an
 * `invalid` agent or filter ref keeps its own status and reason, never
 * an invented empty digest, and every section's `missing`/`unavailable`/
 * `refused`/`degraded` state stays itself.
 */
export async function readFleetAgentWork(
  args: FleetAgentWorkArgs,
  deps: FleetAgentWorkDeps = {},
): Promise<BusWorkMineResult> {
  const mine = deps.mine ?? readBusWorkMineWithSeats;
  return mine(args.agent, {
    ...(args.job === undefined ? {} : { job: args.job }),
    ...(args.contains === undefined ? {} : { contains: args.contains }),
    ...(args.since === undefined ? {} : { since: args.since }),
    ...(args.before === undefined ? {} : { before: args.before }),
    ...(args.priority === undefined ? {} : { priority: args.priority }),
    ...(args.channel === undefined ? {} : { channel: args.channel }),
    ...(args.from === undefined ? {} : { from: args.from }),
    ...(args.excludeFrom === undefined ? {} : { excludeFrom: args.excludeFrom }),
  });
}
