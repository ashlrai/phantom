import { tmpdir } from 'node:os';
import type { CloudGh } from '../core/cloud/pr-actions.js';
import { scrubSecrets } from '../core/util/scrub.js';
import { defaultGitRunner } from '../core/verse/git-ops.js';

const USAGE = 'ashlr fleet ci-step-cost --repo OWNER/REPO --run ID [--json]';
const PAGE_SIZE = 100;
const MAX_PAGES = 2;
const MAX_STEPS = 100;
const TOP_STEPS = 20;
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const SHA = /^[0-9a-f]{40}$/i;
const TIME = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/;

const defaultGh: CloudGh = async (args) => {
  const result = await defaultGitRunner('gh', args, { cwd: tmpdir(), timeoutMs: 60_000, maxStdoutBytes: 4 * 1024 * 1024 });
  return { ok: result.code === 0 && !result.timedOut && !result.truncated, stdout: result.stdout, stderr: result.stderr };
};

type RecordValue = Record<string, unknown>;
const record = (x: unknown): x is RecordValue => x !== null && typeof x === 'object' && !Array.isArray(x);
const positive = (x: unknown): x is number => typeof x === 'number' && Number.isSafeInteger(x) && x > 0;
function clean(x: unknown): string | null {
  if (typeof x !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const flat = x.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ').replace(/\s+/g, ' ').trim();
  return scrubSecrets(flat).slice(0, 200) || null;
}
function seconds(start: unknown, end: unknown): number | null {
  if (typeof start !== 'string' || typeof end !== 'string' || !TIME.test(start) || !TIME.test(end)) return null;
  const a = Date.parse(start), b = Date.parse(end);
  const canonical = (s: string) => s.replace(/(?:\.(\d{1,3}))?Z$/, (_, fraction: string | undefined) => `.${(fraction ?? '').padEnd(3, '0')}Z`);
  return Number.isFinite(a) && Number.isFinite(b) && new Date(a).toISOString() === canonical(start) &&
    new Date(b).toISOString() === canonical(end) && b >= a ? (b - a) / 1000 : null;
}
async function read(gh: CloudGh, endpoint: string): Promise<unknown> {
  try {
    const result = await gh(['api', endpoint]);
    // Bound injected readers too. Never forward gh stderr or raw responses.
    if (!result.ok || Buffer.byteLength(result.stdout) > 4 * 1024 * 1024) return null;
    return JSON.parse(result.stdout) as unknown;
  } catch { return null; }
}

type Step = { jobId: number; jobName: string | null; number: number; name: string | null; status: string | null; conclusion: string | null; wallSeconds: number | null };
type Job = { id: number; name: string | null; status: string | null; conclusion: string | null; queueSeconds: number | null; executionSeconds: number | null; steps: Step[] };
export interface FleetCiStepCostDeps {
  gh?: CloudGh;
  now?: () => Date;
  output?: (line: string) => void;
  error?: (line: string) => void;
}

export async function cmdFleetCiStepCost(args: string[], deps: FleetCiStepCostDeps = {}): Promise<number> {
  const output = deps.output ?? ((line: string) => console.log(line));
  const error = deps.error ?? ((line: string) => process.stderr.write(`${line}\n`));
  let repo = '', runText = '', json = false;
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if ((arg === '--help' || arg === '-h') && args.length === 1) { output(`usage: ${USAGE}`); return 0; }
    if (seen.has(arg)) { error(`error: duplicate argument\nusage: ${USAGE}`); return 2; }
    seen.add(arg);
    if (arg === '--repo') repo = args[++i] ?? '';
    else if (arg === '--run') runText = args[++i] ?? '';
    else if (arg === '--json') json = true;
    else { error(`error: invalid argument\nusage: ${USAGE}`); return 2; }
  }
  const runId = Number(runText);
  if (!REPO.test(repo) || repo.endsWith('/.') || repo.endsWith('/..') || !/^[1-9]\d*$/.test(runText) || !positive(runId)) {
    error(`error: --repo and a positive integer --run are required\nusage: ${USAGE}`); return 2;
  }
  const gh = deps.gh ?? defaultGh;
  const issues: string[] = [];
  const rawRun = await read(gh, `repos/${repo}/actions/runs/${runId}`);
  const run = record(rawRun) && rawRun.id === runId && positive(rawRun.run_attempt) ? rawRun : null;
  if (!run) issues.push('run metadata unavailable or malformed');
  const attempt = run && positive(run.run_attempt) ? run.run_attempt : null;
  const headSha = run && typeof run.head_sha === 'string' && SHA.test(run.head_sha) ? run.head_sha : null;
  const workflow = clean(run?.name), event = clean(run?.event), status = clean(run?.status);
  const elapsedSeconds = status === 'completed' ? seconds(run?.run_started_at, run?.updated_at) : null;
  if (run && (!headSha || !workflow || !event || elapsedSeconds === null)) issues.push('run metadata or elapsed time unknown');
  const jobs: Job[] = [];
  let expected: number | null = null;
  const ids = new Set<number>();
  if (attempt !== null) {
    for (let page = 1; page <= MAX_PAGES; page++) {
      const raw = await read(gh, `repos/${repo}/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=${PAGE_SIZE}&page=${page}`);
      if (!record(raw) || !Array.isArray(raw.jobs) || !Number.isSafeInteger(raw.total_count) || (raw.total_count as number) < 0 || raw.jobs.length > PAGE_SIZE) {
        issues.push('jobs read unavailable or malformed'); break;
      }
      if (expected !== null && expected !== raw.total_count) issues.push('job count changed during read');
      expected = raw.total_count as number;
      for (const item of raw.jobs) {
        if (!record(item) || !positive(item.id) || ids.has(item.id)) { issues.push('malformed or duplicate job'); continue; }
        ids.add(item.id);
        const name = clean(item.name), jobStatus = clean(item.status), conclusion = clean(item.conclusion);
        const queueSeconds = seconds(item.created_at, item.started_at);
        const executionSeconds = jobStatus === 'completed' ? (conclusion === 'skipped' ? 0 : seconds(item.started_at, item.completed_at)) : null;
        const steps: Step[] = [];
        if (!name || !jobStatus || queueSeconds === null || executionSeconds === null || !Array.isArray(item.steps)) issues.push(`job ${item.id} has unknown data`);
        const rawSteps = Array.isArray(item.steps) ? item.steps : [];
        if (rawSteps.length > MAX_STEPS) issues.push(`job ${item.id} exceeds ${MAX_STEPS} steps`);
        const numbers = new Set<number>();
        for (const s of rawSteps.slice(0, MAX_STEPS)) {
          if (!record(s) || !positive(s.number) || numbers.has(s.number)) { issues.push(`job ${item.id} has malformed or duplicate step`); continue; }
          numbers.add(s.number);
          const stepStatus = clean(s.status), stepConclusion = clean(s.conclusion), stepName = clean(s.name);
          const wallSeconds = stepStatus === 'completed' ? (stepConclusion === 'skipped' ? 0 : seconds(s.started_at, s.completed_at)) : null;
          if (!stepName || !stepStatus || wallSeconds === null) issues.push(`job ${item.id} step ${s.number} has unknown data`);
          steps.push({ jobId: item.id, jobName: name, number: s.number, name: stepName, status: stepStatus, conclusion: stepConclusion, wallSeconds });
        }
        jobs.push({ id: item.id, name, status: jobStatus, conclusion, queueSeconds, executionSeconds, steps });
      }
      if (raw.jobs.length < PAGE_SIZE || ids.size >= expected) break;
    }
    if (expected !== null && ids.size !== expected) issues.push(`jobs incomplete: observed ${ids.size} of ${expected}`);
  }
  const topSteps = jobs.flatMap(job => job.steps).filter(step => step.wallSeconds !== null)
    .sort((a, b) => b.wallSeconds! - a.wallSeconds! || a.jobId - b.jobId || a.number - b.number).slice(0, TOP_STEPS);
  const report = {
    v: 1, repo, runId, attempt, runUrl: `https://github.com/${repo}/actions/runs/${runId}`,
    headSha, workflow, event, status, generatedAt: (deps.now ?? (() => new Date()))().toISOString(),
    elapsedSeconds, complete: issues.length === 0, issues: [...new Set(issues)], jobs, topSteps,
  };
  if (json) output(JSON.stringify(report));
  else {
    output(`CI step cost ${repo} run ${runId} (${report.complete ? 'complete' : 'INCOMPLETE'}): ${report.runUrl}`);
    output(`  ${workflow ?? 'unknown workflow'} / ${event ?? 'unknown event'}; elapsed ${elapsedSeconds ?? 'unknown'}s`);
    for (const job of jobs) {
      output(`  job ${job.id} ${job.name ?? 'unknown'}: queue ${job.queueSeconds ?? 'unknown'}s, execution ${job.executionSeconds ?? 'unknown'}s`);
      for (const step of topSteps.filter(s => s.jobId === job.id)) output(`    step ${step.number} ${step.name ?? 'unknown'}: ${step.wallSeconds}s`);
    }
    output('  Step wall seconds may overlap across jobs; they are not run elapsed time or billed minutes.');
    for (const issue of report.issues) output(`  INCOMPLETE: ${issue}`);
  }
  return report.complete ? 0 : 1;
}
