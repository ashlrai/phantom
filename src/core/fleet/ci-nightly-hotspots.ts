import { tmpdir } from 'node:os';
import { defaultGitRunner } from '../verse/git-ops.js';
import type { CloudGh } from '../cloud/pr-actions.js';

// Limits bound both API traffic and report size. A full last page is reported as truncated.
const PAGE_SIZE = 10;
const RUN_PAGES = 2;
const JOB_PAGE_SIZE = 100;
const JOB_PAGES = 3;
const ATTEMPTS = 5;
type Step = { name: string; number: number; status: string; conclusion: string | null; started_at: string | null; completed_at: string | null };
type Job = { id: number; run_id: number; run_attempt: number; name: string; labels: string[]; status: string; conclusion: string | null; runner_id: number | null; created_at: string | null; started_at: string | null; completed_at: string | null; steps: Step[] };
type Run = { id: number; run_attempt: number; name: string; path: string; status: string; conclusion: string | null; run_started_at: string | null; updated_at: string | null };
type Page<T> = { total_count: number; workflow_runs?: T[]; jobs?: T[] };

export const defaultNightlyGh: CloudGh = async args => {
  const r = await defaultGitRunner('gh', args, { cwd: tmpdir(), timeoutMs: 60_000, maxStdoutBytes: 4 * 1024 * 1024 });
  return { ok: r.code === 0 && !r.timedOut && !r.truncated, stdout: r.stdout, stderr: r.stderr };
};

// A failed or malformed read is never converted to an empty result. Do not echo API errors.
async function get<T>(gh: CloudGh, endpoint: string): Promise<T> {
  let result: Awaited<ReturnType<CloudGh>>;
  try { result = await gh(['api', endpoint]); } catch { throw new Error(`GET ${endpoint} failed`); }
  if (!result.ok) throw new Error(`GET ${endpoint} failed`);
  try { return JSON.parse(result.stdout) as T; } catch { throw new Error(`GET ${endpoint} returned invalid JSON`); }
}
function elapsed(start: string | null | undefined, end: string | null | undefined): number | null {
  if (!start || !end) return null;
  const a = Date.parse(start), b = Date.parse(end);
  return Number.isFinite(a) && Number.isFinite(b) && b >= a ? b - a : null;
}
const positive = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) > 0;

async function pages<T>(gh: CloudGh, base: string, key: 'workflow_runs' | 'jobs', size: number, limit: number) {
  const rows: T[] = [];
  let total: number | null = null;
  let fetched = 0;
  for (let page = 1; page <= limit; page++) {
    const data = await get<Page<T>>(gh, `${base}${base.includes('?') ? '&' : '?'}per_page=${size}&page=${page}`);
    const values = data?.[key];
    if (!Array.isArray(values) || !Number.isSafeInteger(data.total_count) || data.total_count < 0 || (total !== null && total !== data.total_count)) {
      throw new Error(`GET ${base} returned inconsistent pagination`);
    }
    total = data.total_count;
    fetched++;
    rows.push(...values);
    if (rows.length > total) throw new Error(`GET ${base} returned inconsistent pagination`);
    if (values.length < size && rows.length < total) throw new Error(`GET ${base} returned an incomplete page`);
    if (values.length < size || rows.length >= total) break;
  }
  return { rows, total: total ?? 0, pages: fetched, complete: rows.length === total };
}

