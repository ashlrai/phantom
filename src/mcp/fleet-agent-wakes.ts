/**
 * `fleet_agent_wakes` MCP adapter: the per-agent wake-hint read —
 * `readAgentWakes`, the same read `phm agents bus wakes` serves.
 * `fleet_agent_work`'s digest carries only a capped newest slice of the
 * queue tail; this tool answers the wake questions that slice cannot —
 * "which hints arrived since my last check", "which wake was about job X",
 * "whose hints keep landing" — with the projection's own filters and its
 * per-hint resolution: every `bus.send` hint resolves the live message it
 * refers to (summary, priority, sender handle, channel, and for claimable
 * work or a job citation the live `held`/`holder` plus `job` feed-state
 * evidence), and every `wh-…` claim-holder hint re-derives the terminal
 * `work.status` receipt that woke the holder. A hint is a routing hint to
 * read the inbox — never a body, never authority.
 *
 * `agent` is optional. Supplied, it resolves through the server-owned
 * identity registry with the same handle/`agent:`/stable-id/alias refs
 * `resolveAgent` accepts; a ref that resolves to no identity but matches
 * the printable-label rule keeps literal-`to` matching under `scope:
 * 'label'` — the same fallback the CLI read reports — so hints queued
 * under a bare coordination label stay readable by their addressee, and a
 * resolved ref reads that identity's queue under `scope: 'identity'`.
 * Omitted, the read is fleet-wide — every hint in the bounded queue tail
 * across all addressees under `scope: 'fleet'`, the same
 * `phm agents bus wakes --all` read — so a leader or comms pass sees who
 * has pending hints in one call instead of one per identity.
 * `since`, `job`, `from`, `excludeFrom`, `channel`, `priority`,
 * `contains`, `thread`, `inReplyTo`, `bodyKind`, `result` and `id` apply
 * the same rules the `phm agents bus wakes` flags share and are validated
 * before any store read; the page always reports `matched` (every hint
 * the bounded queue tail accepted before its row cap) and `truncated`
 * (the queue tail or cap cut matches beyond the shown slice), so a
 * capped list is never passed off as the whole queue. Read-only: no
 * caller root, path or cwd is accepted — the store, registry, hold
 * table, wake queue and feed roots stay server-owned — and the tool
 * never claims, acks, replies, posts or renews TTL. Routing labels are
 * data, never authenticated identity; an unreadable store, registry,
 * hold table or wake queue stays `unavailable`/`retryable`/
 * `unknown-agent`/`invalid` with its own reason, and `held`/`job`/
 * referent resolution degrade to null or unknown — never an empty page
 * or proven-free work passed off as fact.
 */
import {
  busReadContains, readAgentWakes, readAllWakes, type AllWakesPage, type WakePage,
} from '../core/agents/bus-unified.js';
import { agentChannelNameSchema } from '../core/agents/bus-identity.js';
import { WORK_RESULT_OUTCOMES, type WorkResultOutcome } from '../core/agents/bus-v2-schema.js';
import { BUS_PRIORITIES, type BusPriority } from '../core/fleet/bus-envelope.js';
import { parseSince } from '../core/fleet/agent-messages.js';

/** The printable-label rule `agent`, `job`, `from`, `excludeFrom` and `id` share. */
const BUS_LABEL = /^[\x21-\x7e]{1,128}$/;

const WAKE_KEYS = new Set(['agent', 'since', 'before', 'job', 'from', 'excludeFrom', 'channel', 'priority', 'contains', 'id', 'thread', 'inReplyTo', 'bodyKind', 'result']);
const LABEL_KEYS = ['job', 'from', 'excludeFrom', 'id', 'thread', 'inReplyTo', 'bodyKind'] as const;

export interface FleetAgentWakesArgs {
  /** Agent ref — handle, `agent:<handle>`, stable `agt_` id or alias — resolved through the server-side registry. Omit for the fleet-wide read: every hint in the bounded queue tail, each row's own `to` naming its addressee. */
  agent?: string;
  /** Keep only hints recorded strictly after this epoch-ms cutoff — the wakes read's own boundary. */
  since?: number;
  /** Keep only hints recorded strictly before this epoch-ms cutoff — the exclusive upper bound composing with `since` into the wakes read's own `(since, before)` window on queue time. */
  before?: number;
  /** Keep only hints provably naming this job id — the same `busBodyJobMatch` rule every bus `--job` read applies. */
  job?: string;
  /** Keep only hints sent under any registered spelling of this sender ref. */
  from?: string;
  /** Drop hints sent under any registered spelling of this sender ref. */
  excludeFrom?: string;
  /** Keep only hints addressed to `group:<name>:*` of this channel — the same room prefix `phm agents bus wakes --channel` and every other bus read's channel filter match. */
  channel?: string;
  /** Keep only hints in one exact P0–P3 band, decided on the resolved referent — the same match `phm agents bus wakes --priority` applies. */
  priority?: BusPriority;
  /** Keep only hints whose resolved referent text carries this needle — the shared `--contains` rule. */
  contains?: string;
  /** Keep only the hint whose own id is strictly equal to the value — the triggering envelope's wire id on a bus.send hint, the wh-… claim-holder id on those — the same exact-id match `phm agents bus wakes --id` applies. */
  id?: string;
  /** Keep only hints whose resolved referent is a note/context body carrying this v2 thread label — the same match `phm agents bus wakes --thread` applies. */
  thread?: string;
  /** Keep only hints whose resolved referent body cites this envelope id through its own inReplyTo field — the same own-property exact match `phm agents bus wakes --in-reply-to` applies. */
  inReplyTo?: string;
  /** Keep only hints whose resolved referent body carries this exact kind discriminator — the same `busBodyKind` match `phm agents bus wakes --body-kind` applies; a resolved claim-holder hint's citing work.status receipt matches only `work.status`. */
  bodyKind?: string;
  /** Keep only hints whose resolved referent is a `work.result` body reporting this outcome — the same `busBodyResultOutcome` match `phm agents bus wakes --result` applies; a claim-holder hint's citing work.status receipt carries no outcome and never matches. */
  result?: WorkResultOutcome;
}

