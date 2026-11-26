import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { redactHomePaths, scrubSecrets } from '../util/scrub.js';
import { readFleetBusFeed, type BusFeedEvent } from './bus-feed.js';
import { dispatchEventsCandidates } from './dispatch-events-path.js';
import { readEmptyJobs } from './empty-jobs.js';
import { readPlanLogReplies, replyTime } from './mason-outbox.js';
import { WORKLOG_KINDS, type WorklogEntry, type WorklogKind, type WorklogReport, type WorklogRow, type WorklogSources, type WorklogSource } from './worklog-types.js';

export { WORKLOG_KINDS, type WorklogKind, type WorklogEntry, type WorklogRow, type WorklogSources, type WorklogSource, type WorklogReport } from './worklog-types.js';

export interface WorklogExtra { rows?: WorklogRow[]; sources?: Partial<WorklogSources>; emptyReasons?: ReadonlyMap<string, string>; hours?: number }
const unknown = (reason: string): WorklogSource => ({ state: 'unknown', reason });
const plain = (text: string, max = 160): string => redactHomePaths(scrubSecrets(text)).replace(/\s+/g, ' ').trim().slice(0, max);
const ROW_KIND: Record<WorklogEntry['kind'], WorklogKind> = { launch: 'launched', finished: 'finished', pr: 'finished', empty: 'empty', failed: 'incident', merged: 'merged', closed: 'finished' };
export function duration(seconds: number): string {
  const s = Math.round(seconds), m = Math.floor(s / 60), h = Math.floor(m / 60);
  return h ? `${h}h ${m % 60}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
}
/** The one plain-words line for a ledger event. */
function words(entry: WorklogEntry, row: Row, title: string | null, reason: string | undefined): string {
  const pr = entry.url ? `#${entry.url.split('/').pop()}` : null;
  switch (entry.kind) {
    case 'launch': return `Launched${entry.model ? ` with ${entry.model}` : ''}`;
    case 'merged': return ['Merged', pr, title].filter(Boolean).join(' ') + (entry.openToMergeSeconds === null ? '' : ` in ${duration(entry.openToMergeSeconds)}`);
    case 'closed': return `Closed PR ${pr ?? ''} without merging`.replace('  ', ' ');
    case 'pr': return ['Opened PR', pr, title].filter(Boolean).join(' ');
    case 'finished': return 'Finished, no pull request recorded';
    case 'empty': return `Ended with no change: ${reason ?? 'reason unknown'}`;
    case 'failed': return `Failed with exit code ${String(row.exit_code)}`;
  }
}
const EVENT_LABELS: Partial<Record<BusFeedEvent['kind'], string>> = { incident: 'Incident', 'lane-hold': 'Lane hold', blocked: 'Parked' };
/** Incidents, lane holds and parked jobs from the dispatch events reader. Launches and publishes come from the ledger. */
export function eventRows(events: BusFeedEvent[]): WorklogRow[] {
  return events.flatMap(event => {
    // LANE_UNHOLD shares the lane-hold kind; it is the lane running again.
    const label = event.text.startsWith('LANE_UNHOLD') ? 'Lane released' : EVENT_LABELS[event.kind];
    if (!label || !event.atIso) return [];
    const rest = event.text.replace(/^\S+\s*/, '');
    const job = (event.kind === 'blocked' ? /^([A-Za-z0-9][A-Za-z0-9._-]{2,79})(?=\s|$)/ : /\bstopped ([A-Za-z0-9][A-Za-z0-9._-]{2,79}) by\b/).exec(rest)?.[1] ?? null;
    return [{ at: new Date(event.atIso).toISOString(), kind: 'incident' as const, job, lane: null, repo: null, text: plain(`${label}: ${rest || 'no detail recorded'}`), url: null, count: 1 }];
  });
}
/** Dated "Reply for Mason" lines from the leader plan log reader. */
export function leaderRows(replies: ReadonlyArray<{ at: string; text: string }>): WorklogRow[] {
  return replies.flatMap(reply => {
    const at = replyTime(reply.at);
    return Number.isFinite(at) ? [{ at: new Date(at).toISOString(), kind: 'leader' as const, job: null, lane: null, repo: null, text: plain(`Leader: ${reply.text}`), url: null, count: 1 }] : [];
  });
}
const str = (v: unknown): string | null => typeof v === 'string' && v.trim() ? v : null;
type Row = Record<string, unknown>;
/**
 * jobs.jsonl field dialects: ts|timestamp|at|time|mergedAt|closedAt|recordedAt|updatedAt,
 * job|job_id|jobId|id, url|prUrl|pr_url|pr|html_url, event|type|kind and
 * phase|state|outcome|status|result|conclusion — the aliases dispatchd `_vc_*`
 * and the fleet metrics readers accept.
 */
