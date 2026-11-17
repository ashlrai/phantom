/**
 * core/queue/supersede.ts: drop older cycles of a job a planner queued again.
 *
 * Planners re-issue the same job under a new cycle id (RQ-PHX-RECUTCOREC541,
 * then RQ-PHX-RECUTCOREC544) while the older row is still queued, so launch
 * slots go to stale copies. This extends the two existing queue files, it adds
 * no queue of its own:
 *   queue/ready.tsv        rows waiting to launch (ready-row-edit.ts contract);
 *   queue/router-queue.md  the lines the restocker refills ready.tsv from.
 *
 * A FAMILY is one repo plus the id with its cycle stripped. A cycle is spelled
 * C<number>, <number>S or <number>C at the end of the id, with two or more
 * digits. Ids that end any other way (RQ-WIKI2-N17, RQ-FOOQ8) have no cycle
 * and are never touched: a bare trailing number is too often part of the name.
 *
 * --apply never deletes. In order: copy each stale ready.tsv row to
 * queue/superseded.tsv, mark the router lines SUPERSEDED-BY-<newer id> (the
 * marker `phm queue dedupe` already writes, so the restocker cannot re-add
 * them), remove the rows through the verified ready.tsv writer, then append one
 * SUPERSEDED line per job to queue/dispatch-events.log. A step that fails
 * leaves the earlier ones in place and a second run finishes the rest.
 */
import { constants } from 'node:fs';
import { open, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultRunsDir } from '../fleet/landed-closes-read.js';
import { parseReadyRows, readReadyText, rewriteReadyRows, type RewriteReadyRowsOptions } from '../fleet/ready-row-edit.js';
import { replaceQueueText } from './dedupe.js';

export const SUPERSEDE_ARCHIVE = 'superseded.tsv';
export interface QueueJob {
  id: string; repo: string;
  /** False for a claimed or running job: it can supersede older cycles but is never superseded itself. */
  queued: boolean;
}
export interface SupersededJob { id: string; repo: string; family: string; cycle: number; supersededBy: string }
export interface SupersedeReport {
  schema: 'queue.supersede.v1';
  /** True once every change this run planned is written and verified. */
  applied: boolean;
  /** Queued jobs looked at. */
  queued: number;
  count: number;
  superseded: SupersededJob[];
}

const CYCLE = /^([A-Za-z0-9][\w.-]*?[A-Za-z-])(?:C(\d{2,})|(\d{2,})[SC])$/;
/** The family and cycle number of an id, or null when it has no cycle. */
export function cycleOf(id: string): { family: string; cycle: number } | null {
  const match = CYCLE.exec(id);
  return match ? { family: match[1]!.replace(/-$/, ''), cycle: Number(match[2] ?? match[3]) } : null;
}
export const repoKey = (repo: string): string => repo.trim().toLowerCase().replace(/^ashlrai\//, '');

/** Pure: the queued jobs that a newer cycle of the same family and repo replaces. Sorted, so the output is stable. */
export function planSupersede(jobs: readonly QueueJob[]): SupersededJob[] {
  const families = new Map<string, Map<string, { cycle: number; queued: boolean }>>();
  for (const job of jobs) {
    const parsed = cycleOf(job.id), repo = repoKey(job.repo);
    if (!parsed || !/^[\w.-]+$/.test(repo)) continue;
    const key = `${repo}\n${parsed.family}`, members = families.get(key) ?? new Map<string, { cycle: number; queued: boolean }>();
    // An id seen as both a ready row and a claimed line is still waiting to launch.
    members.set(job.id, { cycle: parsed.cycle, queued: job.queued || members.get(job.id)?.queued === true });
    families.set(key, members);
  }
  const out: SupersededJob[] = [];
  for (const [key, members] of families) {
    const [repo, family] = key.split('\n') as [string, string];
    const newest = Math.max(...[...members.values()].map(member => member.cycle));
    const supersededBy = [...members].filter(([, member]) => member.cycle === newest).map(([id]) => id).sort()[0]!;
    for (const [id, member] of members) if (member.queued && member.cycle < newest) out.push({ id, repo, family, cycle: member.cycle, supersededBy });
  }
  return out.sort((a, b) => a.repo.localeCompare(b.repo) || a.family.localeCompare(b.family) || a.cycle - b.cycle || a.id.localeCompare(b.id));
}

// The same line shape the restocker reads: "- READY <id> (repo=..)" or "- CLAIMED <time> <who> <id> (repo=..)".
export const ROUTER_LINE = /^(\s*-\s+)(READY|CLAIMED|RUNNING)\b((?:\s+\S+)*?)\s+([A-Za-z0-9][\w.-]*)(?: r\d+)?\s+\(([^)]*)\)/i;
function routerJobs(text: string): Array<QueueJob & { line: number }> {
  return text.split('\n').flatMap((line, index) => {
    const match = ROUTER_LINE.exec(line), repo = /\brepo\s*=\s*([\w./-]+)/i.exec(match?.[5] ?? '')?.[1];
    return match && repo ? [{ id: match[4]!, repo, queued: match[2]!.toUpperCase() === 'READY', line: index }] : [];
  });
}
export const parked = (row: { id: string; lane: string }): boolean => row.id.startsWith('PARKED-') || row.lane.startsWith('PARKED-');
const jobKey = (job: { id: string; repo: string }): string => `${repoKey(job.repo)}\n${job.id}`;