/**
 * Runtime argument validation: low-level SDK servers never check the
 * tools/list schema, so the server re-validates on every call. `agent`
 * is optional — supplied it selects the addressed read, omitted it selects
 * the fleet-wide read — and every
 * other key takes the same value rules `phm agents bus wakes` flags and
 * the other bus reads share: `job`/`from`/`excludeFrom`/`id`/`thread`/
 * `inReplyTo`/`bodyKind` printable
 * routing labels (`id` the exact hint-id match), `channel` the strict
 * channel-name grammar, the P0–P3 priority enum, the
 * `WORK_RESULT_OUTCOMES` result-outcome enum, `since` the shared
 * `15m`/`2h`/`1d`/epoch-ms/ISO grammar resolved
 * to a safe non-negative epoch-ms integer, and `contains` the bounded
 * free-text needle `busReadContains` normalizes. Unknown keys, wrong
 * types, caller roots and malformed values are all refused before the
 * store is touched.
 */
export function parseFleetAgentWakesArgs(args: Record<string, unknown>): FleetAgentWakesArgs | null {
  if (Object.keys(args).some(key => !WAKE_KEYS.has(key))) return null;
  const agent = args.agent;
  if (agent !== undefined && (typeof agent !== 'string' || !BUS_LABEL.test(agent))) return null;

  const parsed: FleetAgentWakesArgs = {};
  if (agent !== undefined) parsed.agent = agent;
  for (const key of LABEL_KEYS) {
    const value = args[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || !BUS_LABEL.test(value)) return null;
    parsed[key] = value;
  }
  const channel = args.channel;
  if (channel !== undefined) {
    if (typeof channel !== 'string' || !agentChannelNameSchema.safeParse(channel).success) return null;
    parsed.channel = channel;
  }
  const priority = args.priority;
  if (priority !== undefined) {
    if (typeof priority !== 'string' || !(BUS_PRIORITIES as readonly string[]).includes(priority)) return null;
    parsed.priority = priority as BusPriority;
  }
  const result = args.result;
  if (result !== undefined) {
    if (typeof result !== 'string' || !(WORK_RESULT_OUTCOMES as readonly string[]).includes(result)) return null;
    parsed.result = result as WorkResultOutcome;
  }
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
  const contains = busReadContains(args.contains);
  if (contains === null) return null;
  if (contains !== undefined) parsed.contains = contains;
  return parsed;
}

export interface FleetAgentWakesDeps {
  read?: typeof readAgentWakes;
  readAll?: typeof readAllWakes;
}

interface FleetAgentWakesMeta {
  schemaVersion: 1;
  snapshotKind: 'local-persisted';
  authority: 'none';
  generatedAt: string;
}

/** The shared wake-page union with the MCP envelope metadata on every member, so `status` still narrows. */
export type FleetAgentWakesResult = (WakePage | AllWakesPage) extends infer Member
  ? Member extends WakePage | AllWakesPage ? FleetAgentWakesMeta & Member : never
  : never;

/**
 * One wake-hint page through the shared `readAgentWakes`/`readAllWakes`
 * projections — the identical reads `phm agents bus wakes` and
 * `phm agents bus wakes --all` run, so identity/label scope, fleet scope,
 * queue-tail `matched`/`truncated` honesty, claim-holder citation
 * re-derivation and per-hint message resolution can never diverge
 * between the CLI and this tool. Every page status passes through
 * untouched: `ok` keeps `agent`, `scope`, `wakes`, `matched` and
 * `truncated`; `unknown-agent`, `unavailable` and `invalid` keep their
 * own status and reason — never an invented empty page passed off as
 * "no wakes".
 */
export async function readFleetAgentWakes(
  args: FleetAgentWakesArgs,
  deps: FleetAgentWakesDeps = {},
): Promise<FleetAgentWakesResult> {
  const filter = {
    ...(args.job === undefined ? {} : { job: args.job }),
    ...(args.from === undefined ? {} : { from: args.from }),
    ...(args.excludeFrom === undefined ? {} : { excludeFrom: args.excludeFrom }),
    ...(args.channel === undefined ? {} : { channel: args.channel }),
    ...(args.priority === undefined ? {} : { priority: args.priority }),
    ...(args.before === undefined ? {} : { before: args.before }),
    ...(args.contains === undefined ? {} : { contains: args.contains }),
    ...(args.id === undefined ? {} : { id: args.id }),
    ...(args.thread === undefined ? {} : { thread: args.thread }),
    ...(args.inReplyTo === undefined ? {} : { inReplyTo: args.inReplyTo }),
    ...(args.bodyKind === undefined ? {} : { bodyKind: args.bodyKind }),
    ...(args.result === undefined ? {} : { result: args.result }),
  };
  const page: WakePage | AllWakesPage = args.agent === undefined
    ? (deps.readAll ?? readAllWakes)(args.since, {}, filter)
    : (deps.read ?? readAgentWakes)(args.agent, args.since, {}, filter);
  return {
    schemaVersion: 1 as const, snapshotKind: 'local-persisted' as const,
    authority: 'none' as const, generatedAt: new Date().toISOString(),
    ...page,
  };
}
