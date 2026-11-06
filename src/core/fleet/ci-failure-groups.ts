import { tmpdir } from 'node:os';
import type { CloudGh } from '../cloud/pr-actions.js';
import { defaultGitRunner } from '../verse/git-ops.js';

// Hard limits apply independently of data supplied by GitHub.
const RUN_PAGES = 2, RUN_PAGE_SIZE = 25, JOB_PAGES = 2, JOB_PAGE_SIZE = 100, ATTEMPTS = 3;
export const defaultCiGh: CloudGh = async (args) => {
  const r = await defaultGitRunner('gh', args, { cwd: tmpdir(), timeoutMs: 30_000, maxStdoutBytes: 4 * 1024 * 1024 });
  return { ok: r.code === 0 && !r.timedOut && !r.truncated, stdout: r.stdout, stderr: r.stderr };
};

type Run = { id: number; run_attempt: number; path: string; event: string; head_sha: string; status: string; conclusion: string | null; created_at: string; updated_at: string; html_url: string; pull_requests?: { number: number }[] };
type Job = { id: number; name: string; status: string; conclusion: string | null; started_at: string | null; completed_at: string | null; html_url: string };
type Evidence = { runId: number; attempt: number; latestAttempt: number; headSha: string; runStatus: string; runConclusion: string | null; createdAt: string; updatedAt: string; startedAt: string | null; completedAt: string | null; runUrl: string; jobUrl: string; pullRequests: number[] | null };
type Group = { workflowPath: string; event: string; jobName: string; conclusion: string; latestRunCount: number; historicalAttemptCount: number; distinctPullRequests: number | null; knownPullRequests: number[]; evidence: Evidence[] };