const timestamp = (row: Row) => str(row.ts ?? row.timestamp ?? row.at ?? row.time ?? row.mergedAt ?? row.closedAt ?? row.recordedAt ?? row.updatedAt);
const jobId = (row: Row) => str(row.job ?? row.job_id ?? row.jobId ?? row.id);
const eventName = (row: Row) => str(row.event ?? row.type ?? row.kind);
const phaseName = (row: Row) => str(row.phase ?? row.state ?? row.outcome ?? row.status ?? row.result ?? row.conclusion);
function prUrl(row: Row): string | null {
  const value = str(row.url ?? row.prUrl ?? row.pr_url ?? row.pr ?? row.html_url);
  return value && /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[1-9]\d*\/?$/i.test(value) ? value.replace(/\/$/, '') : null;
}
function eventKind(row: Row): WorklogEntry['kind'] | null {
  const event = eventName(row), phase = phaseName(row);
  if (event === 'launch') return 'launch';
  if (event === 'merged' || (event === 'outcome' && phase === 'MERGED')) return 'merged';
  if (event === 'outcome' && phase === 'CLOSED' && prUrl(row)) return 'closed';
  if (event === 'publish' && prUrl(row)) return 'pr';
  if (event !== 'finish') return null;
  if (typeof row.exit_code === 'number' && Number.isFinite(row.exit_code) && row.exit_code !== 0) return 'failed';
  if (prUrl(row)) return 'pr';
  return row.empty === true ? 'empty' : 'finished';
}

export const WORKLOG_DEFAULT_HOURS = 6;
/** Accepts `6` (--hours) and `6h` (the older --since form). */
export function worklogHours(value: string = String(WORKLOG_DEFAULT_HOURS)): number {
  const hours = Number(value.replace(/h$/, ''));
  if (!/^\d+(?:\.\d+)?h?$/.test(value) || hours <= 0 || !Number.isFinite(hours * 3600000)) throw new Error('Use a positive number of hours, for example 6.');
  return hours;
}

/**
 * Extend the existing jobs projection; a successful finish alone is not proof of a PR.
 * `extra` carries rows and source states from the other readers, so this stays pure.
 */
