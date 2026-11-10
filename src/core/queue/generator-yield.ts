import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface GeneratorYieldRow {
  generator: string; jobs: number; prs: number; merged: number;
  emptyRate: number | null; medianDiffLines: number | null; tokensPerMergedPr: number | null;
}
export interface GeneratorYieldReport {
  schema: 'queue.generator-yield.v1'; sinceHours: number; known: boolean; malformedLines: number; generators: GeneratorYieldRow[];
}
type Job = { generator: string | null; explicit: boolean; empty: boolean | null; pr: boolean; merged: boolean; diff: number | null; tokens: number | null };
const string = (v: unknown): string | null => typeof v === 'string' && v.trim() ? v.trim() : null;
const count = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
function generator(id: string): string {
  if (/^FIXUP-/i.test(id)) return 'fixup';
  if (/^RQ-DRAIN-/i.test(id)) return 'drain';
  if (/A\d+Q8$/i.test(id)) return 'filler';
  if (/N9[^\s]*Q8$/i.test(id)) return 'leader';
  return 'unknown';
}
/** Events in the window are grouped by job ID; repeated events never count twice. */
export function generatorYield(raw: string, hours = 24, now = Date.now()): GeneratorYieldReport {
  const jobs = new Map<string, Job>(); let malformedLines = 0;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let value: unknown;
    try { value = JSON.parse(line); } catch { malformedLines++; continue; }
    if (!value || typeof value !== 'object' || Array.isArray(value)) { malformedLines++; continue; }
    const r = value as Record<string, unknown>;
    const id = string(r.job ?? r.job_id ?? r.jobId ?? r.id);
    const timestamp = string(r.ts ?? r.timestamp ?? r.at ?? r.startedAt);
    const at = timestamp ? Date.parse(timestamp) : NaN;
    if (!id || !Number.isFinite(at)) { malformedLines++; continue; }
    if (at < now - hours * 3600000 || at > now) continue;
    const job = jobs.get(id) ?? { generator: null, explicit: false, empty: null, pr: false, merged: false, diff: null, tokens: null };
    const src = string(r.src);
    if (src) { job.generator = src; job.explicit = true; }
    else if (!job.explicit) job.generator = generator(id);
    if (typeof r.empty === 'boolean') job.empty = r.empty;
    if (r.outcome === 'empty') job.empty = true;
    if (string(r.pr ?? r.pr_url ?? r.prUrl) || (r.event === 'publish' && string(r.url))) job.pr = true;
    if (String(r.state ?? r.outcome ?? '').toUpperCase() === 'MERGED' || r.event === 'merged') { job.merged = true; job.pr = true; }
    job.diff = count(r.diff_lines) ?? job.diff;
    job.tokens = count(r.tokens_total ?? r.tokens) ?? job.tokens;
    jobs.set(id, job);
  }
  const groups = new Map<string, Job[]>();
  for (const job of jobs.values()) { const name = job.generator ?? 'unknown'; groups.set(name, [...(groups.get(name) ?? []), job]); }
  const generators = [...groups].map(([name, rows]) => {
    const diffs = rows.map(r => r.diff).filter((n): n is number => n !== null).sort((a, b) => a - b);
    const measured = rows.filter(r => r.empty !== null);
    const merged = rows.filter(r => r.merged);
    const tokensKnown = rows.every(r => r.tokens !== null);
    const mid = Math.floor(diffs.length / 2);
    return { generator: name, jobs: rows.length, prs: rows.filter(r => r.pr).length, merged: merged.length,
      emptyRate: measured.length ? measured.filter(r => r.empty).length / measured.length : null,
      medianDiffLines: diffs.length ? (diffs.length % 2 ? diffs[mid]! : (diffs[mid - 1]! + diffs[mid]!) / 2) : null,
      tokensPerMergedPr: merged.length && tokensKnown ? rows.reduce((sum, r) => sum + r.tokens!, 0) / merged.length : null };
  }).sort((a, b) => a.generator.localeCompare(b.generator));
  return { schema: 'queue.generator-yield.v1', sinceHours: hours, known: true, malformedLines, generators };
}
export async function readGeneratorYield(runsDir = process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'), hours = 24, now = Date.now()): Promise<GeneratorYieldReport> {
  try { return generatorYield(await readFile(join(runsDir, 'metrics', 'jobs.jsonl'), 'utf8'), hours, now); }
  catch { return { schema: 'queue.generator-yield.v1', sinceHours: hours, known: false, malformedLines: 0, generators: [] }; }
}
