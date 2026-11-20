/**
 * `phm jobs gaps`: turn the "remaining gaps" that no-change jobs write into new work.
 * About one leader job in four ends empty because master already has the feature; each writes the
 * gaps it found in BRIDGE_NOTES.md. This reads those notes from the same stores `phm jobs empty` uses
 * (metrics/jobs.jsonl for the finishes, <wt>/<job>/BRIDGE_NOTES.md for the notes), makes one candidate per
 * gap, drops what is already an open idea, queued, or recently merged (by normalized title), and with
 * `propose` writes the survivors as drop jobs, the same queue `phm ideas queue` uses. No new queue.
 * Anything it cannot read is reported as unknown, never guessed.
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { scrubSecrets } from '../util/scrub.js';
import { stem, words } from './bets-check.js';
import {
  countQueuedDropJobPrompts, DROP_JOB_DEFAULT_REPO, DROP_JOB_QUEUE_LIMIT, DROP_JOB_REPOS, dropJobExists, DropJobExistsError, DropJobValidationError,
  listDropJobs, resolveDropJobRoot, validateDropJob, writeDropJob, type DropJobInput,
} from './drop-job-writer.js';
import { ledgerFinishes } from './empties.js';
import { EMPTY_CAUSE_TAIL_LINES, readText } from './empty-cause.js';
import { readIdeaList } from './bottleneck-ideas.js';

export const JOB_GAPS_SCHEMA = 'jobs.gaps.v1';
export const MAX_GAPS_PER_JOB = 12;
/** Most gaps one tick proposes for a single repo. */
export const MAX_PROPOSED_PER_REPO = 3;
const NOTES_BYTES = 65536;
const LOG_BYTES = 16384;
const TITLE_MAX = 110;
const WHY_MAX = 240;
/** Two titles this alike (shared stems over all stems) count as the same work. */
const SAME_WORK = 0.6;
const MERGE_WINDOW_DAYS = 14;

export type GapDropReason = 'open-idea' | 'queued' | 'recent-merge' | 'duplicate-gap';
export interface GapCandidate { title: string; repo: string | null; sourceJob: string; why: string }
export interface DroppedGap extends GapCandidate { reason: GapDropReason; matched: string | null }
export interface ProposedGap extends GapCandidate { jobId: string | null; queued: boolean; skipped: string | null }
/** `known` is false when the job metrics file cannot be read; `unknownSources` names dedupe sources that could not be read. */
export interface JobGapsReport {
  schema: typeof JOB_GAPS_SCHEMA;
  sinceHours: number;
  known: boolean;
  unknownSources: string[];
  jobsScanned: number;
  jobsWithoutGaps: string[];
  candidates: GapCandidate[];
  dropped: DroppedGap[];
  proposed: ProposedGap[] | null;
}

const HEADING = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const GAP_HEADING = /\b(?:remaining\s+gaps?|gaps?|follow[- ]?ups?|not\s+done|still\s+missing|left\s+to\s+do|unfinished|open\s+items?)\b/i;
const BULLET = /^\s*(?:[-*+]|\d{1,3}[.)])\s+(.*)$/;
const NOTHING = /^(?:none|n\/a|nothing|no gaps?|no remaining gaps?|nil|-)\.?$/i;

const plain = (text: string): string => text
  .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*_~]/g, '').replace(/\s+/g, ' ').trim();

/** Short title: the text before the first " - ", ": " or sentence end, clipped. The full text stays as the why. */
function titleOf(text: string): string {
  const head = text.split(/\s[—–-]\s|:\s|(?<=[.;])\s/)[0]!.replace(/[.;:,]+$/, '').trim();
  return (head.length >= 12 ? head : text).slice(0, TITLE_MAX).trim();
}

/** Pure: each gap listed under a gap-style heading of one BRIDGE_NOTES.md, as `{title, why}`. */
export function extractGaps(notes: string): { title: string; why: string }[] {
  const lines = notes.split(/\r?\n/);
  const found: { title: string; why: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const heading = HEADING.exec(lines[i]!);
    if (!heading || !GAP_HEADING.test(heading[2]!)) continue;
    const level = heading[1]!.length;
    const items: string[] = [];
    const prose: string[] = [];
    let fenced = false;
    for (i++; i < lines.length; i++) {
      const line = lines[i]!;
      if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
      if (fenced) continue;
      const next = HEADING.exec(line);
      if (next && next[1]!.length <= level) { i--; break; }
      const bullet = BULLET.exec(line);
      if (bullet) items.push(bullet[1]!);
      else if (/^\s+\S/.test(line) && items.length) items[items.length - 1] += ` ${line.trim()}`;
      else if (line.trim() && !next) prose.push(line.trim());
    }
    // No bullets: a paragraph under the heading is one gap.
    for (const text of items.length ? items : prose.length ? [prose.join(' ')] : []) {
      const why = plain(text);
      if (!why || NOTHING.test(why)) continue;
      found.push({ title: titleOf(why), why: why.slice(0, WHY_MAX) });
    }
  }
  return found.slice(0, MAX_GAPS_PER_JOB);
}

