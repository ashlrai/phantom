/**
 * `phm fleet relaunches`: jobs that keep spending launch starts without a merged PR (RQ-RELAUNCHCAPN20KQ8).
 *
 * Launch starts are the fleet's scarcest resource. `buildRelaunches` reads the job metrics rows (the same
 * launch, finish, publish and outcome rows `phm fleet launches` reads) for the last 24 hours and returns, per job
 * id, {launches, lanes, minutes_spent, prs, merged}, plus the jobs with 3 or more launches and no merged PR
 * in plain words. Pure and read-only; a job with no measured time has minutes_spent 0, never a guess.
 */
import { ledgerRows, ledgerEventName, ledgerPhase, ledgerPrUrl, ledgerLane } from './empty-cause.js';

export const RELAUNCHES_SCHEMA = 'fleet.relaunches.v1';
/** A job launched this many times in 24 h with no merged PR is listed. */
export const RELAUNCH_MIN_LAUNCHES = 3;
/** How many jobs the short list (default CLI text) shows. */
export const RELAUNCH_TOP = 3;
const DAY = 24 * 3_600_000;
const PR_URL = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/([1-9]\d*)\/?$/i;

/** What one job spent over the last 24 hours. */
export interface JobRelaunches {
  launches: number;
  /** Distinct lanes it launched on, most launches first. */
  lanes: string[];
  /** Wall minutes of its finished launches (finish row wall_s, else launch to finish). */
  minutes_spent: number;
  /** Distinct PRs it published or merged. */
  prs: number;
  merged: number;
}

export interface RelaunchJob extends JobRelaunches {
  job: string;
  /** Plain words: what happened and what to do. */
  summary: string;
  suggest: string;
}

export interface RelaunchesReport {
  schema: typeof RELAUNCHES_SCHEMA;
  as_of: string;
  hours: 24;
  metrics: 'ok' | 'unreadable';
  min_launches: number;
  /** Every job launched in the window. */
  jobs: Record<string, JobRelaunches>;
  /** Jobs with min_launches or more launches and no merged PR, most launches first, then measured minutes. */
  repeat_jobs: RelaunchJob[];
  headline: string;
  /** The one thing to do about the worst job; null when nothing is listed. */
  next_step: string | null;
}

const label = (value: unknown): string | null => typeof value === 'string' && /^[\w][\w.:@/-]{0,79}$/.test(value.trim()) ? value.trim() : null;
const round1 = (value: number): number => Math.round(value * 10) / 10;
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Pure: "launched 4 times on zai, 98 minutes, no PR merged; suggest: inspect the prior attempts and PR blockers". */
export function relaunchWords(job: JobRelaunches): { summary: string; suggest: string } {
  const lanes = job.lanes.length ? job.lanes.join(' and ') : 'an unknown lane';
  const pr = job.prs === 0 ? 'no PR came out' : `${plural(job.prs, 'PR')} came out, none merged`;
  const suggest = 'inspect the prior attempts and PR blockers';
  return { summary: `launched ${plural(job.launches, 'time')} on ${lanes}, ${Math.round(job.minutes_spent)} minutes, ${pr}`, suggest };
}

/** Pure: per-job launch spend and the repeat list for the 24 hours before `now`. `ledger` null means unreadable. */
export function buildRelaunches(ledger: string | null, now: number, minLaunches = RELAUNCH_MIN_LAUNCHES): RelaunchesReport {
  const report: RelaunchesReport = {
    schema: RELAUNCHES_SCHEMA, as_of: new Date(now).toISOString(), hours: 24, metrics: ledger === null ? 'unreadable' : 'ok',
    min_launches: minLaunches, jobs: Object.create(null) as Record<string, JobRelaunches>, repeat_jobs: [], headline: '', next_step: null,
  };
  if (ledger === null) {
    report.headline = 'Repeat launches: unknown (cannot read the job metrics file)';
    return report;
  }
  interface Acc { launches: { at: number; lane: string | null; wall: number | null }[]; prs: Set<string>; merged: Set<string> }
  const accs = new Map<string, Acc>();
  const acc = (job: string): Acc => { let a = accs.get(job); if (!a) { a = { launches: [], prs: new Set(), merged: new Set() }; accs.set(job, a); } return a; };
  const finishes: { job: string; at: number; wall: number | null }[] = [];
  for (const { row, id, at } of ledgerRows(ledger, now, DAY / 3_600_000).rows) {
    const event = ledgerEventName(row);
    const merged = ledgerPhase(row) === 'MERGED' || event === 'merged';
    if (event === 'launch' && !merged) { acc(id).launches.push({ at, lane: label(ledgerLane(row)), wall: null }); continue; }
    if (event === 'finish' && !merged) { finishes.push({ job: id, at, wall: typeof row.wall_s === 'number' && Number.isFinite(row.wall_s) && row.wall_s >= 0 ? row.wall_s : null }); continue; }
    const url = PR_URL.exec(ledgerPrUrl(row) ?? '');
    if (!url) continue;
    const key = `${url[1]}#${url[2]}`.toLowerCase();
    if (event === 'publish' || event === 'published' || merged) acc(id).prs.add(key);
    if (merged) acc(id).merged.add(key);
  }
  // A finish closes the latest launch at or before it; a finish with no launch in the window is not this window's spend.
  for (const finish of finishes.sort((a, b) => a.at - b.at)) {
    const open = accs.get(finish.job)?.launches.filter(l => l.at <= finish.at && l.wall === null).sort((a, b) => b.at - a.at)[0];
    if (open) open.wall = finish.wall ?? (finish.at - open.at) / 1000;
  }
  for (const [job, a] of accs) {
    if (!a.launches.length) continue;
    const byLane = new Map<string, number>();
    for (const l of a.launches) byLane.set(l.lane ?? 'unknown', (byLane.get(l.lane ?? 'unknown') ?? 0) + 1);
    report.jobs[job] = {
      launches: a.launches.length,
      lanes: [...byLane].sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).map(([lane]) => lane),
      minutes_spent: round1(a.launches.reduce((sum, l) => sum + (l.wall ?? 0), 0) / 60),
      prs: a.prs.size, merged: a.merged.size,
    };
  }
  report.repeat_jobs = Object.entries(report.jobs)
    .filter(([, j]) => j.launches >= minLaunches && j.merged === 0)
    .sort((x, y) => y[1].launches - x[1].launches || y[1].minutes_spent - x[1].minutes_spent || x[0].localeCompare(y[0]))
    .map(([job, j]) => ({ job, ...j, ...relaunchWords(j) }));
  const worst = report.repeat_jobs[0];
  report.headline = worst
    ? `${plural(report.repeat_jobs.length, 'job')} launched ${minLaunches} or more times in 24 h with no merged PR`
    : `No job launched ${minLaunches} or more times in 24 h without a merged PR`;
  report.next_step = worst ? `${worst.job}: ${worst.suggest}` : null;
  return report;
}

/** Plain lines: headline, then the top jobs and the one next step. */
export function relaunchesText(report: RelaunchesReport, top = RELAUNCH_TOP): string[] {
  if (report.metrics === 'unreadable') return [`${report.headline}.`];
  const shown = report.repeat_jobs.slice(0, top);
  return [
    `${report.headline}.`,
    ...shown.map(j => `- ${j.job}: ${j.summary}; suggest: ${j.suggest}`),
    ...(report.repeat_jobs.length > shown.length ? [`  and ${report.repeat_jobs.length - shown.length} more (--json lists all)`] : []),
    ...(report.next_step ? [`Next: ${report.next_step}`] : []),
  ];
}
