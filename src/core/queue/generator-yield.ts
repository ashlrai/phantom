import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface GenerationDecision {
  job: string; src: string; event: 'drafted' | 'rejected';
  reason?: 'duplicate' | 'already_completed' | 'already_queued_or_completed' | 'stopped_family' | 'missing_capability' | 'hourly_cap';
}
export interface GeneratorYieldRow {
  generator: string; jobs: number; prs: number; merged: number;
  drafted: number; rejected: number; launched: number; rejections: Record<string, number>;
  emptyRate: number | null; medianDiffLines: number | null; tokensPerMergedPr: number | null;
}
export interface GeneratorYieldReport {
  schema: 'queue.generator-yield.v1'; sinceHours: number; known: boolean; jobsKnown: boolean; generationKnown: boolean; malformedLines: number; generators: GeneratorYieldRow[];
}
type Job = { generator: string | null; explicit: boolean; empty: boolean | null; pr: boolean; merged: boolean; diff: number | null; tokens: number | null;
  launched: boolean };
const string = (v: unknown): string | null => typeof v === 'string' && v.trim() ? v.trim() : null;
const count = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
/** jobs.jsonl field dialects, the same sets dispatchd `_vc_pick` accepts:
 * ids job|job_id|jobId|id, events event|type|kind, phases
 * state|outcome|status plus producer aliases, timestamps
 * ts|timestamp|at|startedAt|time|mergedAt|closedAt|recordedAt|updatedAt, and
 * PR links pr|pr_url|prUrl|url|html_url. */