export async function collectCiFailureGroups(repo: string, hours: number, now: Date, gh: CloudGh = defaultCiGh) {
  const from = new Date(now.getTime() - hours * 3_600_000).toISOString();
  const errors: string[] = [], truncations: string[] = [];
  async function page(endpoint: string, key: 'workflow_runs' | 'jobs'): Promise<{ rows: unknown[]; total: number } | null> {
    try {
      const r = await gh(['api', endpoint]);
      if (!r.ok) throw new Error('request failed, timed out, or exceeded output limit');
      const data: unknown = JSON.parse(r.stdout);
      if (!data || typeof data !== 'object' || !Array.isArray((data as Record<string, unknown>)[key]) || !Number.isSafeInteger((data as Record<string, unknown>).total_count) || Number((data as Record<string, unknown>).total_count) < 0) throw new Error('invalid response');
      return { rows: (data as Record<string, unknown>)[key] as unknown[], total: Number((data as Record<string, unknown>).total_count) };
    } catch (error) {
      errors.push(`${endpoint}: ${error instanceof SyntaxError ? 'invalid JSON' : error instanceof Error && error.message === 'invalid response' ? 'invalid response' : 'request failed, timed out, or exceeded output limit'}`);
      return null;
    }
  }
  const runs: Run[] = [];
  let runRows = 0;
  for (let p = 1; p <= RUN_PAGES; p++) {
    const endpoint = `repos/${repo}/actions/runs?created=%3E%3D${encodeURIComponent(from)}&per_page=${RUN_PAGE_SIZE}&page=${p}`;
    const result = await page(endpoint, 'workflow_runs');
    if (!result) break;
    if (result.rows.length > RUN_PAGE_SIZE) truncations.push(`${endpoint}: oversized page`);
    const rows = result.rows.slice(0, RUN_PAGE_SIZE);
    runRows += rows.length;
    for (const row of rows) {
      const r = row as Run | null;
      if (!r || !Number.isSafeInteger(r.id) || r.id < 1 || !Number.isSafeInteger(r.run_attempt) || r.run_attempt < 1 || typeof r.path !== 'string' || typeof r.event !== 'string' || typeof r.head_sha !== 'string' || typeof r.status !== 'string' || (r.conclusion !== null && typeof r.conclusion !== 'string') || typeof r.created_at !== 'string' || typeof r.updated_at !== 'string' || typeof r.html_url !== 'string') { errors.push(`${endpoint}: invalid run metadata`); continue; }
      runs.push(r);
    }
    if (runRows >= result.total || rows.length < RUN_PAGE_SIZE) {
      if (runRows < result.total) errors.push(`${endpoint}: incomplete page`);
      break;
    }
    if (p === RUN_PAGES) truncations.push(`workflow runs exceed ${RUN_PAGES * RUN_PAGE_SIZE}`);
  }
  const groups = new Map<string, Group>();
  for (const run of runs) {
    const first = Math.max(1, run.run_attempt - ATTEMPTS + 1);
    if (first > 1) truncations.push(`run ${run.id}: attempts 1-${first - 1} omitted`);
    for (let attempt = first; attempt <= run.run_attempt; attempt++) {
      let seen = 0;
      for (let p = 1; p <= JOB_PAGES; p++) {
        const endpoint = `repos/${repo}/actions/runs/${run.id}/attempts/${attempt}/jobs?per_page=${JOB_PAGE_SIZE}&page=${p}`;
        const result = await page(endpoint, 'jobs');
        if (!result) break;
        if (result.rows.length > JOB_PAGE_SIZE) truncations.push(`${endpoint}: oversized page`);
        const rows = result.rows.slice(0, JOB_PAGE_SIZE);
        seen += rows.length;
        for (const row of rows) {
          const job = row as Job | null;
          if (!job || !Number.isSafeInteger(job.id) || typeof job.name !== 'string' || typeof job.status !== 'string' || typeof job.html_url !== 'string' || (job.conclusion !== null && typeof job.conclusion !== 'string')) { errors.push(`${endpoint}: invalid job metadata`); continue; }
          const conclusion = job.status !== 'completed' ? 'incomplete' : job.conclusion ?? 'incomplete';
          if (conclusion === 'success') continue;
          const key = JSON.stringify([run.path, run.event, job.name, conclusion]);
          const group = groups.get(key) ?? { workflowPath: run.path, event: run.event, jobName: job.name, conclusion, latestRunCount: 0, historicalAttemptCount: 0, distinctPullRequests: null, knownPullRequests: [], evidence: [] };
          const prs = Array.isArray(run.pull_requests) && run.pull_requests.length > 0 && run.pull_requests.every(pr => pr && Number.isSafeInteger(pr.number) && pr.number > 0) ? run.pull_requests.map(pr => pr.number) : null;
          group.evidence.push({ runId: run.id, attempt, latestAttempt: run.run_attempt, headSha: run.head_sha, runStatus: run.status, runConclusion: run.conclusion, createdAt: run.created_at, updatedAt: run.updated_at, startedAt: job.started_at ?? null, completedAt: job.completed_at ?? null, runUrl: run.html_url, jobUrl: job.html_url, pullRequests: prs });
          groups.set(key, group);
        }
        if (seen >= result.total || rows.length < JOB_PAGE_SIZE) {
          if (seen < result.total) errors.push(`${endpoint}: incomplete page`);
          break;
        }
        if (p === JOB_PAGES) truncations.push(`run ${run.id} attempt ${attempt}: jobs exceed ${JOB_PAGES * JOB_PAGE_SIZE}`);
      }
    }
  }
  const ranked = [...groups.values()];
  for (const group of ranked) {
    group.evidence.sort((a, b) => (b.completedAt ?? b.startedAt ?? b.updatedAt).localeCompare(a.completedAt ?? a.startedAt ?? a.updatedAt) || b.attempt - a.attempt);
    group.latestRunCount = new Set(group.evidence.filter(e => e.attempt === e.latestAttempt).map(e => e.runId)).size;
    group.historicalAttemptCount = new Set(group.evidence.filter(e => e.attempt < e.latestAttempt).map(e => `${e.runId}:${e.attempt}`)).size;
    group.knownPullRequests = [...new Set(group.evidence.flatMap(e => e.pullRequests ?? []))].sort((a, b) => a - b);
    group.distinctPullRequests = group.evidence.every(e => e.pullRequests !== null) ? group.knownPullRequests.length : null;
  }
  const failing = (g: Group) => ['failure', 'timed_out'].includes(g.conclusion) ? 1 : 0;
  ranked.sort((a, b) => (failing(b) - failing(a)) || (b.latestRunCount - a.latestRunCount) || (b.historicalAttemptCount - a.historicalAttemptCount) || a.jobName.localeCompare(b.jobName));
  return { v: 1, repo, coverage: { from, to: now.toISOString(), runsFetched: runs.length, oldestRunCreatedAt: runs.reduce<string | null>((oldest, r) => !oldest || r.created_at < oldest ? r.created_at : oldest, null), runLimit: RUN_PAGES * RUN_PAGE_SIZE, attemptLimitPerRun: ATTEMPTS, jobLimitPerAttempt: JOB_PAGES * JOB_PAGE_SIZE, complete: errors.length === 0 && truncations.length === 0, truncations, errors }, runs: runs.map(r => ({ id: r.id, attempt: r.run_attempt, status: r.status, conclusion: r.conclusion, workflowPath: r.path, event: r.event, headSha: r.head_sha, createdAt: r.created_at, updatedAt: r.updated_at, url: r.html_url })), groups: ranked };
}
