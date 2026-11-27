import { readPeerInbox, sendPeerMessage, type PeerBusOptions } from '../core/agentnet/peer-bus.js';
import { peerInboxMessageMatches, parsePeerInboxFilters } from '../core/agentnet/peer-inbox.js';
import { agentnetPaths, listPeers, proposeSlackAction, type PeerSession } from '../core/agentnet/slack-identities.js';
import { consumePeerWork } from '../core/agentnet/work-dispatch.js';
import { readEnvironmentCredential } from '../core/integrations/secrets.js';
import { readPeerFleet } from '../core/agentnet/mesh-read.js';
import { parseBusWorkFeedQuery, type BusWorkFeedQueryInput } from '../core/agents/bus-work-feed-query.js';
import { BUS_WORK_FEED_LIMIT_MAX } from '../core/agents/bus-work-feed-read.js';
import { PROVIDERS, WORK_RESULT_OUTCOMES, WORK_STATUSES, WORK_TIERS } from '../core/agents/bus-v2-schema.js';
const usage = `phm agentnet peers mesh [--json]
phm agentnet peers work-feed [--claims] [--open] [--claimable] [--status <${WORK_STATUSES.join('|')}>] [--job <id>] [--repo <owner/name>] [--provider <${PROVIDERS.join('|')}>] [--tier <${WORK_TIERS.join('|')}>] [--to <label>] [--owner <agent>] [--channel <name>] [--topic <topic>] [--result <${WORK_RESULT_OUTCOMES.join('|')}>] [--id <envelope-id>] [--since <15m|2h|1d|ISO>] [--before <15m|2h|1d|ISO>] [--contains <text>] [--limit <1-${BUS_WORK_FEED_LIMIT_MAX}>] [--json]
phm agentnet peers list [--json]
phm agentnet peers read [--after <cursor>] [--from <callsign>] [--exclude-from <callsign>] [--to <label>] [--since <15m|2h|1d|ISO|epoch>] [--before <when>] [--contains <text>] [--id <id>] [--kind <kind>] [--body-kind <kind>] [--priority P0..P3] [--peer-kind <task|review|handoff|query|social>] [--thread <id>] [--job <id>] [--result <reserved|admitted|complete|failed>] [--json]
phm agentnet peers send <to|#channel-id> <task|review|handoff|query|social> <text> [--reply-to <id>] [--thread <id>] [--json]
phm agentnet peers post <to> <work-json> [--json]
phm agentnet peers dispatch [--after <cursor>] [--apply] [--json]
phm agentnet channels propose <name> [--apply] [--json]
phm agentnet identity register <callsign> [--json]`;
/** The flags only `peers read` accepts; every other verb refuses them. */
const READ_FILTER_FLAGS = new Set(['--from', '--exclude-from', '--to', '--since', '--before', '--contains', '--id', '--kind', '--body-kind', '--priority', '--peer-kind', '--job', '--result']);
/** The value flags only `peers work-feed` accepts beyond the read-filter names it shares (`--to`, `--since`, `--before`, `--contains`, `--id`, `--job`, `--result`); every other verb refuses them. */
const FEED_VALUE_FLAGS = new Set(['--status', '--repo', '--provider', '--tier', '--owner', '--channel', '--topic', '--limit']);
/** The read-only filter names `peers work-feed` refuses — its query has no sender, kind or thread dimension. */
const FEED_READ_ONLY_FLAGS = ['--from', '--exclude-from', '--kind', '--body-kind', '--priority', '--peer-kind'] as const;
/** Every flag name `peers work-feed` consumes; each maps to the same-named `parseBusWorkFeedQuery` key. */
const FEED_QUERY_KEYS = ['status', 'job', 'repo', 'provider', 'tier', 'to', 'owner',
  'since', 'before', 'contains', 'channel', 'topic', 'result', 'id', 'limit'] as const;
