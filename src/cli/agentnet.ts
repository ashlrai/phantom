import { readPeerInbox, sendPeerMessage, type PeerBusOptions } from '../core/agentnet/peer-bus.js';
import { listPeers, proposeSlackAction, type PeerSession } from '../core/agentnet/slack-identities.js';
const usage = 'phm agentnet peers list|read|send <to|#channel-id> <task|review|handoff|query|social> <text> [--reply-to <id>] [--thread <id>] [--json]\nphm agentnet channels propose <name> [--apply] [--json]\nphm agentnet identity register <callsign> [--json]';
export async function cmdAgentnet(args: string[], options: PeerBusOptions = {}, session: PeerSession = {
  lane: process.env.PHM_AGENTNET_LANE ?? '', sessionId: process.env.PHM_AGENTNET_SESSION_ID ?? '', token: process.env.PHM_AGENTNET_SESSION_TOKEN ?? '',
}): Promise<number> {
  if (!args.length || args.includes('--help')) { console.log(usage); return 0; }
  const positional: string[] = []; let after: number | undefined; let apply = false, replyTo: string | undefined, threadId: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') continue;
    if (arg === '--after' && after === undefined) { const value = args[++i]; after = Number(value); if (!value || !/^\d+$/.test(value) || !Number.isSafeInteger(after)) return 2; continue; }
    if (arg === '--apply' && !apply) { apply = true; continue; }
    if ((arg === '--reply-to' && replyTo === undefined) || (arg === '--thread' && threadId === undefined)) {
      const value = args[++i];
      if (!value || value.startsWith('-')) return 2;
      if (arg === '--reply-to') replyTo = value; else threadId = value;
    } else if (arg.startsWith('-')) return 2;
    else positional.push(arg);
  }
  const [group, verb, name, kind, text] = positional;
  try {
    let result: unknown;
    if (group === 'peers' && verb === 'read' && positional.length === 2 && !apply && !replyTo && !threadId) result = readPeerInbox(session, after ?? 0, options);
    else if (after !== undefined) return 2;
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
