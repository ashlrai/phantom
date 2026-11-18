/**
 * job-log.ts: `phm log` and GET /api/log (joblog.v1). One row per job, folded
 * from the entries the work log reader already joined (launch, finish, publish
 * and outcome events). It reads nothing itself: `readWorklog` stays the only
 * reader of the jobs ledger for this view. Anything not recorded stays null and
 * is shown as "unknown".
 */
import { duration, filterWorklog, readWorklog, WORKLOG_DEFAULT_HOURS, type WorklogEntry, type WorklogReport } from './worklog.js';

export type JobLogResult = 'merged' | 'closed' | 'open' | 'no-change' | 'failed' | 'finished' | 'running';
export interface JobLogRow {
  /** Null when a merge or close was recorded with no job id and no matching publish. */
  job: string | null;
  /** Time of the job's newest event in the window. */
  at: string;
  lane: string | null; model: string | null; repo: string | null; goal: string | null;
  result: JobLogResult;
  /** The result in plain words: "Merged PR 7", "No change: work was already covered", "Failed: exit code 1". */
  text: string;
  pr: number | null; url: string | null;
  /** Seconds from PR open to merge; null unless merged with a recorded or derivable time. */
  mergeSeconds: number | null;
}
export interface JobLogCounts { jobs: number; merged: number; noChange: number; noChangeRate: number | null; medianMergeSeconds: number | null }
export interface JobLogReport {
  schema: 'joblog.v1'; version: 1; hours: number | null;
  /** The summary in one plain-words line, the same on every surface. */
  headline: string;
  summary: JobLogCounts & { lanes: (JobLogCounts & { lane: string })[] };
  jobs: JobLogRow[];
  sources: Pick<WorklogReport['sources'], 'jobs'>; malformedLines: number;
}
export interface JobLogFilters { repo?: string; lane?: string }

const time = (entry: WorklogEntry) => Date.parse(entry.at);
const first = <T>(entries: WorklogEntry[], pick: (entry: WorklogEntry) => T | null): T | null => {
  for (const entry of entries) { const value = pick(entry); if (value !== null) return value; }
  return null;
};

/** Fold one job's entries (newest first) into its row. A merge wins over a close, a close over an open PR, then the newest event decides. */
function row(job: string | null, entries: WorklogEntry[]): JobLogRow {
  const of = (kind: WorklogEntry['kind']) => entries.find(entry => entry.kind === kind);
  const merged = of('merged'), closed = of('closed'), opened = of('pr'), last = entries[0]!;
  const url = (merged ?? closed ?? opened)?.url ?? null, pr = url ? Number(url.split('/').pop()) : null;
  const named = pr === null ? 'a PR with no number recorded' : `PR ${pr}`;
  const why = (entry: WorklogEntry) => entry.detail ?? 'reason unknown';
  let result: JobLogResult, text: string, mergeSeconds: number | null = null;
  if (merged) {
    const sincePublish = opened && time(merged) >= time(opened) ? (time(merged) - time(opened)) / 1000 : null;
    result = 'merged'; text = `Merged ${named}`; mergeSeconds = merged.openToMergeSeconds ?? sincePublish;
  } else if (closed) { result = 'closed'; text = `Closed ${named} without merging`; }
  else if (opened) { result = 'open'; text = `Opened ${named}, not merged yet`; }
  else if (last.kind === 'empty') { result = 'no-change'; text = `No change: ${why(last)}`; }
  else if (last.kind === 'failed') { result = 'failed'; text = `Failed: ${why(last)}`; }
  else if (last.kind === 'finished') { result = 'finished'; text = 'Finished, no PR recorded'; }
  else { result = 'running'; text = 'Still running, no result yet'; }
  return { job, at: new Date(last.at).toISOString(), lane: first(entries, e => e.lane), model: first(entries, e => e.model), repo: first(entries, e => e.repo),
    goal: first(entries, e => e.goal), result, text, pr, url, mergeSeconds };
}

function counts(rows: JobLogRow[]): JobLogCounts {
  const times = rows.flatMap(job => job.mergeSeconds === null ? [] : [job.mergeSeconds]).sort((a, b) => a - b);
  const noChange = rows.filter(job => job.result === 'no-change').length;
  return { jobs: rows.length, merged: rows.filter(job => job.result === 'merged').length, noChange,
    noChangeRate: rows.length ? noChange / rows.length : null,
    medianMergeSeconds: times.length ? (times[Math.floor((times.length - 1) / 2)]! + times[Math.floor(times.length / 2)]!) / 2 : null };
}

/** Pure projection of a work log report: one row per job, newest first, with the summary counted over the filtered rows. */
export function jobLog(report: WorklogReport, filters: JobLogFilters = {}): JobLogReport {
  const groups = new Map<string, WorklogEntry[]>();
  // Entries arrive newest first. A result with no job id is its own row, keyed by its PR.
  for (const entry of report.entries) {
    const key = entry.job ? `job:${entry.job}` : `none:${entry.url ?? entry.at}`;
    groups.set(key, [...(groups.get(key) ?? []), entry]);
  }
  const all = [...groups.values()].map(entries => row(entries[0]!.job, entries));
  const jobs = filterWorklog(all.map(job => ({ ...job, kind: job.result })), filters.repo, filters.lane).map(({ kind: _kind, ...job }) => job);
  jobs.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || (a.job ?? '').localeCompare(b.job ?? ''));
  const lanes = [...new Set(jobs.map(job => job.lane ?? 'unknown'))].sort()
    .map(lane => ({ lane, ...counts(jobs.filter(job => (job.lane ?? 'unknown') === lane)) }));
  const total = counts(jobs);
  return { schema: 'joblog.v1', version: 1, hours: report.hours, headline: `${jobLogSummary(total)}.`, summary: { ...total, lanes }, jobs,
    sources: { jobs: report.sources.jobs }, malformedLines: report.malformedLines };
}

/** The one read path for the CLI and the API. */
export async function readJobLog(hours = WORKLOG_DEFAULT_HOURS, filters: JobLogFilters = {}, read: (hours: number) => Promise<WorklogReport> = readWorklog): Promise<JobLogReport> {
  return jobLog(await read(hours), filters);
}

export function jobLogDuration(seconds: number | null): string {
  return seconds === null ? 'unknown' : duration(seconds);
}
/** The ten-second summary: "5 jobs, 1 merged, 20% made no change, median time to merge 1m 0s." */
export function jobLogSummary(c: JobLogCounts): string {
  if (!c.jobs) return '0 jobs';
  const rate = c.noChangeRate === null ? 'unknown' : `${Math.round(c.noChangeRate * 100)}%`;
  return `${c.jobs} ${c.jobs === 1 ? 'job' : 'jobs'}, ${c.merged} merged, ${rate} made no change, median time to merge ${jobLogDuration(c.medianMergeSeconds)}`;
}
