/**
 * What the fleet shipped: one entry per merged PR, newest first, with the jobs
 * that ended with no PR counted per hour instead of listed. A pure projection of
 * the `worklog()` entries (core/fleet/worklog.ts), which already joins the
 * jobs.jsonl `launch`, `publish` and `outcome` rows; there is no second parser.
 * Anything the ledger did not record is null here and "unknown" in text.
 */
import { WORKLOG_DEFAULT_HOURS, type WorklogEntry, type WorklogReport } from './worklog.js';

export const WORKLOG_PRS_SCHEMA = 'fleet.worklog-prs.v1';
const HOUR_MS = 3_600_000;

export interface ShippedPr {
  mergedAt: string; repo: string | null; pr: number | null; title: string | null; url: string | null;
  lane: string | null; model: string | null; job: string | null;
  /** Minutes from publish to merge; null when the ledger did not time it. */
  minutes: number | null;
}
export interface ShippedHour {
  /** Start of the UTC hour, ISO. */
  hour: string; merged: number; noPr: number; prs: ShippedPr[];
}
export interface WorklogPrsReport {
  schema: typeof WORKLOG_PRS_SCHEMA; hours: number | null; repo: string | null;
  merged: number; noPr: number; prs: ShippedPr[]; hourly: ShippedHour[];
  sources: WorklogReport['sources']; malformedLines: number;
}

/** `owner/repo` from the PR link, or the recorded repo name. */
const repoOf = (entry: WorklogEntry): string | null =>
  entry.url ? new URL(entry.url).pathname.split('/').slice(1, 3).join('/') : entry.repo;
const hourOf = (at: string): string => new Date(Math.floor(Date.parse(at) / HOUR_MS) * HOUR_MS).toISOString();
/** `--repo phantom` and `--repo ashlrai/phantom` both match. */
const matches = (entry: WorklogEntry, repo: string | undefined): boolean => {
  if (!repo) return true;
  const want = repo.toLowerCase(), full = repoOf(entry)?.toLowerCase() ?? '', short = entry.repo?.toLowerCase() ?? '';
  return want === full || want === short || full.endsWith(`/${want}`);
};

export function worklogPrs(report: WorklogReport, repo?: string): WorklogPrsReport {
  const entries = report.entries.filter(entry => matches(entry, repo));
  // A job that opened or merged a PR is not "no PR", even if an earlier attempt ended empty.
  const shipped = new Set(entries.filter(e => ['pr', 'merged', 'closed'].includes(e.kind) && e.job).map(e => e.job));
  const prs: ShippedPr[] = entries.filter(e => e.kind === 'merged').map(e => ({
    mergedAt: e.mergedAt ?? e.at, repo: repoOf(e), pr: e.url ? Number(e.url.split('/').pop()) : null, title: e.goal, url: e.url,
    lane: e.lane, model: e.model, job: e.job,
    minutes: e.openToMergeSeconds === null ? null : Math.round(e.openToMergeSeconds / 6) / 10,
  })).sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt));
  // One no-PR count per job (its newest ending); a job with no id counts per event.
  const ended = new Map<string, WorklogEntry>();
  entries.filter(e => ['empty', 'finished', 'failed'].includes(e.kind) && !(e.job && shipped.has(e.job))).forEach((e, i) => {
    const key = e.job ?? `#${i}`, prev = ended.get(key);
    if (!prev || Date.parse(e.at) > Date.parse(prev.at)) ended.set(key, e);
  });
  const hours = new Map<string, ShippedHour>();
  const slot = (at: string) => {
    const hour = hourOf(at);
    return hours.get(hour) ?? (hours.set(hour, { hour, merged: 0, noPr: 0, prs: [] }), hours.get(hour)!);
  };
  for (const pr of prs) { const h = slot(pr.mergedAt); h.merged++; h.prs.push(pr); }
  for (const e of ended.values()) slot(e.at).noPr++;
  return {
    schema: WORKLOG_PRS_SCHEMA, hours: report.hours, repo: repo ?? null, merged: prs.length, noPr: ended.size, prs,
    hourly: [...hours.values()].sort((a, b) => Date.parse(b.hour) - Date.parse(a.hour)),
    sources: report.sources, malformedLines: report.malformedLines,
  };
}

const pad = (n: number) => String(n).padStart(2, '0');
/** Human lines: one per PR, grouped by hour with a count, then the hour's no-PR count. */
export function worklogPrsText(report: WorklogPrsReport): string[] {
  const lines: string[] = [];
  for (const hour of report.hourly) {
    const at = new Date(hour.hour);
    const label = `${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:00`;
    lines.push(`${label}  ${hour.merged} merged${hour.noPr ? `, ${hour.noPr} ended with no PR` : ''}`);
    for (const pr of hour.prs) {
      const time = new Date(pr.mergedAt);
      lines.push(`  ${pad(time.getHours())}:${pad(time.getMinutes())}  ${pr.repo ?? 'unknown repo'}${pr.pr === null ? '' : `#${pr.pr}`}  ${pr.title ?? 'unknown title'}  `
        + `${pr.lane ?? 'unknown lane'} · ${pr.model ?? 'unknown model'} · ${pr.minutes === null ? 'unknown' : `${pr.minutes}`} min to merge`);
    }
  }
  if (!lines.length) lines.push(`No PRs merged in the last ${report.hours ?? WORKLOG_DEFAULT_HOURS} hours${report.repo ? ` for ${report.repo}` : ''}.`);
  for (const [name, source] of Object.entries(report.sources)) if (source.state === 'unknown') lines.push(`Unknown: ${name}. ${source.reason}`);
  if (report.malformedLines > 0) lines.push(`${report.malformedLines} unreadable ledger lines skipped.`);
  return lines;
}
