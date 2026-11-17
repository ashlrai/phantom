import { filterWorklog, readWorklog, worklogHours } from '../core/fleet/worklog.js';
const usage = 'Usage: phm worklog [--since <hours>h] [--repo <repo>] [--lane <lane>] [--json]';
export async function cmdWorklog(args: string[], read = readWorklog): Promise<number> {
  let hours = 24, repo: string | undefined, lane: string | undefined, json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') { console.log(usage); return 0; }
    if (arg === '--json') json = true;
    else if (arg === '--repo') repo = args[++i];
    else if (arg === '--lane') lane = args[++i];
    else if (arg === '--since') { const value = args[++i]; try { if (!value) throw new Error(); hours = worklogHours(value); } catch { console.error(usage); return 2; } }
    else { console.error(usage); return 2; }
    if ((arg === '--repo' && (!repo?.trim() || repo.startsWith('-'))) || (arg === '--lane' && (!lane?.trim() || lane.startsWith('-')))) { console.error(usage); return 2; }
  }
  try {
    const report = await read(hours);
    report.entries = filterWorklog(report.entries, repo, lane);
    console.log(json ? JSON.stringify(report) : report.entries.map(e => `${e.at} ${e.kind} ${e.repo ?? 'unknown'} ${e.job ?? 'unknown'} ${e.lane ?? 'unknown'} ${e.url ?? ''}`).join('\n') || 'No work events match these filters.');
    return 0;
  } catch { console.error('Unable to read jobs ledger.'); return 1; }
}
