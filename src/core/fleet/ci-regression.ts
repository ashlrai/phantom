import type { CloudGh } from '../cloud/pr-actions.js';

const PAGE_SIZE = 100;
const MAX_PAGES = 3;

type Run = { id: number; workflow_id: number; head_branch: string; head_sha: string; event: string;
  status: string; conclusion: string | null; created_at: string };
type Step = { name: string; conclusion: string | null };
type Job = Step & { steps: Step[] };
type Page<T> = { rows: T[]; partial: boolean };

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid GitHub response');
  return value as Record<string, unknown>;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new Error('invalid GitHub response');
  return value;
}
function id(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new Error('invalid GitHub response');
  return value;
}
function conclusion(value: unknown): string | null {
  return value === null ? null : text(value);
}
function run(value: unknown): Run {
  const r = object(value);
  const created = text(r.created_at);
  if (!Number.isFinite(Date.parse(created))) throw new Error('invalid GitHub response');
  return { id: id(r.id), workflow_id: id(r.workflow_id), head_branch: text(r.head_branch),
    head_sha: text(r.head_sha), event: text(r.event), status: text(r.status),
    conclusion: conclusion(r.conclusion), created_at: created };
}
function step(value: unknown): Step {
  const s = object(value);
  return { name: text(s.name), conclusion: conclusion(s.conclusion) };
}
function job(value: unknown): Job {
  const j = object(value);
  if (!Array.isArray(j.steps)) throw new Error('invalid GitHub response');
  return { ...step(j), steps: j.steps.map(step) };
}
async function read(gh: CloudGh, path: string): Promise<unknown> {
  const result = await gh(['api', path]);
  if (!result.ok) throw new Error('GitHub read failed');
  try { return JSON.parse(result.stdout) as unknown; } catch { throw new Error('invalid GitHub response'); }
}
async function pages<T>(gh: CloudGh, path: string, field: string, parse: (value: unknown) => T): Promise<Page<T>> {
  const rows: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const data = object(await read(gh, `${path}${path.includes('?') ? '&' : '?'}per_page=${PAGE_SIZE}&page=${page}`));
    const batch = data[field];
    if (!Array.isArray(batch) || batch.length > PAGE_SIZE ||
        typeof data.total_count !== 'number' || !Number.isSafeInteger(data.total_count) || data.total_count < 0) {
      throw new Error('invalid GitHub response');
    }
    rows.push(...batch.map(parse));
    if (batch.length < PAGE_SIZE) return { rows, partial: rows.length < data.total_count };
    if (rows.length >= data.total_count) return { rows, partial: false };
  }
  return { rows, partial: true };
}

function groups<T extends { name: string }>(items: T[]): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const item of items) result.set(item.name, [...(result.get(item.name) ?? []), item]);
  return result;
}

/** Only compare unique, observed names; retain all ambiguous and unknown observations. */
function compare(target: Job[], baseline: Job[]) {
  const current = groups(target), previous = groups(baseline);
  const newJobs: string[] = [], missingJobs: string[] = [];
  const newlyFailingJobs: string[] = [];
  const newlyFailingSteps: { job: string; step: string }[] = [];
  const ambiguous: { job: string; step?: string }[] = [];
  const unknown: { job: string; step?: string; reason: string }[] = [];
  for (const name of new Set([...current.keys(), ...previous.keys()])) {
    const a = current.get(name) ?? [], b = previous.get(name) ?? [];
    if (a.length > 1 || b.length > 1) { ambiguous.push({ job: name }); continue; }
    if (!a.length) { missingJobs.push(name); continue; }
    if (!b.length) { newJobs.push(name); continue; }
    const now = a[0]!, before = b[0]!;
    if (now.conclusion === null || before.conclusion === null) unknown.push({ job: name, reason: 'unknown conclusion' });
    else if (now.conclusion === 'failure' && before.conclusion !== 'failure') newlyFailingJobs.push(name);
    const cs = groups(now.steps), bs = groups(before.steps);
    for (const stepName of new Set([...cs.keys(), ...bs.keys()])) {
      const x = cs.get(stepName) ?? [], y = bs.get(stepName) ?? [];
      if (x.length > 1 || y.length > 1) { ambiguous.push({ job: name, step: stepName }); continue; }
      if (!x.length || !y.length) { unknown.push({ job: name, step: stepName, reason: 'step missing from one run' }); continue; }
      if (x[0]!.conclusion === null || y[0]!.conclusion === null) {
        unknown.push({ job: name, step: stepName, reason: 'unknown conclusion' });
      } else if (x[0]!.conclusion === 'failure' && y[0]!.conclusion !== 'failure') {
        newlyFailingSteps.push({ job: name, step: stepName });
      }
    }
  }
  return { newlyFailingJobs, newlyFailingSteps, newJobs, missingJobs, ambiguous, unknown };
}

/** Reads are bounded and read-only; partial pages never support definitive comparisons. */
export async function ciRegression(repo: string, runId: number, gh: CloudGh) {
  const root = `repos/${repo}/actions`;
  const target = run(await read(gh, `${root}/runs/${runId}`));
  if (target.id !== runId) throw new Error('target run id mismatch');
  if (target.event !== 'schedule') throw new Error('target run is not scheduled');
  const query = `branch=${encodeURIComponent(target.head_branch)}&event=schedule`;
  const runs = await pages(gh, `${root}/workflows/${target.workflow_id}/runs?${query}`, 'workflow_runs', run);
  const candidates = runs.rows.filter(r => r.id !== target.id && r.workflow_id === target.workflow_id &&
    r.head_branch === target.head_branch && r.event === 'schedule' && r.status === 'completed' &&
    r.conclusion === 'success' && Date.parse(r.created_at) < Date.parse(target.created_at));
  candidates.sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) || b.id - a.id);
  const baseline = candidates[0] ?? null;
  const targetJobs = await pages(gh, `${root}/runs/${target.id}/jobs`, 'jobs', job);
  const baselineJobs = baseline ? await pages(gh, `${root}/runs/${baseline.id}/jobs`, 'jobs', job) : null;
  const partial = runs.partial || targetJobs.partial || (baselineJobs?.partial ?? false);
  const comparison = !partial && baselineJobs ? compare(targetJobs.rows, baselineJobs.rows) : null;
  const status = partial ? 'partial-source' : !baseline ? 'no-baseline' :
    comparison && (comparison.unknown.length || comparison.ambiguous.length) ? 'unknown' : 'complete';
  return { v: 1, repo, status, target, baseline, sources: { runsPartial: runs.partial,
    targetJobsPartial: targetJobs.partial, baselineJobsPartial: baselineJobs?.partial ?? null },
    jobs: { target: targetJobs.rows, baseline: baselineJobs?.rows ?? null }, comparison };
}
