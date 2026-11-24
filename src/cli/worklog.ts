import { filterWorklog, readWorklog, worklogHours, WORKLOG_DEFAULT_HOURS, WORKLOG_KINDS, type WorklogKind, type WorklogReport } from '../core/fleet/worklog.js';

const usage = `Usage: phm worklog [--hours ${WORKLOG_DEFAULT_HOURS}] [--kind ${WORKLOG_KINDS.join('|')}] [--repo <repo>] [--lane <lane>] [--json]
One feed of what the fleet did, newest first: merges, launches, finishes, jobs that ended with no change,
leader replies and incidents. Read-only. A source that cannot be read is listed as unknown with the reason.
--since <n>h is the older spelling of --hours <n>.`;
const SOURCE_NAMES: Record<keyof WorklogReport['sources'], string> = { jobs: 'job results', events: 'dispatch events', leader: 'leader replies' };
const pad = (n: number) => String(n).padStart(2, '0');

/** Human lines: time, kind, what is known of job, lane and repo, the plain-words line, then the PR link. */
export function worklogText(report: WorklogReport, filtered: boolean): string[] {
  const lines = report.rows.map(row => {
    const at = new Date(row.at);
    const ledger = row.kind !== 'leader' && row.kind !== 'incident';
    const who = [row.job ?? (ledger ? 'unknown job' : null), row.lane ?? (ledger ? 'unknown lane' : null), row.repo ?? (ledger ? 'unknown repo' : null)].filter(Boolean).join(' · ');
    return [`${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`, row.kind.padEnd(9), who,
      row.text + (row.count > 1 ? ` (${row.count} events)` : ''), row.url].filter(Boolean).join('  ');
  });
  if (!lines.length) lines.push(filtered ? 'No work events match these filters.' : `No work recorded in the last ${report.hours ?? WORKLOG_DEFAULT_HOURS} hours.`);
  for (const [name, source] of Object.entries(report.sources)) {
    if (source.state === 'unknown') lines.push(`Unknown: ${SOURCE_NAMES[name as keyof WorklogReport['sources']]}. ${source.reason}`);
  }
  if (report.malformedLines > 0) lines.push(`${report.malformedLines} unreadable ledger lines skipped.`);
  return lines;
}

export async function cmdWorklog(args: string[], read: (hours: number) => Promise<WorklogReport> = readWorklog): Promise<number> {
  let hours = WORKLOG_DEFAULT_HOURS, json = false;
  const filters: { kind?: string; repo?: string; lane?: string } = {};
  const fail = () => { console.error(usage); return 2; };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--help' || arg === '-h') { console.log(usage); return 0; }
    if (arg === '--json') { json = true; continue; }
    const value = args[++i];
    if (!value?.trim() || value.startsWith('-')) return fail();
    if (arg === '--hours' || arg === '--since') { try { hours = worklogHours(value); } catch { return fail(); } }
    else if (arg === '--kind' && (WORKLOG_KINDS as readonly string[]).includes(value)) filters.kind = value as WorklogKind;
    else if (arg === '--repo' || arg === '--lane') filters[arg === '--repo' ? 'repo' : 'lane'] = value;
    else return fail();
  }
  try {
    const report = await read(hours);
    report.rows = filterWorklog(report.rows, filters.repo, filters.lane, filters.kind);
    report.entries = filterWorklog(report.entries, filters.repo, filters.lane);
    console.log(json ? JSON.stringify(report) : worklogText(report, Boolean(filters.kind || filters.repo || filters.lane)).join('\n'));
    return 0;
  } catch { console.error('Unable to read the work log.'); return 1; }
}
