/** Thin argv adapter for the unified agent bus (src/core/agents/bus-unified.ts). Exit 0 ok, 1 refused, 2 usage. */
import { isAbsolute } from 'node:path';
import {
  BUS_CLIS, createAgentChannel, joinAgentChannel, leaveAgentChannel, readAgentRegistry, registerAgentIdentity,
  type BusCli, type BusProvider,
} from '../core/agents/bus-identity.js';
import {
  announceWork, listBusChannels, postChannelMessage, readAgentChannel, readAgentInbox, readAgentWakes, sendDirectMessage,
  sendHandoff, sendWakeRequest, updateWorkStatus, type UnifiedBusOptions, type WorkStatusInput,
} from '../core/agents/bus-unified.js';
import { WORK_STATUSES, parseClaimKey, type WorkJob } from '../core/agents/bus-v2-schema.js';
import { busWorkFeedToMatcher, formatBusWorkFeed, projectBusWorkFeedView, readBusWorkFeed } from '../core/agents/bus-work-feed-read.js';
import { attachBusCliSession, detectBusCli, frameBusInbox, listBusCliAdapters } from '../core/agents/bus-cli-adapters.js';
import { busClaimExitCode, claimBusWorkJob, executeBusClaimBody, listBusClaims, newBusClaimOpId,
  type BusClaimResult, type BusClaimJobRef, type BusWorkJobClaimResult } from '../core/agents/bus-claims.js';
import { formatBusWorkMine, readBusWorkMine } from '../core/agents/bus-work-mine.js';
import { readUnifiedBusStatus } from '../core/agents/bus-status.js';
import { scrubSecrets } from '../core/util/scrub.js';
import type { BusPriority } from '../core/fleet/bus-envelope.js';
import { seatParticipants } from '../core/bots/seats.js';

export const AGENTS_BUS_UNIFIED_VERBS = new Set(['id', 'dm', 'channel', 'handoff', 'wake', 'inbox', 'wakes', 'adapters', 'claim', 'work', 'status']);

export const AGENTS_BUS_UNIFIED_HELP = `ashlr agents bus id register [<handle>] [--cli <cli>] [--provider <p>] [--model <m>] [--alias <label>]... [--display <name>]
ashlr agents bus id list
ashlr agents bus dm --to <agent> --text <text> [--from <agent>] [--priority P0..P3] [--thread <t>] [--ref <ref>]... [--id <id>] [--ttl <ms>] [--wake|--no-wake]
ashlr agents bus channel create <name> [--from <agent>] [--member <agent>]...
ashlr agents bus channel join|leave <name> [--agent <agent>]
ashlr agents bus channel post <name> --text <text> [--from <agent>] [--topic <t>] [--ref <ref>]... [--priority ..] [--wake|--no-wake]
ashlr agents bus channel list [--agent <agent>]
ashlr agents bus channel read <name> [--topic <t>] [--from <agent>] [--thread <t>] [--after <cursor>] [--limit <1..100>]
ashlr agents bus handoff --to <agent> --task <job id> --prompt <text> [--from <agent>] [--priority ..] [--no-wake]
ashlr agents bus wake --to <agent> --reason <text> [--job <id>] [--from <agent>] [--priority P0..P3] [--id <id>] [--ttl <ms>]
ashlr agents bus inbox [<agent>] [--after <cursor>] [--limit <1..100>] [--thread <t>] [--from <agent>] [--frame <cli>]
ashlr agents bus wakes [<agent>] [--since <epoch ms>]
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
ashlr agents bus work feed [--status <${WORK_STATUSES.join('|')}>] [--to <label>] [--claims]
ashlr agents bus work claim --job <id> --lease-ms <1..3600000> [--key <claimKey>] [--owner <label>] [--id <opId>]
ashlr agents bus work mine [<agent>]
ashlr agents bus status
Common: [--root <abs>] [--json]. <agent> is a handle, agent:<handle>, agt_ id or alias;
--from, --agent and a missing <agent> default to PHM_AGENT_ID. Identities are routing
names, never authentication. Messages land in the one local bus store; P0 always
wakes, P1 and handoffs wake by default, and wake always records its hint.
--thread on dm, channel post, inbox and channel read is the v2 conversation
label carried by note/context bodies; reads match that field only. --from on
inbox and channel read narrows to one sender — a handle, agent:<handle>,
stable id or alias; an unresolvable ref keeps exact-label matching.
A terminal work status also queues a routing-only wake hint for each live claim
holder on the job's keys; --no-wake opts out. work feed and claim list are
read-only and need no identity; work feed --to keeps jobs announced to that
routing label under every label of one agent identity. work claim takes one of
a shown job's declared claim keys — queue:<jobId> preferred, --key picks
another declared key — into the shared coordination table; claims coordinate,
never authenticate. work mine is a read-only per-agent digest — the live
claims it holds under any of its labels, the open feed jobs still claimable
for it, the claimable work envelopes addressed to it in bus-next order with
their hold state, its pending wake hints and the next page of mail addressed
to it — where every section reports its own read state and unknown stays
unknown.
status is a read-only
probe of the store, registry, wake queue, coordination table and work feed;
a section that cannot be read reports unavailable or unknown, never zero.
No network, no engine runs. Spec: docs/AGENT-BUS.md.`;

