/**
 * Standing selector above the job queue. Candidates are scored
 * `value x leverage / (minutes + usage)`; the learned outcome cells supply the
 * time, usage and merge-rate priors a candidate leaves out. Pure: the caller
 * owns files, the clock and the bus.
 */
import type { OutcomeCellView, OutcomeLearning } from './outcome-learning.js';

export const SELECTOR_SCHEMA = 'routing.selector.v1' as const;
export const DEFAULT_FUND_COUNT = 5;
/** Used when neither the candidate nor the outcome log says how long a job takes. */
export const DEFAULT_MINUTES = 30;
/** Used when neither says what a job costs; same unit as the dispatch log's `usage`. */
export const DEFAULT_USAGE = 0.3;
/** Logged usage runs about 0.04 to 1.2 per job, so one unit weighs as an hour of wall clock. */
export const USAGE_MINUTES = 60;
const PRIOR_MERGE_RATE = 0.5;
const PRIOR_WEIGHT = 2;
const ID = /^RQ-[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const WORD = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const PRIORITIES = ['P0', 'P1', 'P2', 'P3'] as const;

export interface SelectorCandidate {
  id: string;
  scope: string;
  acceptance: string;
  repo: string;
  jobType: string;
  pool: string;
  tier: string;
  priority: (typeof PRIORITIES)[number];
  /** What shipping it is worth. Any positive scale; ranking only compares. */
  value: number;
  /** Multiplier for the work it unblocks or makes cheaper. 1 means none. */
  leverage: number;
  estMinutes: number | null;
  estUsage: number | null;
}

export interface SelectorPick extends SelectorCandidate {
  rank: number;
  score: number;
  minutes: number;
  usage: number;
  mergeRate: number;
  /** value x leverage x learned good-merge rate: what funding it is expected to return. */
  predictedValue: number;
  /** Where minutes/usage came from, so a pick is explainable. */
  basis: 'candidate' | 'learned' | 'default';
}

export interface SelectorResult {
  schema: typeof SELECTOR_SCHEMA;
  considered: number;
  rejected: number;
  skipped: number;
  picks: SelectorPick[];
}

const num = (v: unknown): number | null => (typeof v === 'number' || typeof v === 'string') && String(v).trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null;
const text = (v: unknown, max: number): string => (typeof v === 'string' ? v : '')
  // eslint-disable-next-line no-control-regex -- queue lines are one line of plain text.
  .replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

const word = (v: unknown, fallback: string): string => (typeof v === 'string' && WORD.test(v) ? v : fallback);

/** One JSON object per line; bad rows are counted, never thrown. */
export function parseCandidates(input: string): { candidates: SelectorCandidate[]; rejected: number } {
  const seen = new Set<string>();
  const candidates: SelectorCandidate[] = [];
  let rejected = 0;
  for (const line of input.split(/\r?\n/)) {
    if (line.trim() === '') continue;
    let row: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('row');
      row = parsed as Record<string, unknown>;
    } catch { rejected++; continue; }
    const id = row['id'];
    const value = num(row['value']);
    const leverage = num(row['leverage'] ?? 1);
    const minutes = row['estMinutes'] === undefined ? null : num(row['estMinutes']);
    const usage = row['estUsage'] === undefined ? null : num(row['estUsage']);
    const repo = row['repo'], jobType = row['jobType'] ?? 'work';
    const priority = (row['priority'] ?? 'P2') as SelectorCandidate['priority'];
    const scope = text(row['scope'], 400);
    if (typeof id !== 'string' || !ID.test(id) || seen.has(id) || value === null || value <= 0
      || leverage === null || leverage <= 0 || (row['estMinutes'] !== undefined && (minutes === null || minutes <= 0))
      || (row['estUsage'] !== undefined && (usage === null || usage < 0))
      || typeof repo !== 'string' || !WORD.test(repo) || typeof jobType !== 'string' || !WORD.test(jobType)
      || !PRIORITIES.includes(priority) || scope === '') { rejected++; continue; }
    seen.add(id);
    candidates.push({
      id, scope, acceptance: text(row['acceptance'], 400), repo, jobType, priority, value, leverage,
      pool: word(row['pool'], 'claude'),
      tier: word(row['tier'], 'work'),
      estMinutes: minutes, estUsage: usage,
    });
  }
  return { candidates, rejected };
}