const JOB_ID_KEYS = ['job', 'job_id', 'jobId', 'id'] as const;
const EVENT_KEYS = ['event', 'type', 'kind'] as const;
const PHASE_KEYS = ['state', 'outcome', 'status', 'phase', 'result', 'conclusion'] as const;
const TS_KEYS = ['ts', 'timestamp', 'at', 'startedAt', 'time', 'mergedAt', 'closedAt', 'recordedAt', 'updatedAt'] as const;
const PR_KEYS = ['pr', 'pr_url', 'prUrl', 'url', 'html_url'] as const;
const pickString = (r: Record<string, unknown>, keys: readonly string[]): string | null => {
  for (const key of keys) {
    const value = string(r[key]);
    if (value !== null) return value;
  }
  return null;
};
function generator(id: string): string {
  if (/^FIXUP-/i.test(id)) return 'fixup';
  if (/^RQ-DRAIN-/i.test(id)) return 'drain';
  if (/A\d+Q8$/i.test(id)) return 'filler';
  if (/N9[^\s]*Q8$/i.test(id)) return 'leader';
  return 'unknown';
}
/** Events in the window are grouped by job ID; repeated events never count twice. */
export function generatorYield(raw: string, hours = 24, now = Date.now(), decisions = ''): GeneratorYieldReport {
  const jobs = new Map<string, Job>(); let malformedLines = 0;
  const drafts = new Map<string, string>();
  const generation = new Map<string, Map<string, { drafted: boolean; reasons: Set<string> }>>();
  const rows: { id: string; at: number; row: Record<string, unknown> }[] = [];
  const since = now - hours * 3600000;
  for (const line of `${raw}\n${decisions}`.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { malformedLines++; continue; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) { malformedLines++; continue; }
    const r = value as Record<string, unknown>;
    const id = pickString(r, JOB_ID_KEYS);
    const timestamp = pickString(r, TS_KEYS);
    const at = timestamp ? Date.parse(timestamp) : NaN;
    if (!id || !Number.isFinite(at)) { malformedLines++; continue; }
    if (at < since || at > now) continue;
    rows.push({ id, at, row: r });
  }
  // Late receipts can be appended out of order. Stable sorting preserves
  // ledger order when receipts share a timestamp.
  for (const { id, row: r } of rows.sort((a, b) => a.at - b.at)) {
    const event = pickString(r, EVENT_KEYS)?.toLowerCase();
    if (event === 'drafted' || event === 'rejected') {
      const source = string(r.src) ?? 'unknown', group = generation.get(source) ?? new Map<string, { drafted: boolean; reasons: Set<string> }>();
      const decision = group.get(id) ?? { drafted: false, reasons: new Set<string>() };
      if (event === 'drafted') { decision.drafted = true; drafts.set(id, source); }
      else decision.reasons.add(string(r.reason) ?? 'unknown');
      group.set(id, decision); generation.set(source, group); continue;
    }
    const job = jobs.get(id) ?? { generator: null, explicit: false, empty: null, pr: false, merged: false, diff: null, tokens: null, launched: false };
    const src = string(r.src);
    if (src) { job.generator = src; job.explicit = true; }
    else if (!job.explicit) job.generator = generator(id);
    const phase = pickString(r, PHASE_KEYS);
    if (event === 'launch' || event === 'launched') job.launched = true;
    if (typeof r.empty === 'boolean') job.empty = r.empty;
    if (phase?.toLowerCase() === 'empty') job.empty = true;
    if (pickString(r, PR_KEYS) !== null) job.pr = true;
    if (phase?.toUpperCase() === 'MERGED' || event?.toLowerCase() === 'merged') { job.merged = true; job.pr = true; }
    job.diff = count(r.diff_lines) ?? job.diff;
    job.tokens = count(r.tokens_total ?? r.tokens) ?? job.tokens;
    jobs.set(id, job);
  }
  const groups = new Map<string, Job[]>();
  for (const [id, job] of jobs) { const name = drafts.get(id) ?? job.generator ?? 'unknown'; groups.set(name, [...(groups.get(name) ?? []), job]); }
  const generators = [...new Set([...groups.keys(), ...generation.keys()])].map(name => {
    const rows = groups.get(name) ?? [], decisions = [...(generation.get(name)?.values() ?? [])];
    const diffs = rows.map(r => r.diff).filter((n): n is number => n !== null).sort((a, b) => a - b);
    const measured = rows.filter(r => r.empty !== null);
    const merged = rows.filter(r => r.merged);
    const tokensKnown = rows.every(r => r.tokens !== null);
    const mid = Math.floor(diffs.length / 2);
    return { generator: name, jobs: rows.length, prs: rows.filter(r => r.pr).length, merged: merged.length,
      drafted: decisions.filter(r => r.drafted).length, rejected: decisions.filter(r => r.reasons.size).length, launched: rows.filter(r => r.launched).length,
      rejections: Object.fromEntries([...new Set(decisions.flatMap(r => [...r.reasons]))].sort().map(reason => [reason, decisions.filter(r => r.reasons.has(reason)).length])),
      emptyRate: measured.length ? measured.filter(r => r.empty).length / measured.length : null,
      medianDiffLines: diffs.length ? (diffs.length % 2 ? diffs[mid]! : (diffs[mid - 1]! + diffs[mid]!) / 2) : null,
      tokensPerMergedPr: merged.length && tokensKnown ? rows.reduce((sum, r) => sum + r.tokens!, 0) / merged.length : null };
  }).sort((a, b) => a.generator.localeCompare(b.generator));
  return { schema: 'queue.generator-yield.v1', sinceHours: hours, known: true, jobsKnown: true, generationKnown: true, malformedLines, generators };
}
export async function readGeneratorYield(runsDir = process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'), hours = 24, now = Date.now()): Promise<GeneratorYieldReport> {
  try {
    const [jobs, decisions] = await Promise.all([
      readFile(join(runsDir, 'metrics', 'jobs.jsonl'), 'utf8').catch(e => { if (e.code === 'ENOENT') return null; throw e; }),
      readFile(join(runsDir, 'metrics', 'generation.jsonl'), 'utf8').catch(e => { if (e.code === 'ENOENT') return null; throw e; }),
    ]);
    return { ...generatorYield(jobs ?? '', hours, now, decisions ?? ''), known: jobs !== null || decisions !== null, jobsKnown: jobs !== null, generationKnown: decisions !== null };
  }
  catch { return { schema: 'queue.generator-yield.v1', sinceHours: hours, known: false, jobsKnown: false, generationKnown: false, malformedLines: 0, generators: [] }; }
}
