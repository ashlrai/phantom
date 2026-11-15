import { filterWorklog, readWorklog } from '../core/fleet/worklog.js';
const usage = 'Usage: phm worklog [--since <hours>h] [--repo <repo>] [--lane <lane>] [--json]';
export async function cmdWorklog(args: string[]): Promise<number> {
  let hours = 24, repo: string | undefined, lane: string | undefined, json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') { console.log(usage); return 0; }
    if (arg === '--json') json = true;
    else if (arg === '--repo') repo = args[++i];
    else if (arg === '--lane') lane = args[++i];
    else if (arg === '--since') { const value = args[++i]; if (!value || !/^\d+(?:\.\d+)?h$/.test(value) || !(Number(value.slice(0, -1)) > 0) || !Number.isFinite(Number(value.slice(0, -1)) * 3600000)) { console.error(usage); return 2; } hours = Number(value.slice(0, -1)); }
    else { console.error(usage); return 2; }
    if ((arg === '--repo' && !repo) || (arg === '--lane' && !lane)) { console.error(usage); return 2; }
  }
  try {
    const report = await readWorklog(hours);
    report.entries = filterWorklog(report.entries, repo, lane);
    console.log(json ? JSON.stringify(report) : report.entries.map(e => `${e.mergedAt} ${e.repo ?? 'unknown'} ${e.job ?? 'unknown'} ${e.lane ?? 'unknown'} ${e.model ?? 'unknown'} ${e.openToMergeSeconds ?? 'unknown'} seconds ${e.url ?? 'unknown'}`).join('\n'));
    return 0;
  } catch { console.error('Unable to read jobs ledger.'); return 1; }
}
