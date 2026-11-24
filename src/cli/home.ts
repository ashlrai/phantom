/** `phm home`: thin handler. Parses argv and prints the summary built in core/fleet/home.ts. */
import { homeText, readHome, type HomeSummary } from '../core/fleet/home.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = `Usage: phm home [--json] [--leader-seen <time>]
Is the fleet healthy and moving: PRs merged in the last hour and 24 hours, median time to merge, main per repo, running jobs per lane,
the resource most at risk of going unused before its reset, the last 5 work-log items, unread Leader replies and what needs you (answer with phm asks answer). Read-only.
  --json                 print the typed summary (schema home.v1)
  --leader-seen <time>   when you last read the Leader thread (ISO time); replies after it count as unread
Anything whose source is missing prints as unknown with the reason, never as zero.`;

export async function cmdHome(args: string[], read: (leaderSeenMs: number | null) => Promise<HomeSummary> = leaderSeenMs => readHome({ leaderSeenMs })): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(usage); return 0; }
  let json = false, seen: number | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--json') json = true;
    else if (args[i] === '--leader-seen' && Number.isFinite(seen = Date.parse(args[++i] ?? ''))) continue;
    else { console.error(`phm home: unknown or incomplete option ${args[i]}\n${usage}`); return 2; }
  }
  const home = sanitizePublicJson(await read(seen)) as HomeSummary;
  console.log(json ? JSON.stringify(home) : homeText(home).join('\n'));
  return 0;
}
