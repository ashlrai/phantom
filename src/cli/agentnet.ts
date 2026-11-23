import { readPeerInbox, sendPeerMessage, type PeerBusOptions, type PeerInboxFilter } from '../core/agentnet/peer-bus.js';
import { listPeers, proposeSlackAction, type PeerSession } from '../core/agentnet/slack-identities.js';
import { consumePeerWork } from '../core/agentnet/work-dispatch.js';
import { readEnvironmentCredential } from '../core/integrations/secrets.js';
import { readPeerFleet } from '../core/agentnet/mesh-read.js';
import { parseSince } from '../core/fleet/agent-messages.js';
import { BUS_PRIORITIES, type BusPriority } from '../core/fleet/bus-envelope.js';
const usage = 'phm agentnet peers mesh|work-feed [--json]\nphm agentnet peers read [--after <cursor>] [--since <t>] [--before <t>] [--contains <text>] [--priority P0..P3] [--job <id>] [--json]\nphm agentnet peers list [--json]\nphm agentnet peers send <to|#channel-id> <task|review|handoff|query|social> <text> [--reply-to <id>] [--thread <id>] [--json]\nphm agentnet peers post <to> <work-json> [--json]\nphm agentnet peers dispatch [--after <cursor>] [--apply] [--json]\nphm agentnet channels propose <name> [--apply] [--json]\nphm agentnet identity register <callsign> [--json]';
export async function cmdAgentnet(args: string[], options: PeerBusOptions = {}, session: PeerSession = {
  lane: process.env.PHM_AGENTNET_LANE ?? '', sessionId: process.env.PHM_AGENTNET_SESSION_ID ?? '', token: readEnvironmentCredential('PHM_AGENTNET_SESSION_TOKEN') ?? '',
}): Promise<number> {
  if (!args.length || args.includes('--help') || args.includes('-h')) { console.log(usage); return 0; }
  const positional: string[] = [];
  let after: number | undefined; let apply = false, replyTo: string | undefined, threadId: string | undefined;
  const filterArgs: Partial<Record<'since' | 'before' | 'contains' | 'priority' | 'job', string>> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') continue;
    if (arg === '--after' && after === undefined) { const value = args[++i]; after = Number(value); if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(after)) return 2; continue; }
    if (arg === '--apply' && !apply) { apply = true; continue; }
    const flag = arg === '--since' ? 'since' : arg === '--before' ? 'before' : arg === '--contains' ? 'contains'
      : arg === '--priority' ? 'priority' : arg === '--job' ? 'job' : undefined;
    if (flag !== undefined && filterArgs[flag] === undefined) {
      const value = args[++i];
      if (!value || value.startsWith('-')) return 2;
      filterArgs[flag] = value; continue;
    }
    if ((arg === '--reply-to' && replyTo === undefined) || (arg === '--thread' && threadId === undefined)) {
      const value = args[++i];
      if (!value || value.startsWith('-')) return 2;
      if (arg === '--reply-to') replyTo = value; else threadId = value;
    } else if (arg.startsWith('-')) return 2;
    else positional.push(arg);
  }
  const [group, verb, name, kind, text] = positional;
  const hasFilter = filterArgs.since !== undefined || filterArgs.before !== undefined || filterArgs.contains !== undefined ||
    filterArgs.priority !== undefined || filterArgs.job !== undefined;
  if (hasFilter && !(group === 'peers' && verb === 'read')) return 2;
  try {
    let result: unknown;
    if (group === 'peers' && verb === 'read' && positional.length === 2 && !apply && !replyTo && !threadId) {
      const now = (options.now ?? Date.now)();
      const since = filterArgs.since === undefined ? undefined : parseSince(filterArgs.since, now);
      const before = filterArgs.before === undefined ? undefined : parseSince(filterArgs.before, now);
      if ((filterArgs.since !== undefined && since === null) || (filterArgs.before !== undefined && before === null)) return 2;
      const priority = filterArgs.priority as BusPriority | undefined;
      if (priority !== undefined && !BUS_PRIORITIES.includes(priority)) return 2;
      const filter: PeerInboxFilter = {
        ...(since === undefined || since === null ? {} : { since }),
        ...(before === undefined || before === null ? {} : { before }),
        ...(filterArgs.contains === undefined ? {} : { contains: filterArgs.contains }),
        ...(priority === undefined ? {} : { priority }),
        ...(filterArgs.job === undefined ? {} : { job: filterArgs.job }),
      };
      result = readPeerInbox(session, after ?? 0, options, filter);
    }
    else if (group === 'peers' && verb === 'dispatch' && positional.length === 2 && !replyTo && !threadId) result = await consumePeerWork(session, { apply, after }, options);
    else if (after !== undefined) return 2;
    else if (group === 'peers' && (verb === 'mesh' || verb === 'work-feed') && positional.length === 2 && !apply && !replyTo && !threadId) {
      result = readPeerFleet(verb, session, options);
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
