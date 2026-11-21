/** Thin argv adapter for the unified agent bus (src/core/agents/bus-unified.ts). Exit 0 ok, 1 refused, 2 usage. */
import { isAbsolute } from 'node:path';
import {
  BUS_CLIS, createAgentChannel, joinAgentChannel, leaveAgentChannel, readAgentRegistry, registerAgentIdentity,
  type BusCli, type BusProvider,
} from '../core/agents/bus-identity.js';
import {
  agentWakeClaimHolderSuffix, announceWork, busBodyFallbackSummary, busInboxJobMarker, listBusChannels, postChannelMessage, postLabelMessage,
  readAgentChannel, readAgentInbox, readAgentWakes, readBusEnvelopeById, sendDirectMessage, sendHandoff, sendWakeRequest,
  updateWorkStatus, INBOX_KINDS, type BusEnvelopeLookupJob, type InboxKind, type UnifiedBusOptions, type WorkStatusInput,
} from '../core/agents/bus-unified.js';
import { WORK_STATUSES, parseClaimKey, type WorkJob } from '../core/agents/bus-v2-schema.js';
import { busWorkFeedOwnerMatcher, busWorkFeedToMatcher, formatBusWorkFeed, formatBusWorkFeedJob, projectBusWorkFeedView, readBusWorkFeed } from '../core/agents/bus-work-feed-read.js';
import { attachBusCliSession, detectBusCli, frameBusInbox, listBusCliAdapters } from '../core/agents/bus-cli-adapters.js';
import { busClaimExitCode, claimBusWorkJob, executeBusClaimBody, listBusClaims, newBusClaimOpId,
  type BusClaimResult, type BusClaimJobRef, type BusWorkJobClaimResult, type BusWorkJobClaimScope } from '../core/agents/bus-claims.js';
import { formatBusWorkMine, readBusWorkMine } from '../core/agents/bus-work-mine.js';
import { readUnifiedBusStatus } from '../core/agents/bus-status.js';
import { scrubSecrets } from '../core/util/scrub.js';
import { BUS_PRIORITIES, type BusPriority } from '../core/fleet/bus-envelope.js';
import { seatParticipants } from '../core/bots/seats.js';

export const AGENTS_BUS_UNIFIED_VERBS = new Set(['id', 'dm', 'post', 'channel', 'handoff', 'wake', 'inbox', 'wakes', 'show', 'adapters', 'claim', 'work', 'status']);