/** Attempt-weighted view over the cells that match this repo and job type. */
function learnedPrior(cells: readonly OutcomeCellView[], repo: string, jobType: string) {
  let attempts = 0, good = 0, usage = 0, timed = 0, minutes = 0;
  for (const c of cells) {
    if (c.repo !== repo || c.jobType !== jobType) continue;
    attempts += c.attempts; good += c.goodMerges; usage += c.usage;
    if (c.meanMinutesToMerge !== null && c.merges > 0) { timed += c.merges; minutes += c.meanMinutesToMerge * c.merges; }
  }
  return {
    // Smoothed so one lucky merge does not read as certainty.
    mergeRate: (good + PRIOR_MERGE_RATE * PRIOR_WEIGHT) / (attempts + PRIOR_WEIGHT),
    usage: attempts > 0 ? usage / attempts : null,
    minutes: timed > 0 ? minutes / timed : null,
  };
}

export function rankCandidates(
  candidates: readonly SelectorCandidate[],
  learning: Pick<OutcomeLearning, 'cells'>,
  opts: { count?: number; exclude?: ReadonlySet<string>; rejected?: number } = {},
): SelectorResult {
  const count = Math.max(0, opts.count ?? DEFAULT_FUND_COUNT);
  const open = candidates.filter((c) => !opts.exclude?.has(c.id));
  const scored = open.map((c): SelectorPick => {
    const prior = learnedPrior(learning.cells, c.repo, c.jobType);
    const minutes = c.estMinutes ?? prior.minutes ?? DEFAULT_MINUTES;
    const usage = c.estUsage ?? prior.usage ?? DEFAULT_USAGE;
    const basis = c.estMinutes !== null && c.estUsage !== null ? 'candidate'
      : c.estMinutes !== null || c.estUsage !== null || prior.minutes !== null || prior.usage !== null ? 'learned' : 'default';
    return {
      ...c, rank: 0, minutes, usage, mergeRate: prior.mergeRate, basis,
      score: (c.value * c.leverage) / (minutes + usage * USAGE_MINUTES),
      predictedValue: c.value * c.leverage * prior.mergeRate,
    };
  });
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  const picks = scored.slice(0, count).map((p, i) => ({ ...p, rank: i + 1 }));
  return {
    schema: SELECTOR_SCHEMA, considered: candidates.length, rejected: opts.rejected ?? 0,
    skipped: candidates.length - open.length, picks,
  };
}

/** The line `docs/QUEUE.md` imports: fields in one balanced group, scope then acceptance. */
export function readyLine(p: SelectorCandidate): string {
  const body = p.acceptance === '' ? p.scope : `${p.scope} Acceptance: ${p.acceptance}`;
  return `- READY ${p.id} (${p.priority}, pool=${p.pool}, tier=${p.tier}, repo=${p.repo}): ${body.replace(/[()]/g, ' ').replace(/\s+/g, ' ')}`;
}

export interface PickRecord {
  at: string;
  rank: number;
  id: string;
  repo: string;
  jobType: string;
  score: number;
  predictedValue: number;
  mergeRate: number;
  minutes: number;
  usage: number;
  basis: SelectorPick['basis'];
}

export function pickRecords(result: SelectorResult, at: Date): PickRecord[] {
  return result.picks.map((p) => ({
    at: at.toISOString(), rank: p.rank, id: p.id, repo: p.repo, jobType: p.jobType, score: p.score,
    predictedValue: p.predictedValue, mergeRate: p.mergeRate, minutes: p.minutes, usage: p.usage, basis: p.basis,
  }));
}

/** Ids already funded in a picks.jsonl body; they are not funded twice. */
export function fundedIds(picksText: string): Set<string> {
  const ids = new Set<string>();
  for (const line of picksText.split(/\r?\n/)) {
    try {
      const id = (JSON.parse(line) as { id?: unknown }).id;
      if (typeof id === 'string') ids.add(id);
    } catch { /* a torn line never blocks a run */ }
  }
  return ids;
}