/** Append to a regular file in the queue directory without following links. */
export async function appendGuarded(path: string, text: string): Promise<void> {
  const handle = await open(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK, 0o600);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('Queue file is not a plain file');
    await handle.writeFile(text);
    await handle.sync();
  } finally { await handle.close(); }
}
const pad = (n: number): string => String(n).padStart(2, '0');
/** The dispatch-events.log clock: local wall time. */
export const eventClock = (d: Date): string => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

export interface SupersedeOptions extends RewriteReadyRowsOptions { runsDir?: string; apply?: boolean }

/** Plan over ready.tsv and router-queue.md; with apply, archive and mark the older cycles. Dry run by default. */
export async function supersedeQueue(opts: SupersedeOptions = {}): Promise<SupersedeReport> {
  const queueDir = join(opts.runsDir ?? defaultRunsDir(), 'queue');
  const absent = (error: unknown): null => { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; };
  const routerPath = join(queueDir, 'router-queue.md');
  const [readyText, routerText] = await Promise.all([readReadyText(join(queueDir, 'ready.tsv')).catch(absent), readFile(routerPath, 'utf8').catch(absent)]);
  if (readyText === null && routerText === null) throw new Error('Queue unavailable');
  const ready = parseReadyRows(readyText ?? '').filter(row => !parked(row));
  const router = routerJobs(routerText ?? '');
  const jobs: QueueJob[] = [...ready.map(row => ({ id: row.id, repo: row.repo, queued: true })), ...router];
  const superseded = planSupersede(jobs);
  const report: SupersedeReport = { schema: 'queue.supersede.v1', applied: false,
    queued: new Set(jobs.filter(job => job.queued).map(jobKey)).size, count: superseded.length, superseded };
  if (!opts.apply || !superseded.length) return report;

  const newer = new Map(superseded.map(job => [jobKey(job), job.supersededBy]));
  const stale = ready.filter(row => newer.has(jobKey(row)));
  const raws = new Set(stale.map(row => row.raw));
  if (raws.size) {
    const archivePath = join(queueDir, SUPERSEDE_ARCHIVE);
    const kept = new Set(((await readFile(archivePath, 'utf8').catch(absent)) ?? '').split('\n'));
    const fresh = [...raws].filter(raw => !kept.has(raw));
    if (fresh.length) await appendGuarded(archivePath, fresh.map(raw => `${raw}\n`).join(''));
  }
  if (routerText !== null) {
    // A claimed line is marked only when its row was waiting in ready.tsv; a running job keeps its line.
    const lines = routerText.split('\n');
    for (const job of router) {
      const by = newer.get(jobKey(job));
      if (by) lines[job.line] = lines[job.line]!.replace(ROUTER_LINE, (all, lead: string, status: string) => `${lead}SUPERSEDED-BY-${by}${all.slice(lead.length + status.length)}`);
    }
    if (lines.join('\n') !== routerText) replaceQueueText(routerPath, routerText, lines.join('\n'));
  }
  const removed = !raws.size || (await rewriteReadyRows(queueDir, rows => rows.filter(row => !raws.has(row.raw)), opts)).verified;
  const staleKeys = new Set(stale.map(jobKey)), at = eventClock((opts.now ?? (() => new Date()))());
  const done = superseded.filter(job => removed || !staleKeys.has(jobKey(job)));
  if (done.length) {
    await appendGuarded(join(queueDir, 'dispatch-events.log'),
      done.map(job => `${at} SUPERSEDED ${job.id} by ${job.supersededBy} repo=${job.repo} src=phm-queue-supersede\n`).join(''));
  }
  report.applied = removed;
  return report;
}

/** One plain line per superseded job, after a one-line summary. */
export function supersedeText(report: SupersedeReport): string[] {
  const n = report.count, jobs = n === 1 ? 'job' : 'jobs';
  const head = !n ? `No older cycles among ${report.queued} queued jobs.`
    : report.applied ? `Archived ${n} older ${jobs}.`
    : `${n} queued ${jobs} ${n === 1 ? 'has' : 'have'} a newer cycle queued. Run phm queue supersede --apply to archive ${n === 1 ? 'it' : 'them'}.`;
  return [head, ...report.superseded.map(job => `${job.id} (${job.repo}) is replaced by ${job.supersededBy}`)];
}
