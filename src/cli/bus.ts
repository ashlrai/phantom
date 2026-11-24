/** Thin argv adapter over the local bus core. Exit 0 success, 1 operational error, 2 usage. */
import { randomUUID } from 'node:crypto';
import { MAX_BUS_ENVELOPE_BYTES, BUS_PRIORITIES, validateBusEnvelope, type BusPriority } from '../core/fleet/bus-envelope.js';
import { BusMailboxError, createBusMailbox, validateBusAddress, type BusMailbox, type BusMailboxPendingMessage } from '../core/fleet/bus-mailbox.js';
import { parseSince } from '../core/fleet/agent-messages.js';
import { agentChannelNameSchema, agentRefAddressMatcher, readAgentRegistry, type AgentRegistry } from '../core/agents/bus-identity.js';
import { busBodyInReplyToMatch, busBodyJobMatch, busReadContains, busReadContainsMatch, BUS_READ_CONTAINS_MAX } from '../core/agents/bus-unified.js';
import { busBodyThread } from '../core/agents/bus-v2-schema.js';

export const BUS_USAGE = `Usage: phm bus <send|inbox|ack> [--json]
  send --from <label> --to <label> --body <json> [--id <id>] [--priority P0|P1|P2|P3] [--ttl <ms>]
  inbox --to <label> [--limit <1..1000>] [--from <label>] [--exclude-from <label>]
        [--priority P0|P1|P2|P3] [--job <id>] [--channel <name>]
        [--since <15m|2h|1d|ISO>] [--before <15m|2h|1d|ISO>] [--contains <text>]
        [--in-reply-to <id>] [--thread <t>]
  ack <id> --to <label>

Local durable mailboxes under $ASHLR_HOME/bus-mailbox (default ~/.ashlr/bus-mailbox).
Send defaults: random UUID, priority P2, TTL 300000 ms. Retry with the same ID
and identical envelope for deduplication; retries do not renew TTL.
Inbox reads pending, unexpired messages in priority/acceptance order, default
limit 100; hasMore reports truncation of the filtered set. Reading never
acknowledges a message. Ack is idempotent and checks the recipient. Labels are
not authenticated identities.
The inbox filters are the same rules every other bus read applies and compose
with AND: --from keeps mail one sender label wrote and --exclude-from drops it
(each resolves through the agent identity registry like agents bus inbox
--from, so an identity's handle, agent: address, id and aliases all match, and
an unresolvable ref or unreadable registry keeps exact-label matching);
--priority keeps one P0..P3 band; --job keeps only envelopes whose body cites
that job — the same busBodyJobMatch rule agents bus inbox --job applies;
--channel keeps only mail addressed to group:<name>:* — the room's whole
traffic under every topic; --since keeps mail accepted at or after the cutoff
and --before only mail accepted strictly before its own cutoff, composing one
[since, before) window on the store acceptance time; --contains keeps only
envelopes whose scrubbed one-line summary carries the needle as a
case-insensitive substring — the same text agents bus inbox --contains
matches, never the raw body; --in-reply-to keeps only bodies whose own
inReplyTo field cites that envelope id; --thread keeps only note/context
bodies carrying that conversation label.
Use --name=value for flag-shaped values, and ack --to <label> [--json] -- <id>
for a flag-shaped message ID.
No remote dispatch or agent execution. Use Phantom Secrets phm_<name> references.
History is retained, with at most 5000 messages and 64 MiB including reserved
acknowledgment space. Capacity refusal preserves existing inboxes and acknowledgments.
JSON mode emits one object, including errors. --help / -h performs no work.`;

class UsageError extends Error {}

const OPTIONS: Record<string, readonly string[]> = {
  send: ['--from', '--to', '--body', '--id', '--priority', '--ttl'],
  inbox: ['--to', '--limit', '--from', '--exclude-from', '--priority', '--job', '--channel',
    '--since', '--before', '--contains', '--in-reply-to', '--thread'],
  ack: ['--to'],
};

function integer(raw: string, name: string, max = Number.MAX_SAFE_INTEGER): number {
  const n = Number(raw);
  if (!/^[0-9]+$/.test(raw) || !Number.isSafeInteger(n) || n < 1 || n > max) {
    throw new UsageError(`${name} requires a positive integer${max === 1000 ? ' at most 1000' : ''}.`);
  }
  return n;
}

/** Printable ASCII routing labels, the same constraint the wire token fields carry. */
const FILTER_LABEL = /^[\x21-\x7e]{1,128}(?![\s\S])/;