const VALUE_FLAGS = new Set(['--from', '--to', '--text', '--priority', '--thread', '--id', '--ttl', '--cli', '--provider',
  '--model', '--alias', '--display', '--member', '--agent', '--topic', '--task', '--prompt', '--after', '--limit',
  '--frame', '--since', '--root', '--key', '--owner', '--lease-ms', '--token', '--outcome', '--reason',
  '--job', '--title', '--repo', '--claim', '--tier', '--scope', '--acceptance', '--status', '--detail', '--ref']);
const MULTI = new Set(['--alias', '--member', '--claim', '--ref']);
const BOOL_FLAGS = new Set(['--json', '--wake', '--no-wake', '--claims', '--jobs']);

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

/** `RQ-1(running) "Fix the feed"` — the blocked job named by its announcement title, display-clipped. */
function claimJobLabel(job: BusClaimJobRef): string {
  // eslint-disable-next-line no-control-regex
  const title = scrubSecrets(job.title).replace(/[\u0000-\u001f\u007f-\u009f]+/g, ' ').replace(/\s+/g, ' ').trim();
  const clipped = title.length > 80 ? `${title.slice(0, 79)}…` : title;
  return `${job.id}(${job.status})${clipped === '' ? '' : ` "${clipped}"`}`;
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
function workJobClaimHuman(result: BusWorkJobClaimResult): string {
  if (result.status === 'acquired') {
    return `acquired ${result.claim.claimKey} for ${claimJobLabel(result.job)} owner=${result.claim.owner} ` +
      `leaseUntil=${new Date(result.claim.leaseUntil).toISOString()} token=${result.claim.token}`;
  }
  if (result.status === 'conflict') {
    return `conflict ${result.holder.claimKey} for ${claimJobLabel(result.job)} held by ${result.holder.owner} ` +
      `until ${new Date(result.holder.leaseUntil).toISOString()}`;
  }
  return `${result.status}: ${result.reason}${result.job === undefined ? '' : ` (${claimJobLabel(result.job)})`}`;
}

/** work claim exit codes mirror claim acquire: acquired 0, invalid 2, every other refusal 1. */
function workJobClaimExitCode(result: BusWorkJobClaimResult): number {
  return result.status === 'acquired' ? 0 : result.status === 'invalid' ? 2 : 1;
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
        `wakes ${result.wakes.state} hints=${result.wakes.hints ?? unknown}`,
        `coordination ${result.coordination.source} liveClaims=${result.coordination.liveClaims ?? unknown} statuses=${result.coordination.statuses ?? unknown}`,
        `feed ${result.feed.status}${result.feed.reason === undefined ? '' : `:${result.feed.reason}`} jobs=${result.feed.jobs ?? unknown}`,
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
          after: integer(one('--after'), '--after'), limit: integer(one('--limit'), '--limit') }, options);
        if (result.status !== 'ok') return finish(result, '');
        out(json ? JSON.stringify(result) : [
          ...result.messages.map(m => `${m.cursor} ${m.priority} #${result.channel}:${m.topic} ${m.envelope.id} from ${m.fromAgent ?? m.envelope.from}`),
          `nextCursor ${result.nextCursor}`,
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
        thread: one('--thread'), from: one('--from') }, options);
      if (page.status !== 'ok') return finish(page, '');
      if (frame) { out(json ? JSON.stringify({ ...page, framed: frameBusInbox(frame as BusCli, page.messages) }) : frameBusInbox(frame as BusCli, page.messages)); return 0; }
      out(json ? JSON.stringify(page) : [
        ...page.messages.map(m => `${m.cursor} ${m.priority} ${m.kind === 'channel' ? `#${m.channel}` : m.kind} ${m.envelope.id} from ${m.fromAgent ?? m.envelope.from}`),
        `nextCursor ${page.nextCursor}`,
      ].join('\n'));
      return 0;
    }
    if (verb === 'wakes') {
      noExtra(2);
      const agent = sub ?? self;
      if (!agent) throw new UsageError('An agent or PHM_AGENT_ID is required.');
      const page = readAgentWakes(agent, integer(one('--since'), '--since'), options);
      if (page.status !== 'ok') return finish(page, '');
      out(json ? JSON.stringify(page) : page.wakes.map(w => `${w.at} ${w.id} ${w.from} -> ${w.to}`).join('\n') || 'No wakes.');
      return 0;
    }
    if (verb === 'work' && sub === 'feed') {
      noExtra(2);
      const status = one('--status');
      if (status !== undefined && !(WORK_STATUSES as readonly string[]).includes(status)) {
        throw new UsageError(`--status must be one of ${WORK_STATUSES.join(', ')}.`);
      }
      const to = one('--to');
      if (to !== undefined && !/^[\x21-\x7e]{1,128}(?![\s\S])/.test(to)) {
        throw new UsageError('--to must be a printable routing label of 1-128 characters.');
      }
      const toMatch = to === undefined ? undefined : busWorkFeedToMatcher(to, { root: options.root });
      const result = projectBusWorkFeedView(
        readBusWorkFeed({ root: options.root, claims: p.bools.has('--claims') }),
        status as WorkJob['status'] | undefined, toMatch);
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
