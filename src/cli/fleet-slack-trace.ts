import { isSlackChannelId, isSlackTs } from '../core/agents/slack-network.js';
import { readSlackRequestTrace, type SlackRequestTraceOptions } from '../core/agents/slack-request-trace.js';

const usage = 'Usage: ashlr fleet slack-trace [--thread <ts>] [--channel <Slack channel id>] [--message <ts>] [--json]';

/**
 * Read-only per-request trace: ingress receipt to same-thread reply outcome.
 * Exit 0 requires both sources ok, at least one request, and every row both
 * `answered` and carrying durable bus ingress evidence (`ingress !== 'unknown'`,
 * the same join fleet slack-evidence enforces). `answered` is reply transport
 * evidence only; it never proves RUNNING/VERIFIED task execution. Output is
 * ids and timestamps only, never text, author ids or paths.
 */
export async function cmdFleetSlackTrace(args: string[], deps: SlackRequestTraceOptions = {}): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`${usage}\nTrace each ingested Slack request from its journal receipt to its reply outcome.`);
    return 0;
  }
  let json = false;
  let thread: string | undefined;
  let channelId: string | undefined;
  let message: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') {
      json = true;
    } else if (arg === '--thread') {
      const value = args[++i];
      if (thread !== undefined || !isSlackTs(value)) {
        console.error(usage);
        return 2;
      }
      thread = value;
    } else if (arg === '--channel') {
      const value = args[++i];
      if (channelId !== undefined || !isSlackChannelId(value)) {
        console.error(usage);
        return 2;
      }
      channelId = value;
    } else if (arg === '--message') {
      const value = args[++i];
      if (message !== undefined || !isSlackTs(value)) {
        console.error(usage);
        return 2;
      }
      message = value;
    } else {
      console.error(usage);
      return 2;
    }
  }
  if (message !== undefined && (thread === undefined || channelId === undefined)) {
    console.error(usage);
    return 2;
  }
  const collected = readSlackRequestTrace({ ...deps, ...(thread !== undefined ? { thread } : {}) });
  const rows = collected.rows.filter((row) =>
    (channelId === undefined || row.channelId === channelId) && (message === undefined || row.messageTs === message));
  const counts = { total: rows.length, answered: 0, uncertain: 0, busFailed: 0, unanswered: 0 };
  for (const row of rows) {
    if (row.outcome === 'answered') counts.answered++;
    else if (row.outcome === 'uncertain') counts.uncertain++;
    else if (row.outcome === 'bus-failed') counts.busFailed++;
    else counts.unanswered++;
  }
  const selectedThread = thread ?? deps.thread;
  const scope = 'Bounded local persisted journal and send evidence only; does not prove current runtime reachability.';
  const trace = {
    ...collected, rows, counts, scope,
    collectionScope: {
      ...(selectedThread !== undefined ? { thread: selectedThread } : {}),
      ...(channelId !== undefined ? { channelId } : {}),
      ...(message !== undefined ? { messageTs: message } : {}),
    },
  };
  if (json) {
    console.log(JSON.stringify(trace));
  } else {
    console.log(`slack trace as of ${trace.asOf} (journal=${trace.sources.journal} sends=${trace.sources.sends}) ` +
      `scope: channel=${channelId ?? 'all'} thread=${selectedThread ?? 'all'}` +
      `${message !== undefined ? ` message=${message}` : ''}; ${scope}`);
    if (trace.rows.length === 0) console.log('No matching request evidence; verification unsuccessful.');
    for (const row of trace.rows) {
      console.log(`${row.at} ${row.channelId} thread=${row.threadTs} msg=${row.messageTs} ingress=${row.ingress} -> ` +
        `${row.outcome.toUpperCase()}${row.replyTs !== undefined ? ` reply=${row.replyTs}` : ''}`);
    }
  }
  const clean = trace.sources.journal === 'ok' && trace.sources.sends === 'ok';
  // An answered row whose ingress is unknown has reply evidence but no bus receipt for the request itself; refuse it.
  return clean && trace.rows.length > 0 &&
    trace.rows.every((row) => row.outcome === 'answered' && row.ingress !== 'unknown') ? 0 : 1;
}