const PROSE_GAP = /\b(?:gap|gaps|aren['’]?t there|isn['’]?t there|not done|left it|missing)\b/i;
/** A sentence that says there is nothing left ("no gaps", "nothing missing") is not a gap. */
const PROSE_NONE = /\b(?:no|none|nothing|zero|without any)\b[^.]{0,30}\b(?:gaps?|missing)\b|\bnot (?:missing|a gap)\b/i;
export const PROSE_TITLE_MAX = 120;

/** Pure: one candidate per sentence that names a gap in free prose (a job final message only). Headings and code are skipped. */
export function extractProseGaps(text: string): { title: string; why: string }[] {
  const found: { title: string; why: string }[] = [];
  let fenced = false;
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; continue; }
    if (fenced || HEADING.test(line)) continue;
    const body = plain(line.replace(BULLET, '$1'));
    for (const sentence of body.split(/(?<=[.!?])\s+/)) {
      const why = sentence.trim();
      if (why.length < 12 || !PROSE_GAP.test(why) || PROSE_NONE.test(why)) continue;
      found.push({ title: why.slice(0, PROSE_TITLE_MAX).trim(), why: why.slice(0, WHY_MAX) });
    }
  }
  return found;
}

/**
 * Gaps from one job. BRIDGE_NOTES.md counts only under a gap-style heading (a "Remaining gaps" section);
 * a bare "missing" sentence in the notes is ignored. The final message (the last paragraph of the log tail)
 * counts under a heading or as prose. Earlier log lines are never read. Repeats of an earlier gap are dropped.
 */
export function extractAllGaps(notes: string, finalMessage = ''): { title: string; why: string }[] {
  const out: { title: string; why: string }[] = [];
  const add = (gaps: { title: string; why: string }[]): void => {
    for (const gap of gaps) if (!out.some(o => o.title === gap.title || sameWork(o.title, gap.title))) out.push(gap);
  };
  add(extractGaps(notes));
  add(extractGaps(finalMessage));
  add(extractProseGaps(finalMessage));
  return out.slice(0, MAX_GAPS_PER_JOB);
}

/** The last paragraph of a log tail: what the worker said when it finished. */
export function finalMessageOf(tail: string): string {
  const paragraphs = tail.split(/\r?\n\s*\r?\n/).map(p => p.trim()).filter(Boolean);
  return paragraphs.length ? paragraphs[paragraphs.length - 1]! : '';
}

const STOP = new Set('a an the and or of to in on for is are be it its this that with without by from as at not yet still no'.split(' '));
/** The stems of a title's words, stop words dropped; the basis for matching titles. */
export function titleStems(title: string): string[] {
  const out = [...new Set(words(title).filter(w => !STOP.has(w)).map(w => stem(w).replace(/(?<=..)e$/, '')))].sort();
  return out;
}
/** Normalized title: lowercase stems, sorted, one space apart. */
export const normalizeTitle = (title: string): string => titleStems(title).join(' ');
/** True when two titles name the same work. Needs two shared stems so one common word never matches. */
export function sameWork(a: string, b: string): boolean {
  const x = titleStems(a), y = titleStems(b);
  if (!x.length || !y.length) return false;
  if (x.join(' ') === y.join(' ')) return true;
  const shared = x.filter(s => y.includes(s)).length;
  return shared >= 2 && shared / new Set([...x, ...y]).size >= SAME_WORK;
}

