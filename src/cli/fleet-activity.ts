/**
 * `ashlr fleet activity` — read-only per-job agent lifecycle view folded from
 * the host metrics ledger (metrics/jobs.jsonl): each job's newest stage
 * (queued/running/finished/published/merged/closed), boundary timestamps,
 * queue-wait/run/publish-lag seconds and a bounded event timeline — the
 * structured feed status surfaces render live agent activity from instead of
 * scraping worker logs. Never writes; a missing ledger reports `missing`,
 * not an error.
 */
import {
  agentActivityLines,
  readAgentActivity,
  type AgentActivityOptions,
} from '../core/fleet/agent-activity.js';

const usage = 'Usage: ashlr fleet activity [--json] [--hours <1..168>] [--limit <1..500>] [--jobs <path>]';

function parseArgs(args: string[]): { opts: AgentActivityOptions; json: boolean } | null {
  const opts: AgentActivityOptions = {};
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') json = true;
    else if (arg === '--hours') {
      const hours = Number(args[++i]);
      if (!Number.isFinite(hours) || hours < 1 || hours > 168) return null;
      opts.windowMs = hours * 3_600_000;
    } else if (arg === '--limit') {
      const limit = Number(args[++i]);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) return null;
      opts.limit = limit;
    } else if (arg === '--jobs') {
      const path = args[++i];
      if (typeof path !== 'string' || !path) return null;
      opts.jobsPath = path;
    } else return null;
  }
  return { opts, json };
}

export async function cmdFleetActivity(
  args: string[],
  read: typeof readAgentActivity = readAgentActivity,
  now: () => number = Date.now,
): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  const parsed = parseArgs(args);
  if (!parsed) { console.error(usage); return 2; }
  const report = await read({ ...parsed.opts, now });
  console.log(parsed.json ? JSON.stringify(report) : agentActivityLines(report).join('\n'));
  return 0;
}