function filterLabel(values: Map<string, string>, flag: string): string | undefined {
  const value = values.get(flag);
  if (value === undefined) return undefined;
  if (!FILTER_LABEL.test(value)) throw new UsageError(`${flag} takes a printable routing label of 1-128 characters.`);
  return value;
}

/**
 * The `phm bus inbox` read filters as one `BusMailbox.inbox` match predicate —
 * undefined when no filter flag was supplied, so an unfiltered read keeps its
 * exact prior behavior. Every rule is the one the other bus reads share:
 * `busBodyJobMatch`/`busBodyInReplyToMatch`/`busReadContainsMatch`/`busBodyThread`
 * body citations, the `group:<channel>:` `to` prefix, the P0..P3 band, the
 * `[since, before)` acceptance-time window, and `agentRefAddressMatcher`
 * sender matching that resolves each ref through the agent identity registry
 * (exact-label fallback on an unresolvable ref or unreadable registry, so
 * unknown identity state never widens the filter). All flags AND together.
 */
function inboxMatch(values: Map<string, string>): ((message: BusMailboxPendingMessage) => boolean) | undefined {
  const from = filterLabel(values, '--from');
  const excludeFrom = filterLabel(values, '--exclude-from');
  const job = filterLabel(values, '--job');
  const thread = filterLabel(values, '--thread');
  const inReplyTo = filterLabel(values, '--in-reply-to');
  const priorityRaw = values.get('--priority');
  if (priorityRaw !== undefined && !(BUS_PRIORITIES as readonly string[]).includes(priorityRaw)) {
    throw new UsageError('--priority takes P0, P1, P2 or P3.');
  }
  const priority = priorityRaw as BusPriority | undefined;
  const channelRaw = values.get('--channel');
  if (channelRaw !== undefined && !agentChannelNameSchema.safeParse(channelRaw).success) {
    throw new UsageError('--channel takes a bus channel name (a-z, 0-9, _ -; 1-32 chars).');
  }
  const channelPrefix = channelRaw === undefined ? undefined : `group:${channelRaw}:`;
  const bound = (flag: '--since' | '--before'): number | undefined => {
    const raw = values.get(flag);
    if (raw === undefined) return undefined;
    const ms = parseSince(raw);
    if (ms === null) throw new UsageError(`${flag} takes 15m, 2h, 1d, epoch ms or an ISO time.`);
    return ms;
  };
  const sinceMs = bound('--since');
  const beforeMs = bound('--before');
  const containsNeedle = busReadContains(values.get('--contains'));
  if (containsNeedle === null) {
    throw new UsageError(`--contains takes a non-empty search text of at most ${BUS_READ_CONTAINS_MAX} characters.`);
  }
  if (from === undefined && excludeFrom === undefined && job === undefined && thread === undefined &&
    inReplyTo === undefined && priority === undefined && channelPrefix === undefined &&
    sinceMs === undefined && beforeMs === undefined && containsNeedle === undefined) return undefined;
  // The registry read runs only when a sender filter needs it; an unreadable
  // or missing registry resolves nothing, so both matchers keep exact-label
  // matching — the same unknown-stays-unknown rule every bus read applies.
  let registry: AgentRegistry | undefined;
  if (from !== undefined || excludeFrom !== undefined) {
    const read = readAgentRegistry();
    registry = read.status === 'ok' ? read.registry : undefined;
  }
  const fromMatch = from === undefined ? undefined : agentRefAddressMatcher(from, registry);
  const excludeFromMatch = excludeFrom === undefined ? undefined : agentRefAddressMatcher(excludeFrom, registry);
  return (message) => {
    const { envelope, acceptedAt } = message;
    return (fromMatch === undefined || fromMatch(envelope.from)) &&
      (excludeFromMatch === undefined || !excludeFromMatch(envelope.from)) &&
      (priority === undefined || envelope.priority === priority) &&
      (job === undefined || busBodyJobMatch(envelope.body, job)) &&
      (channelPrefix === undefined || envelope.to.startsWith(channelPrefix)) &&
      (sinceMs === undefined || acceptedAt >= sinceMs) &&
      (beforeMs === undefined || acceptedAt < beforeMs) &&
      (containsNeedle === undefined || busReadContainsMatch(envelope.body, containsNeedle)) &&
      (inReplyTo === undefined || busBodyInReplyToMatch(envelope.body, inReplyTo)) &&
      (thread === undefined || busBodyThread(envelope.body) === thread);
  };
}