export function worklog(text: string, since: number, now: number, extra: WorklogExtra = {}): WorklogReport {
  const rows: Row[] = []; let malformedLines = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row: unknown = JSON.parse(line);
      if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error();
      rows.push(row as Row);
    } catch { malformedLines++; }
  }
  const launches = new Map<string, Row[]>();
  const publications = new Map<string, Row>();
  for (const row of rows) {
    const id = jobId(row);
    if (id && eventName(row) === 'launch') launches.set(id, [...(launches.get(id) ?? []), row]);
    const url = prUrl(row);
    if (id && url && eventName(row) === 'publish') publications.set(url.toLowerCase(), row);
  }
  const entries: WorklogEntry[] = [];
  const texts = new Map<WorklogEntry, string>();
  for (const row of rows) {
    const kind = eventKind(row);
    if (!kind) continue;
    const recordedAt = timestamp(row); const at = recordedAt ? Date.parse(recordedAt) : NaN;
    if (!recordedAt || !Number.isFinite(at)) { malformedLines++; continue; }
    if (at < since || at > now) continue;
    const url = prUrl(row);
    const publication = url ? publications.get(url.toLowerCase()) : undefined;
    const job = jobId(row) ?? (publication && Date.parse(timestamp(publication) ?? '') <= at ? jobId(publication) : null);
    // A retry launched while a PR waited to merge belongs to a later attempt.
    const publishedAt = publication ? Date.parse(timestamp(publication) ?? '') : NaN;
    const launchBefore = kind === 'merged' && publication && jobId(publication) === job && publishedAt <= at ? publishedAt : at;
    const launch = job ? (launches.get(job) ?? []).filter(r => {
      const time = timestamp(r); return time && Number.isFinite(Date.parse(time)) && Date.parse(time) <= launchBefore;
    }).sort((a, b) => Date.parse(timestamp(b)!) - Date.parse(timestamp(a)!))[0] : undefined;
    const repo = str(row.repo ?? launch?.repo) ?? (url ? new URL(url).pathname.split('/')[2] ?? null : null);
    const seconds = row.ttm_s;
    const title = str(row.title ?? publication?.title ?? launch?.title ?? launch?.goal), reason = job ? extra.emptyReasons?.get(job) : undefined;
    const why = str(row.reason ?? row.failure_class);
    const detail = kind === 'failed' ? plain(why ?? `exit code ${String(row.exit_code)}`, 80) : kind === 'empty' ? reason ?? null : null;
    const entry: WorklogEntry = { job, repo, lane: str(row.lane ?? launch?.lane), model: str(row.model ?? launch?.model), kind, at: recordedAt,
      mergedAt: kind === 'merged' ? recordedAt : null,
      openToMergeSeconds: kind === 'merged' && typeof seconds === 'number' && Number.isFinite(seconds) && seconds >= 0 ? seconds : null, url,
      goal: title && plain(title, 80), detail };
    entries.push(entry);
    texts.set(entry, plain(words(entry, row, title && plain(title, 60), reason)));
  }
  entries.sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
  const seen = new Set<string>();
  const unique = entries.filter(entry => {
    if (!entry.url || !['merged', 'pr', 'closed'].includes(entry.kind)) return true;
    const key = `${entry.kind}:${entry.url.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });
  const all: WorklogRow[] = [
    ...unique.map(e => ({ at: new Date(e.at).toISOString(), kind: ROW_KIND[e.kind], job: e.job, lane: e.lane, repo: e.repo, text: texts.get(e)!, url: e.url, count: 1 })),
    ...(extra.rows ?? []).filter(row => Date.parse(row.at) >= since && Date.parse(row.at) <= now),
  ];
  // Total order, so the same events always serialize the same way whatever order the sources were read in.
  const key = (row: WorklogRow) => `${WORKLOG_KINDS.indexOf(row.kind)} ${row.job ?? ''} ${row.text}`;
  all.sort((a, b) => Date.parse(b.at) - Date.parse(a.at) || (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
  const feed: WorklogRow[] = [];
  for (const row of all) {
    const last = feed.at(-1);
    // One job repeating a kind (retries, finish then PR) reads as one line; so does one repeated job-less notice.
    if (last && last.kind === row.kind && (row.job ? last.job === row.job : !last.job && last.text === row.text)) last.count += row.count;
    else feed.push({ ...row });
  }
  const ok: WorklogSource = { state: 'ok' };
  return { schema: 'worklog.v3', hours: extra.hours ?? null, rows: feed, sources: { jobs: ok, events: ok, leader: ok, ...extra.sources }, entries: unique, malformedLines };
}

export interface ReadWorklogOptions { runsDir?: string; worktreesDir?: string; now?: number }
/** Read every source once. A source that fails is reported as unknown with a reason; the others still show. */
export async function readWorklog(hours = WORKLOG_DEFAULT_HOURS, opts: ReadWorklogOptions = {}): Promise<WorklogReport> {
  const runsDir = opts.runsDir ?? (process.env.ASHLR_RUNS_DIR?.trim() || join(homedir(), '.ashlr-runs'));
  const now = opts.now ?? Date.now();
  const sources: Partial<WorklogSources> = {};
  const rows: WorklogRow[] = [];
  let text = '';
  try { text = await readFile(join(runsDir, 'metrics', 'jobs.jsonl'), 'utf8'); }
  catch (error) { sources.jobs = unknown((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'No jobs ledger has been written yet.' : 'The jobs ledger could not be read.'); }
  try {
    let state = 'missing';
    // Queue log first, runs-root log second: the first one present wins and the two are never merged.
    for (const eventsFile of dispatchEventsCandidates(runsDir)) {
      const feed = await readFleetBusFeed({ runsDir, eventsFile, limit: 500 });
      state = feed.sources.events;
      if (state === 'missing') continue;
      rows.push(...eventRows(feed.events));
      break;
    }
    if (state !== 'healthy') sources.events = unknown(state === 'missing' ? 'No dispatch events log has been written yet.' : 'The dispatch events log could not be read in full.');
  } catch { sources.events = unknown('The dispatch events log could not be read.'); }
  try {
    const replies = await readPlanLogReplies({ limit: 1000, ...(opts.runsDir ? { file: join(runsDir, 'leader', 'PLAN-LOG.md') } : {}) });
    rows.push(...leaderRows(replies.entries));
    // The reader's own reason names a home path, so use fixed words here.
    if (replies.sourceState !== 'healthy') sources.leader = unknown(replies.sourceState === 'missing' ? 'No leader plan log has been written yet.' : 'The leader plan log could not be read.');
  } catch { sources.leader = unknown('The leader plan log could not be read.'); }
  const emptyReasons = new Map<string, string>();
  if (text.includes('"empty"')) {
    const empties = await readEmptyJobs(hours, runsDir, opts.worktreesDir, now).catch(() => null);
    for (const job of empties?.jobs ?? []) if (job.class !== 'other') emptyReasons.set(job.id, job.reason.charAt(0).toLowerCase() + job.reason.slice(1).replace(/\.$/, ''));
  }
  return worklog(text, now - hours * 3600000, now, { rows, sources, emptyReasons, hours });
}

/** One filter for rows and ledger entries, shared by the CLI and the API. */
export function filterWorklog<T extends { repo: string | null; lane: string | null; kind: string }>(items: T[], repo?: string, lane?: string, kind?: string): T[] {
  return items.filter(e => (!repo || (e.repo ?? 'unknown') === repo) && (!lane || (e.lane ?? 'unknown') === lane) && (!kind || e.kind === kind));
}
