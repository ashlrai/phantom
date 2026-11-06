/** Read-only, bounded GitHub Actions facts. Classification never reads logs. */
import { assertRepo, defaultGh, type Gh } from '../autopilot/github.js';

export type CiRunLite = { id: number; name: string; event: string; headBranch: string; prNumber: number | null; status: string; conclusion: string | null; createdAt: string; htmlUrl: string };
export type CiFailureClass = 'bind-artifact' | 'code' | null;
type Job = { name: string; conclusion: string | null; steps: Array<{ name: string; conclusion: string | null }> };
export interface CiRunFactsV1 {
  v: 1; generatedAt: string; repo: string | null; windowHours: number; available: boolean; reason: string | null; total: number;
  byEvent: { pull_request: number; push: number; schedule: number; merge_group: number; workflow_dispatch: number; other: number };
  byWorkflow: Array<{ name: string; total: number; failed: number }>;
  failures: { total: number; bindArtifact: number; code: number; unclassified: number };
  daily: { runId: number; conclusion: string | null; createdAt: string; failedJobs: string[]; url: string } | null;
  recent: Array<{ runId: number; workflow: string; event: string; headBranch: string; prNumber: number | null; conclusion: string | null; status: string; failureClass: CiFailureClass; createdAt: string; url: string }>;
}
export function classifyFailedJobs(jobs: Job[]): CiFailureClass {
  const failed = jobs.filter(j => j.conclusion === 'failure');
  if (!failed.length) return null;
  return failed.every(j => {
    const steps = j.steps.filter(s => s.conclusion === 'failure');
    return steps.length > 0 && (steps.every(s => s.name === 'Bind candidate source')
      || (j.name === 'Merge Gate' && steps.length === 1 && steps[0]!.name === 'Require selected CI lane'));
  }) ? 'bind-artifact' : 'code';
}
// Canonical Actions links only: never propagate credentials or query strings.
function runUrl(repo: string | null, id: number): string {
  return repo && /^[\w.-]+\/[\w.-]+$/.test(repo) && Number.isSafeInteger(id) ? `https://github.com/${repo}/actions/runs/${id}` : '';
}
export function summarizeCiRuns(runs: CiRunLite[], classes: Map<number, CiFailureClass>, opts: { windowHours: number; nowMs: number; repo: string | null }): CiRunFactsV1 {
  const sorted = runs.filter(r => Date.parse(r.createdAt) >= opts.nowMs - opts.windowHours * 3600000 && Date.parse(r.createdAt) <= opts.nowMs)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id);
  const byEvent: CiRunFactsV1['byEvent'] = { pull_request: 0, push: 0, schedule: 0, merge_group: 0, workflow_dispatch: 0, other: 0 };
  const workflows = new Map<string, { name: string; total: number; failed: number }>();
  const failures = { total: 0, bindArtifact: 0, code: 0, unclassified: 0 };
  for (const r of sorted) {
    const key = Object.hasOwn(byEvent, r.event) ? r.event as keyof typeof byEvent : 'other';
    byEvent[key]++;
    const wf = workflows.get(r.name) ?? { name: r.name, total: 0, failed: 0 };
    wf.total++;
    if (r.conclusion === 'failure') {
      wf.failed++; failures.total++;
      const c = classes.get(r.id);
      if (c === 'bind-artifact') failures.bindArtifact++;
      else if (c === 'code') failures.code++;
      else failures.unclassified++;
    }
    workflows.set(r.name, wf);
  }
  const daily = sorted.find(r => r.name === 'CI' && r.event === 'schedule' && r.headBranch === 'master');
  return { v: 1, generatedAt: new Date(opts.nowMs).toISOString(), repo: opts.repo, windowHours: opts.windowHours, available: true, reason: null,
    total: sorted.length, byEvent, byWorkflow: [...workflows.values()].sort((a, b) => a.name.localeCompare(b.name)), failures,
    daily: daily ? { runId: daily.id, conclusion: daily.conclusion, createdAt: daily.createdAt, failedJobs: [], url: runUrl(opts.repo, daily.id) } : null,
    recent: sorted.slice(0, 100).map(r => ({ runId: r.id, workflow: r.name, event: r.event, headBranch: r.headBranch, prNumber: r.prNumber, conclusion: r.conclusion, status: r.status, failureClass: r.conclusion === 'failure' ? classes.get(r.id) ?? null : null, createdAt: r.createdAt, url: runUrl(opts.repo, r.id) })) };
}
export async function readCiRunFacts(opts: { repo: string; windowHours?: number; gh?: Gh; nowMs?: number; maxClassify?: number }): Promise<CiRunFactsV1> {
  const nowMs = opts.nowMs ?? Date.now();
  const windowHours = Math.min(168, Math.max(1, Math.trunc(opts.windowHours ?? 24) || 24));
  const runs: CiRunLite[] = [];
  const classes = new Map<number, CiFailureClass>();
  const seen = new Set<number>();
  let listingCapped = false;
  const jobsByRun = new Map<number, Job[]>();
  let publicRepo: string | null = null;
  const summarize = () => summarizeCiRuns(runs, classes, { nowMs, windowHours, repo: publicRepo });
  try {
    const repo = assertRepo(opts.repo);
    publicRepo = repo;
    const gh = opts.gh ?? defaultGh;
    const api = async (path: string) => JSON.parse(await gh(['api', '-H', 'Accept: application/vnd.github+json', path]));
    const since = new Date(nowMs - windowHours * 3600000).toISOString();
    for (let page = 1; page <= 3; page++) {
      const raw = await api(`repos/${repo}/actions/runs?per_page=100&created=>=${since}&page=${page}`);
      if (!Array.isArray(raw.workflow_runs)) throw new Error('Invalid response');
      for (const r of raw.workflow_runs) {
        if (seen.has(r.id)) continue;
        seen.add(r.id);
        runs.push({ id: r.id, name: r.name ?? '', event: r.event, headBranch: r.head_branch ?? '', prNumber: r.pull_requests?.[0]?.number ?? null, status: r.status, conclusion: r.conclusion ?? null, createdAt: r.created_at, htmlUrl: '' });
      }
      if (raw.workflow_runs.length < 100) break;
      if (page === 3) listingCapped = true;
    }
    const ordered = [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id);
    const daily = ordered.find(r => r.name === 'CI' && r.event === 'schedule' && r.headBranch === 'master');
    const selected = ordered.filter(r => r.conclusion === 'failure').slice(0, Math.max(0, Math.trunc(opts.maxClassify ?? 40)));
    const ids = new Set(selected.map(r => r.id));
    if (daily) ids.add(daily.id);
    // Parallel reads keep a cold console request within its interactive budget.
    await Promise.all([...ids].map(async id => {
      const jobs: Job[] = [];
      for (let page = 1; page <= 3; page++) {
        const raw = await api(`repos/${repo}/actions/runs/${id}/jobs?per_page=100&page=${page}`);
        if (!Array.isArray(raw.jobs)) throw new Error('Invalid response');
        jobs.push(...raw.jobs);
        if (raw.jobs.length < 100) break;
        if (page === 3) throw new Error('Incomplete jobs');
      }
      jobsByRun.set(id, jobs);
      if (selected.some(r => r.id === id)) classes.set(id, classifyFailedJobs(jobs));
    }));
    const result = summarize();
    if (result.daily) result.daily.failedJobs = (jobsByRun.get(result.daily.runId) ?? []).filter(j => j.conclusion === 'failure').map(j => j.name);
    if (listingCapped) result.reason = 'Run listing limited to three pages.';
    return result;
  } catch {
    return { ...summarize(), available: false, reason: 'GitHub Actions facts could not be read completely.' };
  }
}