/** Factory injection keeps parsing tests independent of persistence; production always uses the real core. */
export async function cmdBus(argv: string[], load: () => BusMailbox = createBusMailbox): Promise<number> {
  const separator = argv.indexOf('--');
  const json = argv.slice(0, separator < 0 ? undefined : separator).includes('--json');
  const output = (value: unknown, human: string): void => { console.log(json ? JSON.stringify(value) : human); };
  try {
    const args: string[] = [];
    const values = new Map<string, string>();
    let literalStart = Infinity;
    const sub = argv.find(token => token !== '--json');
    const allowed = sub && Object.hasOwn(OPTIONS, sub) ? OPTIONS[sub] : undefined;
    let help = false;
    let seenJson = false;
    // Parse values before interpreting booleans: a quoted body of "--help"
    // must not bypass validation or turn an intended send into a help request.
    for (let i = 0; i < argv.length; i++) {
      const token = argv[i]!;
      if (token === '--') { literalStart = args.length; args.push(...argv.slice(i + 1)); break; }
      const equal = token.indexOf('=');
      const option = equal > 0 ? token.slice(0, equal) : token;
      if (allowed?.includes(option)) {
        if (values.has(option)) throw new UsageError(`Duplicate ${option} option.`);
        const value = equal > 0 ? token.slice(equal + 1) : argv[++i];
        if (value === undefined || (equal < 0 && value.startsWith('--'))) throw new UsageError(`${option} requires a value.`);
        values.set(option, value);
      } else if (token === '--json') {
        if (seenJson) throw new UsageError('Duplicate --json option.');
        seenJson = true;
      } else if (token === '--help' || token === '-h') {
        help = true;
      } else { args.push(token); }
    }
    if (help && (sub === '--help' || sub === '-h' || allowed)) { output({ ok: true, usage: BUS_USAGE }, BUS_USAGE); return 0; }
    if (!allowed || !sub) throw new UsageError('Expected send, inbox or ack.');
    const operands = args.slice(1);
    for (const token of args.slice(1, literalStart)) {
      if (token.startsWith('-')) throw new UsageError('Unknown bus option.');
    }
    if (operands.length !== (sub === 'ack' ? 1 : 0)) throw new UsageError('Unexpected or missing bus operand.');
    const required = (name: string): string => {
      const value = values.get(name);
      if (value === undefined || value.length === 0) throw new UsageError(`${name} is required.`);
      return value;
    };
    const to = required('--to');
    validateBusAddress(to);
    if (sub === 'send') {
      const body = required('--body');
      if (body.length > MAX_BUS_ENVELOPE_BYTES || Buffer.byteLength(body) > MAX_BUS_ENVELOPE_BYTES) {
        throw new UsageError('Body exceeds the bus envelope size limit.');
      }
      let parsed: unknown;
      try { parsed = JSON.parse(body); } catch { throw new UsageError('--body requires valid JSON.'); }
      const checked = validateBusEnvelope({
        id: values.get('--id') ?? randomUUID(), from: required('--from'), to,
        priority: values.get('--priority') ?? 'P2', ttl: integer(values.get('--ttl') ?? '300000', '--ttl'), body: parsed,
      });
      if (!checked.ok) throw new UsageError('Invalid bus envelope: check labels, priority, TTL, JSON depth and size.');
      const result = load().send(checked.value);
      output({ ok: true, ...result }, `Message ${result.replayed ? 'already accepted' : 'accepted'}: ${result.id}`);
    } else if (sub === 'inbox') {
      const limit = integer(values.get('--limit') ?? '100', '--limit', 1000);
      const match = inboxMatch(values);
      const result = load().inbox(to, limit, match);
      output({ ok: true, ...result }, result.messages.length
        ? result.messages.map(m => `${m.id} ${m.priority} ${m.from} -> ${m.to}\n${JSON.stringify(m.body)}`).join('\n') +
          (result.hasMore ? '\nMore pending messages; increase --limit or acknowledge processed messages.' : '')
        : 'No pending messages.');
    } else {
      const id = operands[0]!;
      validateBusAddress(id);
      const result = load().ack(id, to);
      output({ ok: true, ...result }, `Acknowledged: ${result.id}`);
    }
    return 0;
  } catch (error) {
    // Never echo raw argv, JSON parser exceptions or filesystem error paths.
    const usage = error instanceof UsageError || (error instanceof BusMailboxError && error.code === 'invalid-address');
    const message = error instanceof UsageError || error instanceof BusMailboxError ? error.message : 'Bus operation failed.';
    if (json) output({ ok: false, error: { code: usage ? 'usage' : error instanceof BusMailboxError ? error.code : 'operation-failed', message } }, '');
    else console.error(`phm bus: ${message}${usage ? '\n' + BUS_USAGE : ''}`);
    return usage ? 2 : 1;
  }
}