const git = promisify(execFile);
/** Subjects of master's recent commits, with the `bridge(RQ-...):` or `type(scope):` prefix removed. */
async function recentMergeTitles(cwd: string): Promise<string[]> {
  const { stdout } = await git('git', ['log', `--since=${MERGE_WINDOW_DAYS}.days`, '--format=%s', '-n', '1500'], { cwd, timeout: 15000, maxBuffer: 4_000_000 });
  return stdout.split('\n').map(s => s.replace(/\s*\(#\d+\)\s*$/, '').replace(/^[a-z]+(?:\([^)]*\))?!?:\s*/i, '').trim()).filter(Boolean);
}

export interface JobGapsDeps {
  runsDir?: string;
  wtDir?: string;
  now?: number;
  /** Repo checkout whose git log supplies recent merges. Defaults to the current directory. */
  repoDir?: string;
  read?: (path: string, max: number) => Promise<string | null>;
  openIdeas?: () => Promise<string[]>;
  queuedWork?: (runsDir: string) => Promise<string[]>;
  mergedTitles?: () => Promise<string[]>;
  write?: (root: string, input: DropJobInput) => Promise<unknown>;
}

/** Each job's repo, from any ledger row that names one. Unknown stays null. */
function ledgerRepos(ledger: string): Map<string, string> {
  const repos = new Map<string, string>();
  for (const line of ledger.split('\n')) {
    if (!line.includes('"repo"')) continue;
    try {
      const row = JSON.parse(line) as Record<string, unknown>;
      const id = typeof row.job === 'string' ? row.job : row.id;
      if (typeof id === 'string' && typeof row.repo === 'string' && /^[A-Za-z0-9._-]{1,80}$/.test(row.repo)) repos.set(id, row.repo);
    } catch { /* skip bad line */ }
  }
  return repos;
}

const GOAL = /^Goal:\s*/i;
async function defaultQueued(runsDir: string): Promise<string[]> {
  const jobs = await listDropJobs(resolveDropJobRoot(runsDir));
  return jobs.map(j => (j.title ?? '').replace(GOAL, '')).filter(Boolean);
}

async function settle(unknown: string[], name: string, source: () => Promise<string[]>): Promise<string[]> {
  try { return await source(); } catch { unknown.push(name); return []; }
}

export function gapJobId(title: string): string {
  return `GAP${createHash('sha256').update(normalizeTitle(title)).digest('hex').slice(0, 10).toUpperCase()}`;
}

export function gapJobBody(gap: GapCandidate): string {
  return scrubSecrets(`Goal: ${gap.title}\n\nWhy: ${gap.why}\nSource: gap feed, from the notes of finished job ${gap.sourceJob}. Re-check master first; if the work is already there, finish with a short note instead of a change.`);
}

export async function readJobGaps(hours: number, opts: { propose?: boolean } & JobGapsDeps = {}): Promise<JobGapsReport> {
  const runsDir = opts.runsDir ?? (process.env.ASHLR_RUNS_DIR?.trim() || join(homedir(), '.ashlr-runs'));
  const wtDir = opts.wtDir ?? (process.env.ASHLR_WT_DIR?.trim() || join(homedir(), 'Projects/ashlrai/wt'));
  const now = opts.now ?? Date.now();
  const read = opts.read ?? readText;
  const report: JobGapsReport = { schema: JOB_GAPS_SCHEMA, sinceHours: hours, known: false, unknownSources: [], jobsScanned: 0, jobsWithoutGaps: [], candidates: [], dropped: [], proposed: null };
  const ledger = await read(join(runsDir, 'metrics', 'jobs.jsonl'), 8 * 1024 * 1024).catch(() => null);
  if (ledger === null) return report;
  report.known = true;
  const repos = ledgerRepos(ledger);
  const finishes = ledgerFinishes(ledger, now, hours).finishes.filter(job => job.empty && !job.skipped);
  report.jobsScanned = finishes.length;

  const raw: GapCandidate[] = [];
  for (let i = 0; i < finishes.length; i += 16) {
    await Promise.all(finishes.slice(i, i + 16).map(async finish => {
      const notes = await read(join(wtDir, finish.id, 'BRIDGE_NOTES.md'), NOTES_BYTES).catch(() => null);
      // The worker's final message is the tail of its log (the same read `phm empties` uses).
      const log = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(finish.id) ? await read(join(runsDir, `${finish.id}.log`), LOG_BYTES).catch(() => null) : null;
      const gaps = extractAllGaps(notes ?? '', log ? finalMessageOf(log.split(/\r?\n/).slice(-EMPTY_CAUSE_TAIL_LINES).join('\n')) : '');
      if (!gaps.length) { report.jobsWithoutGaps.push(finish.id); return; }
      for (const gap of gaps) raw.push({ title: scrubSecrets(gap.title), repo: repos.get(finish.id) ?? null, sourceJob: finish.id, why: scrubSecrets(gap.why) });
    }));
  }
  report.jobsWithoutGaps.sort();
  raw.sort((a, b) => a.sourceJob.localeCompare(b.sourceJob) || a.title.localeCompare(b.title));

  const [open, queued, merged] = await Promise.all([
    settle(report.unknownSources, 'open ideas', opts.openIdeas ?? (async () => (await readIdeaList({ runsDir })).ideas.map(i => i.title))),
    settle(report.unknownSources, 'queued work', () => (opts.queuedWork ?? defaultQueued)(runsDir)),
    settle(report.unknownSources, 'recent merges', opts.mergedTitles ?? (() => recentMergeTitles(opts.repoDir ?? process.cwd()))),
  ]);
  const checks: { reason: GapDropReason; titles: string[] }[] = [{ reason: 'open-idea', titles: open }, { reason: 'queued', titles: queued }, { reason: 'recent-merge', titles: merged }];
  for (const gap of raw) {
    let hit: DroppedGap | null = null;
    for (const { reason, titles } of checks) {
      const match = titles.find(title => sameWork(gap.title, title));
      if (match !== undefined) { hit = { ...gap, reason, matched: match.slice(0, TITLE_MAX) }; break; }
    }
    const twin = hit ? null : report.candidates.find(c => sameWork(c.title, gap.title));
    if (hit) report.dropped.push(hit);
    else if (twin) report.dropped.push({ ...gap, reason: 'duplicate-gap', matched: twin.title });
    else report.candidates.push(gap);
  }
  if (opts.propose) report.proposed = await proposeGaps(report.candidates, runsDir, opts.write);
  return report;
}

/** Repos that have a drop queue: every repo key the drop job header allows. */
export const DROP_QUEUE_REPOS: readonly string[] = DROP_JOB_REPOS;

/**
 * Writes each survivor as a drop job (the queue `phm ideas queue` writes to) with its own repo in the header.
 * Unknown repos are listed as skipped with the reason; each repo gets at most MAX_PROPOSED_PER_REPO per tick.
 * A gap with no known repo goes to phantom, as before.
 */
async function proposeGaps(candidates: GapCandidate[], runsDir: string, write: JobGapsDeps['write']): Promise<ProposedGap[]> {
  const root = resolveDropJobRoot(runsDir);
  const out: ProposedGap[] = [];
  const perRepo = new Map<string, number>();
  for (const gap of candidates) {
    const row: ProposedGap = { ...gap, jobId: null, queued: false, skipped: null };
    out.push(row);
    const repo = gap.repo ?? DROP_JOB_DEFAULT_REPO;
    if (!DROP_QUEUE_REPOS.includes(repo)) { row.skipped = `repo ${repo} is not a known repo`; continue; }
    if ((perRepo.get(repo) ?? 0) >= MAX_PROPOSED_PER_REPO) { row.skipped = `already ${MAX_PROPOSED_PER_REPO} proposed for ${repo} this tick`; continue; }
    const job: DropJobInput = { id: gapJobId(gap.title), repo, lane: 'claude', tier: 'work', body: gapJobBody(gap) };
    row.jobId = job.id;
    const verdict = validateDropJob(job);
    if (!verdict.ok) { row.skipped = `refused: ${verdict.reasons.join(', ')}`; continue; }
    try {
      if (await dropJobExists(root, job.id)) { row.skipped = 'already queued'; continue; }
      if (!write && await countQueuedDropJobPrompts(root) >= DROP_JOB_QUEUE_LIMIT) { row.skipped = 'the job queue is full'; continue; }
      await (write ?? writeDropJob)(root, job);
      row.queued = true;
      perRepo.set(repo, (perRepo.get(repo) ?? 0) + 1);
    } catch (e) {
      row.skipped = e instanceof DropJobExistsError ? 'already queued' : e instanceof DropJobValidationError ? `refused: ${e.reasons.join(', ')}` : 'could not write the job';
    }
  }
  return out;
}

export function jobGapsLines(report: JobGapsReport): string[] {
  if (!report.known) return ['Gaps: unknown. The job metrics file cannot be read.'];
  const lines = [`${report.candidates.length} new ${report.candidates.length === 1 ? 'gap' : 'gaps'} from ${report.jobsScanned} no-change ${report.jobsScanned === 1 ? 'job' : 'jobs'} in the last ${report.sinceHours} hours` +
    (report.dropped.length ? `; ${report.dropped.length} already covered` : '') + (report.jobsWithoutGaps.length ? `; ${report.jobsWithoutGaps.length} listed no gaps` : '')];
  report.candidates.forEach((gap, i) => {
    lines.push(`${i + 1}. ${gap.title} (${gap.repo ?? 'repo unknown'}, from ${gap.sourceJob})`, `   Why: ${gap.why}`);
  });
  for (const row of report.proposed ?? []) lines.push(row.queued ? `Queued ${row.title} as RQ-PHX-${row.jobId}.` : `Not queued: ${row.title} (${row.skipped}).`);
  if (report.candidates.length && !report.proposed) lines.push('Queue them: phm jobs gaps --propose');
  if (report.unknownSources.length) lines.push(`Not checked for duplicates: ${report.unknownSources.join(', ')} (unknown).`);
  return lines;
}