export const AGENTS_BUS_UNIFIED_HELP = `ashlr agents bus id register [<handle>] [--cli <cli>] [--provider <p>] [--model <m>] [--alias <label>]... [--display <name>]
ashlr agents bus id list
ashlr agents bus dm --to <agent> --text <text> [--from <agent>] [--priority P0..P3] [--thread <t>] [--ref <ref>]... [--id <id>] [--ttl <ms>] [--wake|--no-wake]
ashlr agents bus post --to <label> --text <text> [--kind note|context] [--from <agent>] [--priority P0..P3] [--thread <t>] [--ref <ref>]... [--id <id>] [--ttl <ms>] [--wake|--no-wake]
ashlr agents bus channel create <name> [--from <agent>] [--member <agent>]...
ashlr agents bus channel join|leave <name> [--agent <agent>]
ashlr agents bus channel post <name> --text <text> [--from <agent>] [--topic <t>] [--ref <ref>]... [--priority ..] [--wake|--no-wake]
ashlr agents bus channel list [--agent <agent>]
ashlr agents bus channel read <name> [--topic <t>] [--from <agent>] [--thread <t>] [--priority P0..P3] [--matched] [--after <cursor>] [--limit <1..100>]
ashlr agents bus handoff --to <agent> --task <job id> --prompt <text> [--from <agent>] [--priority ..] [--no-wake]
ashlr agents bus wake --to <agent> --reason <text> [--job <id>] [--from <agent>] [--priority P0..P3] [--id <id>] [--ttl <ms>]
ashlr agents bus inbox [<agent>] [--after <cursor>] [--limit <1..100>] [--thread <t>] [--from <agent>] [--priority P0..P3] [--kind dm|channel|handoff|legacy] [--matched] [--frame <cli>]
ashlr agents bus wakes [<agent>] [--since <epoch ms>]
ashlr agents bus show <id>
ashlr agents bus adapters
ashlr agents bus claim acquire --key <claimKey> --lease-ms <1..3600000> [--owner <label>] [--id <opId>]
ashlr agents bus claim renew --key <claimKey> --token <64hex> --lease-ms <1..3600000>
ashlr agents bus claim release --key <claimKey> --token <64hex> --outcome released|completed
ashlr agents bus claim list [--key <claimKey>] [--owner <label>] [--jobs]
ashlr agents bus work post --job <id> --title <text> --repo <owner/name> [--claim <key>]... [--to <label>]
    [--provider <p>] [--tier <fast|mid|work|frontier> --scope <text> --acceptance <text>]
    [--from <agent>] [--priority P0..P3] [--id <id>] [--ttl <ms>] [--wake|--no-wake]
ashlr agents bus work status --job <id> --status <${WORK_STATUSES.join('|')}> [--detail <text>] [--to <label>]
    [--from <agent>] [--priority P0..P3] [--id <id>] [--ttl <ms>] [--wake|--no-wake]
ashlr agents bus work feed [--status <${WORK_STATUSES.join('|')}>] [--job <id>] [--to <label>] [--owner <agent>] [--claims]
ashlr agents bus work claim --job <id> --lease-ms <1..3600000> [--key <claimKey>] [--owner <label>] [--id <opId>]
ashlr agents bus work mine [<agent>]
ashlr agents bus status
Common: [--root <abs>] [--json]. <agent> is a handle, agent:<handle>, agt_ id or alias;
--from, --agent and a missing <agent> default to PHM_AGENT_ID. Identities are routing
names, never authentication. Messages land in the one local bus store; P0 always
wakes, P1 and handoffs wake by default, and wake always records its hint.
post sends a v2 note (or context with --kind context) to any printable routing
label outside the reserved agent:/group:/dm:/handoff: prefixes — the sink and
topic mail dm, channel post and the work verbs cannot carry; the sender is
still a registered identity under the same scrub and wake rules.
--thread on dm, post, channel post, inbox and channel read is the v2 conversation
label carried by note/context bodies; reads match that field only. --from on
inbox and channel read narrows to one sender — a handle, agent:<handle>,
stable id or alias; an unresolvable ref keeps exact-label matching. --priority
on inbox and channel read keeps only one exact P0..P3 band — the same match
comms bus read --priority applies — so urgent mail is one filtered read, not
a page through the backlog. --kind on inbox keeps only one delivery kind —
dm, channel, handoff or legacy, the same kind each inbox row prints — so an
agent can read just its handoffs or just its direct mail in one filtered
read; it composes with every other inbox filter and --matched counts only
the rows it accepts. --matched
on inbox and channel read reports matched, the true pending total across the
whole retained store the same filters accept; messages still caps at --limit
and nextCursor then resumes at the newest shown row, so paging never skips
an unshown match. Inbox rows annotate what they carry: claimable work and
worker-handoff bodies report held/holder — whether a taken claim or live
coordination hold already covers the receipt — and work.post/work.status
bodies report job, the live feed state of the jobId they cite (the same
annotation show resolves, read once per page), so an agent sees hold and
job state without a lookup per message.
show
resolves one retained envelope by the wire id wake hints, work mine items
and claim operations cite; an expired id reports not-found, and the read
needs no identity. A work.post or work.status body additionally reports
job — the live work-feed state of the jobId it cites, with claim
coverage, or the feed's own refused/unavailable state when the projection
cannot answer — so the citation resolves to where the job stands in one
read. A claim-holder wh-… hint id resolves through the wake
queue to the live terminal work.status receipt that cites it, returned
with its wakeHint citation; a hint no live receipt reproduces reports
not-found.
A terminal work status also queues a routing-only wake hint for each live claim
holder on the job's keys; --no-wake opts out. Holder labels need not be
registered identities, so wakes (and the work mine wakes section) keep
exact-label matching for a ref that resolves to no identity — JSON reports
scope: label and only hints whose to is that label verbatim match. work feed and claim list are
read-only and need no identity; work feed --to keeps jobs announced to that
routing label and --owner keeps jobs announced by that agent, each under
every label of one agent identity, while --job keeps one job id. work claim
takes one of
a shown job's declared claim keys — queue:<jobId> preferred, --key picks
another declared key — into the shared coordination table, reporting live
holds on the job's other declared keys; claims coordinate,
never authenticate. work mine is a read-only per-agent digest — the live
claims it holds under any of its labels, the open feed jobs still claimable
for it, the feed jobs it announced that have not finished (done and
terminated drop off; failed stays listed because only the announcer may
move it), the claimable work envelopes addressed to it or a channel it
belongs
to in bus-next order with their hold state, the worker-handoff assignments
addressed the same way (each item carries the to label handoff-receive and
handoff-reply take verbatim), the conversation threads waiting on its
answer — asks and handoffs whose latest message it or a channel it belongs
to still owes, each citing the envelope id show resolves — the
conversation threads it is waiting on — its own asks and handoffs nobody
has answered yet, each naming who owes the reply — its
pending wake hints, the next page of mail addressed
to it and pending legacy phm bus mailbox mail addressed to any of its
labels — capped sections carry matched (or open for jobs) as their true
pending total — where every section reports its own read state and unknown
stays unknown.
status is a read-only probe of the store, registry, wake queue, coordination
table, message-id claim journal and work feed; a section that cannot be read
reports unavailable or unknown, never zero.
No network, no engine runs. Spec: docs/AGENT-BUS.md.`;

