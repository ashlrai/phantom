export interface CiRunFactsV1 {
  v: 1;
  generatedAt: string;
  repo: string | null;
  windowHours: number;
  available: boolean;
  reason: string | null;
  total: number;
  byEvent: { pull_request: number; push: number; schedule: number; merge_group: number; workflow_dispatch: number; other: number };
  byWorkflow: Array<{ name: string; total: number; failed: number }>;
  failures: { total: number; bindArtifact: number; code: number; unclassified: number };
  daily: { runId: number; conclusion: string | null; createdAt: string; failedJobs: string[]; url: string } | null;
  recent: Array<{ runId: number; workflow: string; event: string; headBranch: string; prNumber: number | null; conclusion: string | null; status: string; failureClass: 'bind-artifact' | 'code' | null; createdAt: string; url: string }>;
}

export interface CiVerdict {
  tone: 'ok' | 'artifact' | 'code' | 'running' | 'none';
  label: string;
  url: string | null;
  runId: number | null;
}

export function ciVerdictForBranch(recent: CiRunFactsV1['recent'] | undefined, headBranch: string, prNumber: number | null): CiVerdict {
  const runs = Array.isArray(recent) ? recent : [];
  const byPr = prNumber === null ? [] : runs.filter(run => run.prNumber === prNumber);
  const candidates = byPr.length ? byPr : runs.filter(run => headBranch !== '' && run.headBranch === headBranch);
  const run = candidates.reduce<CiRunFactsV1['recent'][number] | undefined>((newest, candidate) => {
    const time = Date.parse(candidate.createdAt), newestTime = newest ? Date.parse(newest.createdAt) : NaN;
    return !newest || (Number.isFinite(time) && (!Number.isFinite(newestTime) || time > newestTime)) ? candidate : newest;
  }, undefined);
  if (!run) return { tone: 'none', label: '', url: null, runId: null };
  const identity = { url: run.url, runId: run.runId };
  if (run.status === 'in_progress' || run.status === 'queued') return { tone: 'running', label: 'CI running', ...identity };
  if (run.conclusion === 'success') return { tone: 'ok', label: 'CI green', ...identity };
  if (run.conclusion === 'failure') {
    if (run.failureClass === 'bind-artifact') return { tone: 'artifact', label: 'CI red: rebase artifact, not code', ...identity };
    return { tone: 'code', label: run.failureClass === 'code' ? 'CI red: code' : 'CI red', ...identity };
  }
  return { tone: 'none', label: '', ...identity };
}

export function ciVerdictCounts(rows: CiVerdict[]): string {
  const count = (tone: CiVerdict['tone']) => rows.filter(row => row.tone === tone).length;
  return `${count('ok')} green, ${count('artifact')} artifact reds, ${count('code')} code reds`;
}
