/**
 * landed-on-master.ts — did a fleet job reach master? Answered from plain git, no gh.
 *
 * Fleet commits carry the job id in the subject (`bridge(RQ-ABC)` or `RQ-ABC` in a squash title),
 * so one `git log origin/master` answers it. A failed fetch or log is "unknown", never
 * "not-landed": we only say a job is not there when we actually looked at fresh master.
 * Only commits inside `since` are searched, so an id older than the window reads "not-landed".
 */
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ledgerAtMs, ledgerEventName, ledgerJobId } from './empty-cause.js';

export type LandedState = 'landed' | 'not-landed' | 'unknown';
export interface LandedResult { id: string; state: LandedState; sha?: string; landedAt?: string; how: 'git-subject' }
export interface LandedOptions {
  /** `git log --since` value such as "24 hours ago" or an ISO time. Default 48 hours. */
  since?: string;
  /** Git checkout to read; defaults to ASHLR_LANDED_REPO, then the current directory. */
  cwd?: string;
  /** Test seam: run git with these args, return stdout, throw on failure. */
  git?: (args: string[]) => string;
}

const DEFAULT_SINCE = '48 hours ago';
const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** The id must stand alone: RQ-AB does not match RQ-ABC, nor RQ-AB-2. */
const idPattern = (id: string) => new RegExp(`(?<![A-Za-z0-9_-])${escape(id)}(?![A-Za-z0-9_-])`);

export function landedOnMaster(ids: readonly string[], opts: LandedOptions = {}): LandedResult[] {
  const unknown = (): LandedResult[] => ids.map(id => ({ id, state: 'unknown', how: 'git-subject' }));
  const cwd = opts.cwd ?? process.env.ASHLR_LANDED_REPO ?? process.cwd();
  const git = opts.git ?? ((args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 60_000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }));
  let log: string;
  try {
    git(['fetch', '--quiet', 'origin', 'master']);
    log = git(['log', 'origin/master', `--since=${opts.since ?? DEFAULT_SINCE}`, '--format=%H%x09%cI%x09%s']);
  } catch { return unknown(); }
  const commits = log.split('\n').filter(Boolean).map(line => {
    const [sha = '', at = '', ...rest] = line.split('\t');
    return { sha, at, subject: rest.join('\t') };
  });
  return ids.map(id => {
    const re = idPattern(id);
    // Log is newest first; the oldest match is when the job first landed.
    const hit = commits.filter(c => re.test(c.subject)).pop();
    return hit ? { id, state: 'landed', sha: hit.sha, landedAt: hit.at, how: 'git-subject' } : { id, state: 'not-landed', how: 'git-subject' };
  });
}

export interface PublishedJob { id: string; publishedAtMs: number }
/** Jobs with a publish event in metrics/jobs.jsonl at or after `sinceMs`. Unreadable ledger: []. */
export async function readPublishedJobs(runsDir: string, sinceMs: number): Promise<PublishedJob[]> {
  let text: string;
  try { text = await readFile(join(runsDir, 'metrics', 'jobs.jsonl'), 'utf8'); } catch { return []; }
  const latest = new Map<string, number>();
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      if (!row || typeof row !== 'object' || ledgerEventName(row) !== 'publish') continue;
      const id = ledgerJobId(row), at = ledgerAtMs(row);
      if (id !== null && at !== null && at >= sinceMs) latest.set(id, Math.max(latest.get(id) ?? 0, at));
    } catch { /* skip damaged line */ }
  }
  return [...latest].map(([id, publishedAtMs]) => ({ id, publishedAtMs })).sort((a, b) => a.publishedAtMs - b.publishedAtMs);
}

const plural = (n: number, unit: string) => `${n} ${unit}`;
const span = (ms: number): string => {
  const min = Math.max(0, Math.round(ms / 60_000));
  return min < 60 ? plural(min, 'min') : min < 2880 ? `${Math.round(min / 60)} h` : `${Math.round(min / 1440)} d`;
};
/** One plain-words line per job. */
export function landedLine(r: LandedResult, publishedAtMs: number | undefined, nowMs: number): string {
  if (r.state === 'unknown') return `${r.id}: can't tell (git could not read origin/master)`;
  if (r.state === 'not-landed') return publishedAtMs === undefined ? `${r.id}: not on master yet` : `${r.id} published ${span(nowMs - publishedAtMs)} ago, not on master yet`;
  const short = (r.sha ?? '').slice(0, 7), at = r.landedAt ? Date.parse(r.landedAt) : NaN;
  const after = publishedAtMs !== undefined && Number.isFinite(at) && at >= publishedAtMs ? ` ${span(at - publishedAtMs)} after its PR` : '';
  return `${r.id} landed${after} (sha ${short})`;
}