const VALUE_FLAGS = new Set(['--from', '--to', '--text', '--priority', '--thread', '--id', '--ttl', '--cli', '--provider',
  '--model', '--alias', '--display', '--member', '--agent', '--topic', '--task', '--prompt', '--after', '--limit',
  '--frame', '--since', '--root', '--key', '--owner', '--lease-ms', '--token', '--outcome', '--reason',
  '--job', '--title', '--repo', '--claim', '--tier', '--scope', '--acceptance', '--status', '--detail', '--ref',
  '--kind']);
const MULTI = new Set(['--alias', '--member', '--claim', '--ref']);
const BOOL_FLAGS = new Set(['--json', '--wake', '--no-wake', '--claims', '--jobs', '--matched']);

class UsageError extends Error {}

interface Parsed { positionals: string[]; values: Map<string, string[]>; bools: Set<string> }

function parse(argv: string[]): Parsed {
  const parsed: Parsed = { positionals: [], values: new Map(), bools: new Set() };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i]!;
    const equal = token.startsWith('--') ? token.indexOf('=') : -1;
    const flag = equal > 0 ? token.slice(0, equal) : token;
    if (VALUE_FLAGS.has(flag)) {
      const value = equal > 0 ? token.slice(equal + 1) : argv[++i];
      if (value === undefined || (equal < 0 && value.startsWith('--'))) throw new UsageError(`${flag} requires a value.`);
      const list = parsed.values.get(flag) ?? [];
      if (list.length && !MULTI.has(flag)) throw new UsageError(`Duplicate ${flag}.`);
      parsed.values.set(flag, [...list, value]);
    } else if (BOOL_FLAGS.has(token)) {
      if (parsed.bools.has(token)) throw new UsageError(`Duplicate ${token}.`);
      parsed.bools.add(token);
    } else if (token.startsWith('-')) {
      throw new UsageError(`Unknown option ${token.slice(0, 32)}.`);
    } else parsed.positionals.push(token);
  }
  if (parsed.bools.has('--wake') && parsed.bools.has('--no-wake')) throw new UsageError('Use --wake or --no-wake, not both.');
  return parsed;
}