export async function readCiNightly(repo: string, gh: CloudGh = defaultNightlyGh) {
  const errors: string[] = [];
  const runs: Array<{
    id: number; attempt: number; workflow: string; path: string; conclusion: string | null;
    startedAt: string | null; completedAt: string | null; wallMs: number | null; url: string;
    jobsComplete: boolean; jobsTotal: number | null; jobPages: number; jobs: ReturnType<typeof measureJob>[];
  }> = [];
  let listing: { total: number | null; pages: number; complete: boolean } = { total: null, pages: 0, complete: false };
  try {
    const found = await pages<Run>(gh, `repos/${repo}/actions/runs?event=schedule&status=completed`, 'workflow_runs', PAGE_SIZE, RUN_PAGES);
    listing = { total: found.total, pages: found.pages, complete: found.complete };
    const seen = new Set<number>();
    for (const latest of found.rows) {
      if (!positive(latest.id) || !positive(latest.run_attempt) || seen.has(latest.id) || latest.status !== 'completed') {
        errors.push('Invalid or duplicate scheduled run metadata'); continue;
      }
      seen.add(latest.id);
      if (latest.run_attempt > ATTEMPTS) errors.push(`Run ${latest.id} has more than ${ATTEMPTS} attempts; older attempts omitted`);
      for (let attempt = Math.max(1, latest.run_attempt - ATTEMPTS + 1); attempt <= latest.run_attempt; attempt++) {
        try {
          const run = await get<Run>(gh, `repos/${repo}/actions/runs/${latest.id}/attempts/${attempt}`);
          if (run.id !== latest.id || run.run_attempt !== attempt || run.status !== 'completed' || typeof run.name !== 'string' || typeof run.path !== 'string') throw new Error(`Invalid run ${latest.id} attempt ${attempt} metadata`);
          const entry = { id: run.id, attempt, workflow: run.name, path: run.path, conclusion: run.conclusion ?? null,
            startedAt: run.run_started_at ?? null, completedAt: run.updated_at ?? null,
            wallMs: elapsed(run.run_started_at, run.updated_at), url: `https://github.com/${repo}/actions/runs/${run.id}/attempts/${attempt}`,
            jobsComplete: false, jobsTotal: null as number | null, jobPages: 0, jobs: [] as ReturnType<typeof measureJob>[] };
          runs.push(entry);
          const jobPage = await pages<Job>(gh, `repos/${repo}/actions/runs/${run.id}/attempts/${attempt}/jobs`, 'jobs', JOB_PAGE_SIZE, JOB_PAGES);
          entry.jobsTotal = jobPage.total; entry.jobPages = jobPage.pages; entry.jobsComplete = jobPage.complete;
          if (!jobPage.complete) errors.push(`Run ${run.id} attempt ${attempt} jobs truncated`);
          const jobIds = new Set<number>();
          for (const job of jobPage.rows) {
            if (!positive(job.id) || jobIds.has(job.id) || job.run_id !== run.id || job.run_attempt !== attempt || typeof job.name !== 'string') {
              entry.jobsComplete = false; errors.push(`Invalid or duplicate job in run ${run.id} attempt ${attempt}`); continue;
            }
            jobIds.add(job.id); entry.jobs.push(measureJob(repo, run, job));
          }
        } catch (error) { errors.push(error instanceof Error ? error.message : 'Run read failed'); }
      }
    }
  } catch (error) { errors.push(error instanceof Error ? error.message : 'Scheduled run read failed'); }
  const jobs = runs.flatMap(run => run.jobs);
  const groups = new Map<string, typeof jobs>();
  for (const job of jobs) {
    // Rotation selection happens at execution time, and is not supplied by the jobs API.
    const separate = job.labels.length === 0 || job.name.startsWith('Mac exhaustive (');
    const key = JSON.stringify([job.workflow, job.path, job.name, job.labels, separate ? `${job.runId}/${job.attempt}` : null]);
    groups.set(key, [...(groups.get(key) ?? []), job]);
  }
  const cohorts = [...groups.values()].map(group => {
    const measured = group.filter(j => j.executionMs !== null);
    return { workflow: group[0]!.workflow, path: group[0]!.path, job: group[0]!.name, labels: group[0]!.labels,
      comparison: group[0]!.name.startsWith('Mac exhaustive (') ? 'rotation slice unknown; separate observation' : group[0]!.labels.length ? 'matching job and labels' : 'runner labels unknown; separate observation',
      samples: group.length, measuredSamples: measured.length, unknownTiming: group.length - measured.length,
      runnerMinutes: measured.length ? measured.reduce((sum, j) => sum + j.executionMs!, 0) / 60_000 : null,
      failures: group.filter(j => j.conclusion === 'failure').length, cancelled: group.filter(j => j.conclusion === 'cancelled').length,
      retryJobs: group.filter(j => j.attempt > 1).length,
      minExecutionMs: measured.length ? Math.min(...measured.map(j => j.executionMs!)) : null,
      maxExecutionMs: measured.length ? Math.max(...measured.map(j => j.executionMs!)) : null };
  }).sort((a, b) => (b.runnerMinutes ?? -1) - (a.runnerMinutes ?? -1));
  return { schemaVersion: 1, repo, evidence: runs.length ? 'observed' : errors.length || !listing.complete ? 'unknown' : 'none',
    listing, limits: { runPages: RUN_PAGES, runsPerPage: PAGE_SIZE, jobPages: JOB_PAGES, jobsPerPage: JOB_PAGE_SIZE, attemptsPerRun: ATTEMPTS },
    errors, runs: runs.map(run => ({ ...run,
      observedRunnerMinutes: run.jobs.some(j => j.executionMs !== null) ? run.jobs.reduce((sum, j) => sum + (j.executionMs ?? 0), 0) / 60_000 : null,
      unknownJobTiming: run.jobs.filter(j => j.executionMs === null).length,
    })), cohorts, longestJobs: [...jobs].filter(j => j.executionMs !== null).sort((a, b) => b.executionMs! - a.executionMs!).slice(0, 10) };
}

function measureJob(repo: string, run: Run, job: Job) {
  const steps = Array.isArray(job.steps) ? job.steps : [];
  const started = Date.parse(job.started_at ?? '');
  const completed = Date.parse(job.completed_at ?? '');
  const executed = positive(job.runner_id) && job.status === 'completed' && Number.isFinite(started) && Number.isFinite(completed) && completed >= started && steps.some(step => {
    const time = Date.parse(step.started_at ?? '');
    return step.conclusion !== 'skipped' && ['completed', 'in_progress'].includes(step.status) && Number.isFinite(time) && time >= started && time <= completed;
  });
  const url = `https://github.com/${repo}/actions/runs/${run.id}/job/${job.id}`;
  return { runId: run.id, attempt: run.run_attempt, workflow: run.name, path: run.path, id: job.id, name: job.name,
    labels: Array.isArray(job.labels) && job.labels.length && job.labels.every(l => typeof l === 'string' && l.trim()) ? [...new Set(job.labels)].sort() : [],
    conclusion: job.conclusion ?? null, url, startedAt: job.started_at ?? null, completedAt: job.completed_at ?? null,
    executionMs: executed ? elapsed(job.started_at, job.completed_at) : null,
    queueMs: executed ? elapsed(job.created_at, job.started_at) : null,
    slowestSteps: steps.filter(s => typeof s.name === 'string' && positive(s.number)).map(s => ({ name: s.name, conclusion: s.conclusion ?? null,
      durationMs: elapsed(s.started_at, s.completed_at), url: `${url}#step:${s.number}:1` }))
      .sort((a, b) => (b.durationMs ?? -1) - (a.durationMs ?? -1)).slice(0, 5) };
}
