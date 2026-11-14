import { isSlackTs } from '../core/agents/slack-network.js';
import { readSlackRequestTrace, type SlackRequestTraceOptions } from '../core/agents/slack-request-trace.js';

const usage = 'Usage: ashlr fleet slack-trace [--thread <ts>] [--json]';

/**
 * Read-only per-request trace: ingress receipt to same-thread reply outcome.
 * Exit 0 only when every traced request is answered and neither source is
 * degraded; ids and timestamps only, never text, author ids or paths.
 */
export async function cmdFleetSlackTrace(args: string[], deps: SlackRequestTraceOptions = {}): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) {
    console.log(`${usage}\nTrace each ingested Slack request from its journal receipt to its reply outcome.`);
    return 0;
  }
  let json = false;
  let thread: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') {
      json = true;
    } else if (arg === '--thread') {
      const value = args[++i];
      if (!isSlackTs(value)) {
        console.error(usage);
        return 2;
      }
      thread = value;
    } else {
      console.error(usage);
      return 2;
    }
  }
  const trace = readSlackRequestTrace({ ...deps, ...(thread !== undefined ? { thread } : {}) });
  if (json) {
    console.log(JSON.stringify(trace));
  } else {
    console.log(`slack trace as of ${trace.asOf} (journal=${trace.sources.journal} sends=${trace.sources.sends})`);
    for (const row of trace.rows) {
      console.log(`${row.at} ${row.channelId} thread=${row.threadTs} msg=${row.messageTs} ingress=${row.ingress} -> ` +
        `${row.outcome.toUpperCase()}${row.replyTs !== undefined ? ` reply=${row.replyTs}` : ''}`);
    }
  }
  const clean = trace.sources.journal !== 'degraded' && trace.sources.sends !== 'degraded';
  return clean && trace.rows.every((row) => row.outcome === 'answered') ? 0 : 1;
}