function integer(raw: string | undefined, name: string): number | undefined {
  if (raw === undefined) return undefined;
  if (!/^[0-9]{1,16}$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new UsageError(`${name} must be a non-negative integer.`);
  return Number(raw);
}

/** `RQ-1(running) "Fix the feed" detail="why"` — the blocked job named by its
 * announcement title and newest status detail, display-clipped. */
function claimJobLabel(job: BusClaimJobRef): string {
  // eslint-disable-next-line no-control-regex
  const flat = (value: string): string => scrubSecrets(value).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
  const clip = (value: string, max: number): string => {
    const text = flat(value);
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
  };
  const title = clip(job.title, 80);
  const detail = job.detail === undefined ? '' : clip(job.detail, 80);
  return `${job.id}(${job.status})${title === '' ? '' : ` "${title}"`}` +
    `${detail === '' ? '' : ` detail="${detail}"`}`;
}

function claimHuman(result: BusClaimResult): string {
  if (result.status === 'acquired') {
    return `acquired ${result.claim.claimKey} owner=${result.claim.owner} leaseMs=${result.claim.leaseMs} leaseUntil=${result.claim.leaseUntil} token=${result.claim.token}`;
  }
  if (result.status === 'renewed') return `renewed ${result.claim.claimKey} leaseUntil=${result.claim.leaseUntil}`;
  if (result.status === 'released' || result.status === 'completed') return `${result.status} ${result.claimKey}`;
  if (result.status === 'conflict') return `conflict ${result.holder.claimKey} held by ${result.holder.owner} until ${result.holder.leaseUntil}`;
  return result.status;
}

/** `work claim` human lines: the job named by its announcement title, the fencing token only on acquire. */
function claimScopeSuffix(scope: BusWorkJobClaimScope): string {
  if (scope.source === 'unavailable') return ' scope=unknown';
  if (scope.holds.length === 0) return '';
  return ` scope-held=${scope.holds.map(hold => `${hold.claimKey}@${hold.owner}`).join(',')}`;
}

function workJobClaimHuman(result: BusWorkJobClaimResult): string {
  if (result.status === 'acquired') {
    return `acquired ${result.claim.claimKey} for ${claimJobLabel(result.job)} owner=${result.claim.owner} ` +
      `leaseUntil=${new Date(result.claim.leaseUntil).toISOString()} token=${result.claim.token}${claimScopeSuffix(result.scope)}`;
  }
  if (result.status === 'conflict') {
    return `conflict ${result.holder.claimKey} for ${claimJobLabel(result.job)} held by ${result.holder.owner} ` +
      `until ${new Date(result.holder.leaseUntil).toISOString()}${claimScopeSuffix(result.scope)}`;
  }
  return `${result.status}: ${result.reason}${result.job === undefined ? '' : ` (${claimJobLabel(result.job)})`}`;
}

/** work claim exit codes mirror claim acquire: acquired 0, invalid 2, every other refusal 1. */
function workJobClaimExitCode(result: BusWorkJobClaimResult): number {
  return result.status === 'acquired' ? 0 : result.status === 'invalid' ? 2 : 1;
}

/** One human line for the live feed state `show` resolved beside a work envelope. */
function showJobLine(job: BusEnvelopeLookupJob): string {
  if (job.feed === 'ok') {
    return job.job === null ? `  job ${job.jobId} feed=ok job=absent` : `  job ${formatBusWorkFeedJob(job.job)}`;
  }
  if (job.feed === 'refused') {
    return `  job ${job.jobId} feed=refused:${job.reason}` +
      `${job.receipt === undefined ? '' : ` receipt=${job.receipt.id}`}`;
  }
  return `  job ${job.jobId} feed=${job.feed}`;
}

export async function runAgentsBusUnified(argv: string[], out: (text: string) => void, err: (text: string) => void,
  env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const json = argv.includes('--json');
  try {
    if (argv.some(arg => arg === '--help' || arg === '-h')) { out(AGENTS_BUS_UNIFIED_HELP); return 0; }
    const p = parse(argv);
    const one = (flag: string): string | undefined => p.values.get(flag)?.[0];
    const root = one('--root');
    if (root !== undefined && (!isAbsolute(root) || root.includes('\0'))) throw new UsageError('--root must be an absolute path.');
    const options: UnifiedBusOptions = root ? { root } : {};
    const self = env['PHM_AGENT_ID'] || undefined;
    const actor = (flag: string): string => {
      const value = one(flag) ?? self;
      if (!value) throw new UsageError(`${flag} is required when PHM_AGENT_ID is not set.`);
      return value;
    };
    const required = (flag: string): string => {
      const value = one(flag);
      if (value === undefined) throw new UsageError(`${flag} is required.`);
      return value;
    };
    const wake = p.bools.has('--wake') ? true : p.bools.has('--no-wake') ? false : undefined;
    const send = {
      priority: one('--priority') as BusPriority | undefined, ttl: integer(one('--ttl'), '--ttl'), id: one('--id'), wake,
    };
    // Read-side --priority is an enum like --frame/--status: a bad band is a
    // usage error here and an 'invalid' result inside the core read.
    const priorityArg = (): BusPriority | undefined => {
      const value = one('--priority');
      if (value !== undefined && !(BUS_PRIORITIES as readonly string[]).includes(value)) {
        throw new UsageError('--priority must be P0, P1, P2 or P3.');
      }
      return value as BusPriority | undefined;
    };
    // Read-side --kind on inbox is the delivery-kind enum: a bad value is a
    // usage error here and an 'invalid' result inside the core read.
    const kindArg = (): InboxKind | undefined => {
      const value = one('--kind');
      if (value !== undefined && !(INBOX_KINDS as readonly string[]).includes(value)) {
        throw new UsageError('--kind must be dm, channel, handoff or legacy.');
      }
      return value as InboxKind | undefined;
    };
    const [verb, sub, arg, ...extra] = p.positionals;
    const finish = (result: { status: string; reason?: string }, human: string): number => {
      const ok = !('reason' in result) || result.reason === undefined;
      out(json ? JSON.stringify(result) : ok ? human : `${result.status}: ${result.reason}`);
      return ok ? 0 : 1;
    };
    const noExtra = (count: number): void => {
      if (p.positionals.length > count) throw new UsageError('Unexpected operand.');
    };

    if (verb === 'status') {
      noExtra(1);
      const result = readUnifiedBusStatus(options);
      if (json) { out(JSON.stringify(result)); return 0; }
      const unknown = 'unknown';
      out([
        `store ${result.store.source} retained=${result.store.retainedCount ?? unknown}/${result.store.maxMessages} ` +
          `bytes=${result.store.retainedBytes ?? unknown}/${result.store.maxBytes} ` +
          `live=${result.store.liveCount ?? unknown} expired=${result.store.expiredCount ?? unknown}`,
        `registry ${result.registry.source} identities=${result.registry.identities ?? unknown} channels=${result.registry.channels ?? unknown}`,
        `wakes ${result.wakes.state} hints=${result.wakes.hints ?? unknown} truncated=${result.wakes.truncated ?? unknown}`,
        `coordination ${result.coordination.source} liveClaims=${result.coordination.liveClaims ?? unknown} statuses=${result.coordination.statuses ?? unknown}`,
        `workClaims ${result.workClaims.source} claims=${result.workClaims.claims ?? unknown}`,
        `feed ${result.feed.status}${result.feed.reason === undefined ? '' : `:${result.feed.reason}`} jobs=${result.feed.jobs ?? unknown}`,
        `mailbox ${result.mailbox.source} pending=${result.mailbox.pending ?? unknown}`,
        `as-of=${result.asOf}`,
      ].join('\n'));
      return 0;
    }
    if (verb === 'adapters') {
      noExtra(1);
      const adapters = listBusCliAdapters();
      out(json ? JSON.stringify({ adapters }) : adapters.map(a =>
        `${a.cli.padEnd(7)} providers=${a.providers.join(',')} engine=${a.engine?.entry ?? 'session'}  ${a.note}`).join('\n'));
      return 0;
    }
    if (verb === 'id' && sub === 'list') {
      noExtra(2);
      const read = readAgentRegistry(options);
      if (read.status !== 'ok') return finish(read, '');
      const participants = await seatParticipants();
      const lines = [
        ...read.registry.identities.map(i => `${i.handle.padEnd(16)} ${i.id}  runtimes=${i.runtimes.map(r => `${r.cli}/${r.provider}${r.model ? `/${r.model}` : ''}`).join(',') || '-'}${i.aliases.length ? `  aliases=${i.aliases.join(',')}` : ''}`),
        ...participants.map(p => `${p.participantId.padEnd(16)} ${p.provider}  seat=${p.status}`),
      ];
      out(json ? JSON.stringify({ status: 'ok', identities: read.registry.identities, channels: read.registry.channels, participants })
        : lines.join('\n') || 'No identities registered.');
      return 0;
    }
    if (verb === 'id' && sub === 'register') {
      noExtra(3);
      const cli = one('--cli');
      if (cli !== undefined && !(BUS_CLIS as readonly string[]).includes(cli)) throw new UsageError(`--cli must be one of ${BUS_CLIS.join(', ')}.`);
      const aliases = p.values.get('--alias') ?? [];
      const displayName = one('--display');
      const handle = arg ?? self;
      if (!handle) throw new UsageError('A handle or PHM_AGENT_ID is required.');
      const runtime = cli !== undefined || one('--model') !== undefined || one('--provider') !== undefined || detectBusCli(env) !== null;
      const result = runtime
        ? attachBusCliSession({ handle, cli: cli as BusCli | undefined, provider: one('--provider') as BusProvider | undefined,
          model: one('--model'), aliases, displayName }, env, options)
        : registerAgentIdentity({ handle, aliases, displayName }, options);
      return finish(result, 'identity' in result ? `${result.status}: ${result.identity.handle} ${result.identity.id}` : '');
    }
    if (verb === 'dm') {
      noExtra(1);
      const result = await sendDirectMessage({ ...send, from: actor('--from'), to: required('--to'), text: required('--text'),
        thread: one('--thread'), refs: p.values.get('--ref') }, options);
      return finish(result, 'id' in result ? `${result.status}: ${result.id} -> ${result.to} (wake ${result.wake})` : '');
    }
    if (verb === 'post') {
      noExtra(1);
      const kind = one('--kind');
      if (kind !== undefined && kind !== 'note' && kind !== 'context') {
        throw new UsageError('--kind must be note or context.');
      }
      const result = await postLabelMessage({ ...send, from: actor('--from'), to: required('--to'), text: required('--text'),
        kind: kind as 'note' | 'context' | undefined, thread: one('--thread'), refs: p.values.get('--ref') }, options);
      return finish(result, 'id' in result ? `${result.status}: ${result.id} -> ${result.to} (wake ${result.wake})` : '');
    }
    if (verb === 'channel' && sub === 'list') {
      noExtra(2);
      const result = listBusChannels(one('--agent'), options);
      if (result.status !== 'ok') return finish(result, '');
      out(json ? JSON.stringify(result) : [
        ...result.channels.map(c => `#${c.name}  members=${c.members.join(',') || '-'}  createdBy=${c.createdBy}  createdAt=${new Date(c.createdAt).toISOString()}`),
        `channels=${result.channels.length} source=${result.source}${result.agent === null ? '' : ` agent=${result.agent}`}`,
      ].join('\n'));
      return 0;
    }
    if (verb === 'channel' && arg !== undefined && extra.length === 0) {
      if (sub === 'create') {
        const result = createAgentChannel({ name: arg, createdBy: actor('--from'), members: p.values.get('--member') ?? [] }, options);
        return finish(result, 'channel' in result ? `${result.status}: #${result.channel.name} ${result.channel.members.join(',')}` : '');
      }
      if (sub === 'join' || sub === 'leave') {
        const result = (sub === 'join' ? joinAgentChannel : leaveAgentChannel)(arg, actor('--agent'), options);
        return finish(result, 'channel' in result ? `${result.status}: #${result.channel.name} ${result.channel.members.join(',')}` : '');
      }
      if (sub === 'post') {
        const result = await postChannelMessage({ ...send, from: actor('--from'), channel: arg, topic: one('--topic'),
          text: required('--text'), thread: one('--thread'), refs: p.values.get('--ref') }, options);
        return finish(result, 'id' in result ? `${result.status}: ${result.id} -> ${result.to} (wake ${result.wake})` : '');
      }
      if (sub === 'read') {
        const result = readAgentChannel(arg, { topic: one('--topic'), from: one('--from'), thread: one('--thread'),
          priority: priorityArg(), matched: p.bools.has('--matched'),
          after: integer(one('--after'), '--after'), limit: integer(one('--limit'), '--limit') }, options);
        if (result.status !== 'ok') return finish(result, '');
        // --matched scans the whole store, so the core nextCursor is the store's
        // end — resuming there would skip unshown matches. The honest resume
        // point is the newest shown row's cursor (the same rule inbox applies).
        const nextCursor = result.matched !== undefined && result.matched > result.messages.length
          ? Math.max(...result.messages.map(m => m.cursor)) : result.nextCursor;
        const shown = { ...result, nextCursor };
        out(json ? JSON.stringify(shown) : [
          ...shown.messages.map(m => `${m.cursor} ${m.priority} #${shown.channel}:${m.topic} ${m.envelope.id} from ${m.fromAgent ?? m.envelope.from}`),
          ...(result.matched === undefined ? [] : [`matched ${result.matched}`]),
          `nextCursor ${nextCursor}`,
        ].join('\n'));
        return 0;
      }
    }
    if (verb === 'handoff') {
      noExtra(1);
      const result = await sendHandoff({ ...send, from: actor('--from'), to: required('--to'), taskId: required('--task'),
        prompt: required('--prompt') }, options);
      return finish(result, 'id' in result ? `${result.status}: ${result.id} -> ${result.to} (wake ${result.wake})` : '');
    }
    if (verb === 'wake') {
      noExtra(1);
      if (p.bools.has('--wake') || p.bools.has('--no-wake')) {
        throw new UsageError('wake always records its hint; --wake and --no-wake do not apply.');
      }
      const result = await sendWakeRequest({ ...send, from: actor('--from'), to: required('--to'),
        reason: required('--reason'), jobId: one('--job') }, options);
      return finish(result, 'id' in result ? `${result.status}: ${result.id} -> ${result.to} (wake ${result.wake})` : '');
    }
    if (verb === 'inbox') {
      noExtra(2);
      const frame = one('--frame');
      if (frame !== undefined && !(BUS_CLIS as readonly string[]).includes(frame)) throw new UsageError(`--frame must be one of ${BUS_CLIS.join(', ')}.`);
      const agent = sub ?? self;
      if (!agent) throw new UsageError('An agent or PHM_AGENT_ID is required.');
      const page = readAgentInbox(agent, { after: integer(one('--after'), '--after'), limit: integer(one('--limit'), '--limit'),
        thread: one('--thread'), from: one('--from'), priority: priorityArg(), kind: kindArg(), matched: p.bools.has('--matched') }, options);
      if (page.status !== 'ok') return finish(page, '');
      // --matched scans the whole store, so the core nextCursor is the store's
      // end — resuming there would skip unshown matches. The honest resume
      // point is the newest shown row's cursor: every unshown match sits
      // beyond it and every shown one at or before it (the same rule the
      // work mine inbox section applies).
      const nextCursor = page.matched !== undefined && page.matched > page.messages.length
        ? Math.max(...page.messages.map(m => m.cursor)) : page.nextCursor;
      const shown = { ...page, nextCursor };
      if (frame) { out(json ? JSON.stringify({ ...shown, framed: frameBusInbox(frame as BusCli, page.messages) }) : frameBusInbox(frame as BusCli, page.messages)); return 0; }
      out(json ? JSON.stringify(shown) : [
        ...shown.messages.map(m => `${m.cursor} ${m.priority} ${m.kind === 'channel' ? `#${m.channel}` : m.kind} ${m.envelope.id} from ${m.fromAgent ?? m.envelope.from}` +
          (m.held === undefined ? '' : ` held=${m.held === null ? 'unknown' : m.held ? 'yes' : 'no'}` +
            (m.holder ? ` holder=${m.holder}` : '')) +
          (m.job === undefined ? '' : ` ${busInboxJobMarker(m.job)}`)),
        ...(page.matched === undefined ? [] : [`matched ${page.matched}`]),
        `nextCursor ${nextCursor}`,
      ].join('\n'));
      return 0;
    }
    if (verb === 'show') {
      noExtra(2);
      if (sub === undefined) throw new UsageError('A message id is required.');
      const result = readBusEnvelopeById(sub, options);
      if (result.status !== 'ok') {
        if (result.status === 'not-found') {
          out(json ? JSON.stringify(result) : `not-found: ${result.id}`);
          return 1;
        }
        return finish(result, '');
      }
      const m = result.message;
      out(json ? JSON.stringify(result) : [
        `${m.cursor} ${m.envelope.priority} ${m.envelope.id} from ${m.fromAgent ?? m.envelope.from} -> ${m.envelope.to}`,
        `  ${busBodyFallbackSummary(m.envelope.body)}`,
        ...(result.held === undefined ? [] : [`  held=${result.held === null ? 'unknown' : result.held ? 'yes' : 'no'}` +
          (result.holder ? ` holder=${result.holder}` : '')]),
        ...(result.wakeHint === undefined ? [] : [`  via claim-holder wake hint ${result.id}` +
          ` to=${result.wakeHint.to} job=${result.wakeHint.jobId} status=${result.wakeHint.status}`]),
        ...(result.job === undefined ? [] : [showJobLine(result.job)]),
      ].join('\n'));
      return 0;
    }
    if (verb === 'wakes') {
      noExtra(2);
      const agent = sub ?? self;
      if (!agent) throw new UsageError('An agent or PHM_AGENT_ID is required.');
      const page = readAgentWakes(agent, integer(one('--since'), '--since'), options);
      if (page.status !== 'ok') return finish(page, '');
      out(json ? JSON.stringify(page) : [
        ...(page.truncated ? [`${page.matched} wake hint(s) matched; the bounded queue tail is truncated — showing the newest ${page.wakes.length}`] : []),
        ...page.wakes.map(w => `${w.at} ${w.id} ${w.from} -> ${w.to}` + agentWakeClaimHolderSuffix(w)),
      ].join('\n') || 'No wakes.');
      return 0;
    }
    if (verb === 'work' && sub === 'feed') {
      noExtra(2);
      const status = one('--status');
      if (status !== undefined && !(WORK_STATUSES as readonly string[]).includes(status)) {
        throw new UsageError(`--status must be one of ${WORK_STATUSES.join(', ')}.`);
      }
      const labelArg = (flag: string): string | undefined => {
        const value = one(flag);
        if (value !== undefined && !/^[\x21-\x7e]{1,128}(?![\s\S])/.test(value)) {
          throw new UsageError(`${flag} must be a printable routing label of 1-128 characters.`);
        }
        return value;
      };
      const to = labelArg('--to'), owner = labelArg('--owner'), jobId = labelArg('--job');
      const result = projectBusWorkFeedView(
        readBusWorkFeed({ root: options.root, claims: p.bools.has('--claims') }),
        { status: status as WorkJob['status'] | undefined, jobId,
          toMatch: to === undefined ? undefined : busWorkFeedToMatcher(to, { root: options.root }),
          ownerMatch: owner === undefined ? undefined : busWorkFeedOwnerMatcher(owner, { root: options.root }) });
      out(json ? JSON.stringify(result) : formatBusWorkFeed(result).join('\n'));
      return result.status === 'ok' ? 0 : 1;
    }
    if (verb === 'work' && sub === 'claim') {
      noExtra(2);
      const owner = one('--owner') ?? self;
      if (!owner) throw new UsageError('--owner is required when PHM_AGENT_ID is not set.');
      const leaseMs = integer(one('--lease-ms'), '--lease-ms');
      if (leaseMs === undefined) throw new UsageError('--lease-ms is required.');
      const key = one('--key');
      if (key !== undefined && parseClaimKey(key) === undefined) {
        throw new UsageError('--key must be a v2 claim key (repo:, path:, queue: or pr:).');
      }
      const opId = one('--id');
      const result = claimBusWorkJob({ job: required('--job'), owner, leaseMs, root: options.root,
        ...(key === undefined ? {} : { key }), ...(opId === undefined ? {} : { id: opId }) });
      out(json ? JSON.stringify(result) : workJobClaimHuman(result));
      return workJobClaimExitCode(result);
    }
    if (verb === 'work' && sub === 'mine') {
      noExtra(3);
      const agent = arg ?? self;
      if (!agent) throw new UsageError('An agent or PHM_AGENT_ID is required.');
      const result = readBusWorkMine(agent, options);
      if (result.status !== 'ok') {
        out(json ? JSON.stringify(result) : `${result.status}: ${result.reason}`);
        return 2;
      }
      out(json ? JSON.stringify(result) : formatBusWorkMine(result).join('\n'));
      return 0;
    }
    if (verb === 'work' && (sub === 'post' || sub === 'status')) {
      noExtra(2);
      const from = actor('--from');
      const routed = { ...send, from, to: one('--to') };
      if (sub === 'post') {
        const tier = one('--tier'), scope = one('--scope'), acceptance = one('--acceptance');
        if ([tier, scope, acceptance].some(value => value !== undefined) &&
            [tier, scope, acceptance].some(value => value === undefined)) {
          throw new UsageError('--tier, --scope and --acceptance are required together.');
        }
        if (tier !== undefined && !['fast', 'mid', 'work', 'frontier'].includes(tier)) {
          throw new UsageError('--tier must be fast, mid, work or frontier.');
        }
        const result = await announceWork({ ...routed, jobId: required('--job'), title: required('--title'),
          repo: required('--repo'), claimKeys: p.values.get('--claim') ?? [],
          provider: one('--provider') as BusProvider | undefined,
          dispatch: tier === undefined ? undefined : { tier: tier as 'fast' | 'mid' | 'work' | 'frontier',
            scope: scope!, acceptance: acceptance! } }, options);
        return finish(result, 'id' in result ? `${result.status}: ${result.id} -> ${result.to} (wake ${result.wake})` : '');
      }
      const status = required('--status');
      if (!(WORK_STATUSES as readonly string[]).includes(status)) {
        throw new UsageError(`--status must be one of ${WORK_STATUSES.join(', ')}.`);
      }
      const result = await updateWorkStatus({ ...routed, jobId: required('--job'),
        status: status as WorkStatusInput['status'], detail: one('--detail') }, options);
      const holders = 'id' in result ? result.claimHoldersWoken : undefined;
      const holderNote = holders === undefined ? '' :
        ` claim-holders=${holders === null ? 'unknown' : holders}`;
      return finish(result, 'id' in result ?
        `${result.status}: ${result.id} -> ${result.to} (wake ${result.wake})${holderNote}` : '');
    }
    if (verb === 'claim') {
      noExtra(2);
      if (sub === 'list') {
        const result = listBusClaims({ root: options.root, key: one('--key'), owner: one('--owner'), jobs: p.bools.has('--jobs') });
        if (result.status === 'invalid') {
          out(json ? JSON.stringify(result) : 'invalid: --key must be a v2 claim key (repo:, path:, queue: or pr:); --owner must be a printable label');
          return 2;
        }
        if (result.status !== 'ok') {
          out(json ? JSON.stringify(result) : `${result.status} claims=unknown as-of=${result.asOf}`);
          return 1;
        }
        const ownerNote = result.owner === undefined ? '' :
          ` owner=${result.owner.ref} identity=${result.owner.identity ?? 'label'} registry=${result.owner.registry}`;
        const feedNote = result.feed === undefined ? '' : ` feed=${result.feed}`;
        out(json ? JSON.stringify(result) : [
          ...result.claims.map(row => {
            const base = `${row.key} owner=${row.owner} origin=${row.origin} until=${new Date(row.leaseUntil).toISOString()} source=${row.sourceId}`;
            if (result.feed === undefined) return base;
            if (result.feed !== 'ok') return `${base} jobs=unknown`;
            const blocked = row.jobs ?? [];
            return `${base} jobs=${blocked.length === 0 ? 'none' : blocked.map(claimJobLabel).join(',')}`;
          }),
          `claims=${result.claims.length} source=${result.source}${ownerNote}${feedNote} as-of=${result.asOf}`,
        ].join('\n'));
        return 0;
      }
      const claimKey = required('--key');
      const leaseMsRaw = one('--lease-ms');
      const leaseMs = leaseMsRaw === undefined ? undefined : integer(leaseMsRaw, '--lease-ms');
      let body: Record<string, unknown>;
      if (sub === 'acquire') {
        const owner = one('--owner') ?? self;
        if (!owner) throw new UsageError('--owner is required when PHM_AGENT_ID is not set.');
        if (leaseMs === undefined) throw new UsageError('--lease-ms is required.');
        body = { kind: 'work.claim', op: 'acquire', claimKey, owner, leaseMs };
      } else if (sub === 'renew') {
        if (leaseMs === undefined) throw new UsageError('--lease-ms is required.');
        body = { kind: 'work.claim', op: 'renew', claimKey, token: required('--token'), leaseMs };
      } else if (sub === 'release') {
        body = { kind: 'work.release', claimKey, token: required('--token'), outcome: required('--outcome') };
      } else {
        throw new UsageError('claim requires acquire, renew, release or list.');
      }
      const result: BusClaimResult = executeBusClaimBody(body, one('--id') ?? newBusClaimOpId(), { root: options.root })
        ?? { v: 2, status: 'invalid' };
      out(json ? JSON.stringify(result) : claimHuman(result));
      return busClaimExitCode(result);
    }
    throw new UsageError('Unknown agents bus command.');
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    err(json ? JSON.stringify({ error: 'invalid-argument', reason: error.message }) : `${error.message}\n${AGENTS_BUS_UNIFIED_HELP}`);
    return 2;
  }
}
