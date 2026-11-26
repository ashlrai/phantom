import { readPeerInbox, sendPeerMessage, type PeerBusOptions } from '../core/agentnet/peer-bus.js';
import { peerInboxMessageMatches, parsePeerInboxFilters } from '../core/agentnet/peer-inbox.js';
import { listPeers, proposeSlackAction, type PeerSession } from '../core/agentnet/slack-identities.js';
import { consumePeerWork } from '../core/agentnet/work-dispatch.js';
import { readEnvironmentCredential } from '../core/integrations/secrets.js';
import { readPeerFleet } from '../core/agentnet/mesh-read.js';
const usage = 'phm agentnet peers mesh|work-feed [--json]\nphm agentnet peers list [--json]\nphm agentnet peers read [--after <cursor>] [--from <callsign>] [--exclude-from <callsign>] [--to <label>] [--since <15m|2h|1d|ISO|epoch>] [--before <when>] [--contains <text>] [--id <id>] [--kind <kind>] [--peer-kind <task|review|handoff|query|social>] [--thread <id>] [--job <id>] [--result <reserved|admitted|complete|failed>] [--json]\nphm agentnet peers send <to|#channel-id> <task|review|handoff|query|social> <text> [--reply-to <id>] [--thread <id>] [--json]\nphm agentnet peers post <to> <work-json> [--json]\nphm agentnet peers dispatch [--after <cursor>] [--apply] [--json]\nphm agentnet channels propose <name> [--apply] [--json]\nphm agentnet identity register <callsign> [--json]';
/** The flags only `peers read` accepts; every other verb refuses them. */
const READ_FILTER_FLAGS = new Set(['--from', '--exclude-from', '--to', '--since', '--before', '--contains', '--id', '--kind', '--peer-kind', '--job', '--result']);
export async function cmdAgentnet(args: string[], options: PeerBusOptions = {}, session: PeerSession = {
  lane: process.env.PHM_AGENTNET_LANE ?? '', sessionId: process.env.PHM_AGENTNET_SESSION_ID ?? '', token: readEnvironmentCredential('PHM_AGENTNET_SESSION_TOKEN') ?? '',
}): Promise<number> {
  if (!args.length || args.includes('--help') || args.includes('-h')) { console.log(usage); return 0; }
  const positional: string[] = []; let after: number | undefined; let apply = false, replyTo: string | undefined, threadId: string | undefined;
  const readFilters: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') continue;
    if (arg === '--after' && after === undefined) { const value = args[++i]; after = Number(value); if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(after)) return 2; continue; }
    if (arg === '--apply' && !apply) { apply = true; continue; }
    if ((arg === '--reply-to' && replyTo === undefined) || (arg === '--thread' && threadId === undefined)) {
      const value = args[++i];
      if (!value || value.startsWith('-')) return 2;
      if (arg === '--reply-to') replyTo = value; else threadId = value;
      continue;
    }
    if (READ_FILTER_FLAGS.has(arg) && readFilters[arg] === undefined) {
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
  try {
    let result: unknown;
    if (group === 'peers' && verb === 'read') {
      // --thread doubles as the read's thread filter; --reply-to stays send-only.
      if (positional.length !== 2 || apply || replyTo) { console.error(usage); return 2; }
      const query = parsePeerInboxFilters({
        from: readFilters['--from'], excludeFrom: readFilters['--exclude-from'], to: readFilters['--to'],
        since: readFilters['--since'], before: readFilters['--before'], contains: readFilters['--contains'],
        id: readFilters['--id'], kind: readFilters['--kind'], peerKind: readFilters['--peer-kind'],
        thread: threadId, job: readFilters['--job'], result: readFilters['--result'],
      }, (options.now ?? Date.now)());
      if (!query.ok) return 2;
      const page = readPeerInbox(session, after ?? 0, options);
      result = page.status === 'ok'
        ? { ...page, messages: page.messages.filter(message => peerInboxMessageMatches(message, query.filters)) }
        : page;
    }
    else if (hasReadFilters) return 2;
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