export async function cmdAgentnet(args: string[], options: PeerBusOptions = {}, session: PeerSession = {
  lane: process.env.PHM_AGENTNET_LANE ?? '', sessionId: process.env.PHM_AGENTNET_SESSION_ID ?? '', token: readEnvironmentCredential('PHM_AGENTNET_SESSION_TOKEN') ?? '',
}): Promise<number> {
  if (!args.length || args.includes('--help') || args.includes('-h')) { console.log(usage); return 0; }
  const positional: string[] = []; let after: number | undefined; let apply = false, replyTo: string | undefined, threadId: string | undefined;
  let feedClaims = false, feedOpen = false, feedClaimable = false;
  const readFilters: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') continue;
    if (arg === '--after' && after === undefined) { const value = args[++i]; after = Number(value); if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(after)) return 2; continue; }
    if (arg === '--apply' && !apply) { apply = true; continue; }
    if (arg === '--claims' && !feedClaims) { feedClaims = true; continue; }
    if (arg === '--open' && !feedOpen) { feedOpen = true; continue; }
    if (arg === '--claimable' && !feedClaimable) { feedClaimable = true; continue; }
    if ((arg === '--reply-to' && replyTo === undefined) || (arg === '--thread' && threadId === undefined)) {
      const value = args[++i];
      if (!value || value.startsWith('-')) return 2;
      if (arg === '--reply-to') replyTo = value; else threadId = value;
      continue;
    }
    if ((READ_FILTER_FLAGS.has(arg) || FEED_VALUE_FLAGS.has(arg)) && readFilters[arg] === undefined) {
      const value = args[++i];
      if (value === undefined || value.startsWith('-')) return 2;
      readFilters[arg] = value;
      continue;
    }
    if (arg.startsWith('-')) return 2;
    positional.push(arg);
  }
  const [group, verb, name, kind, text] = positional;
  const hasReadFilters = Object.keys(readFilters).length > 0;
  const hasFeedFlags = feedClaims || feedOpen || feedClaimable ||
    [...FEED_VALUE_FLAGS].some(flag => readFilters[flag] !== undefined);
  try {
    let result: unknown;
    if (group === 'peers' && verb === 'read') {
      // --thread doubles as the read's thread filter; --reply-to stays send-only.
      if (positional.length !== 2 || apply || replyTo || hasFeedFlags) { console.error(usage); return 2; }
      const query = parsePeerInboxFilters({
        from: readFilters['--from'], excludeFrom: readFilters['--exclude-from'], to: readFilters['--to'],
        since: readFilters['--since'], before: readFilters['--before'], contains: readFilters['--contains'],
        id: readFilters['--id'], kind: readFilters['--kind'], bodyKind: readFilters['--body-kind'],
        priority: readFilters['--priority'],
        peerKind: readFilters['--peer-kind'],
        thread: threadId, job: readFilters['--job'], result: readFilters['--result'],
      }, (options.now ?? Date.now)());
      if (!query.ok) return 2;
      const page = readPeerInbox(session, after ?? 0, options);
      result = page.status === 'ok'
        ? { ...page, messages: page.messages.filter(message => peerInboxMessageMatches(message, query.filters)) }
        : page;
    }
    else if (group === 'peers' && verb === 'work-feed') {
      // The same query phm fleet work-feed, phm agents bus work feed, the
      // work-feed HTTP route and fleet_work_feed validate — a peer's
      // filtered feed can never disagree with them about what a value means.
      if (positional.length !== 2 || apply || replyTo !== undefined || threadId !== undefined ||
          after !== undefined || FEED_READ_ONLY_FLAGS.some(flag => readFilters[flag] !== undefined)) {
        console.error(usage); return 2;
      }
      const input: BusWorkFeedQueryInput = {};
      for (const key of FEED_QUERY_KEYS) {
        const value = readFilters[`--${key}`];
        if (value !== undefined) input[key] = value;
      }
      if (feedClaims) input.claims = 'true';
      if (feedOpen) input.open = 'true';
      if (feedClaimable) input.claimable = 'true';
      const parsed = parseBusWorkFeedQuery(input,
        { root: { ...agentnetPaths(), ...options }.busRoot, now: (options.now ?? Date.now)() });
      if (!parsed.ok) { console.error(`phm agentnet: ${parsed.error}`); return 2; }
      result = readPeerFleet('work-feed', session, options, parsed);
    }
    else if (hasReadFilters || hasFeedFlags) return 2;
    else if (group === 'peers' && verb === 'dispatch' && positional.length === 2 && !replyTo && !threadId) result = await consumePeerWork(session, { apply, after }, options);
    else if (after !== undefined) return 2;
    else if (group === 'peers' && verb === 'mesh' && positional.length === 2 && !apply && !replyTo && !threadId) {
      result = readPeerFleet('mesh', session, options);
    }
    else if (group === 'peers' && verb === 'post' && positional.length === 4 && !apply && !replyTo && !threadId) {
      if (kind!.length > 8000) return 2;
      const body = JSON.parse(kind!);
      result = await sendPeerMessage({ toAgent: name, kind: 'task',
        text: body?.kind === 'work.status' ? 'Work status update' : 'Work feed proposal', work: body }, session, options);
    }
    else if (group === 'peers' && verb === 'send' && positional.length === 5 && !apply) {
      result = await sendPeerMessage({ ...(name!.startsWith('#') ? { channel: name!.slice(1) } : { toAgent: name }), kind, text,
        ...(replyTo ? { replyTo } : {}), ...(threadId ? { threadId } : {}) }, session, options);
    } else if (replyTo || threadId) return 2;
    else if (group === 'peers' && verb === 'list' && positional.length === 2 && !apply) result = listPeers(options.bindings);
    else if (group === 'channels' && verb === 'propose' && positional.length === 3) result = proposeSlackAction('channel.create', name!, apply);
    else if (group === 'identity' && verb === 'register' && positional.length === 3 && !apply) result = proposeSlackAction('identity.register', name!, true);
    else { console.error(usage); return 2; }
    console.log(JSON.stringify(result));
    const report = result as { status?: string; slack?: string };
    return (report.status && !['posted', 'drafted', 'escalated', 'ok', 'not-enrolled'].includes(report.status)) || ['refused', 'uncertain'].includes(report.slack ?? '') ? 1 : 0;
  } catch { console.log(JSON.stringify({ status: 'refused', reason: 'agentnet-unavailable' })); return 1; }
}
