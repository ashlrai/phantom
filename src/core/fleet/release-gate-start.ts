import { tmpdir } from 'node:os';
import { stripVTControlCharacters } from 'node:util';
import { defaultGitRunner, type GitRunner } from '../verse/git-ops.js';
import { scrubSecrets } from '../util/scrub.js';

const SHA = /^[a-f0-9]{40}$/;
const OPTIONS = { cwd: tmpdir(), timeoutMs: 30_000, maxStdoutBytes: 1024 * 1024 };
const statuses = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending', 'completed']);
const record = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;

type Outcome = 'planned' | 'submitted' | 'no-op' | 'refused' | 'unavailable';
interface Run { id: number; status: string; event: string; conclusion: string | null }
export interface ReleaseGateStartReport {
  version: 1; repo: string; sha: string; apply: boolean; outcome: Outcome; reason: string;
  branch: string | null; head: string | null; runs: Run[];
  dispatch: { workflow: 'ci.yml'; ref: string | null; inputs: { release_gate: true }; invoked: boolean; detail: string | null };
  note: string;
}

async function api(runner: GitRunner, path: string): Promise<Record<string, unknown> | null> {
  try {
    const result = await runner('gh', ['api', path], OPTIONS);
    if (result.code !== 0 || result.timedOut || result.missing || result.truncated) return null;
    return record(JSON.parse(result.stdout));
  } catch { return null; }
}

/** A single complete, bounded page is required; partial evidence cannot authorize a POST. */
async function inspect(runner: GitRunner, repo: string, sha: string): Promise<{
  branch: string | null; head: string | null; runs: Run[]; reason: string;
}> {
  const base = `repos/${repo}`;
  const metadata = await api(runner, base);
  const branch = typeof metadata?.['default_branch'] === 'string' && metadata['default_branch'].length > 0
    && metadata['default_branch'].length <= 255 ? metadata['default_branch'] : null;
  if (!branch) return { branch: null, head: null, runs: [], reason: 'branch_unknown' };
  const branchData = await api(runner, `${base}/branches/${encodeURIComponent(branch)}`);
  const headValue = record(branchData?.['commit'])?.['sha'];
  const head = typeof headValue === 'string' && SHA.test(headValue) ? headValue : null;
  if (!head) return { branch, head: null, runs: [], reason: 'head_unknown' };
  if (head !== sha) return { branch, head, runs: [], reason: 'head_mismatch' };
  const inventory = await api(runner, `${base}/actions/workflows/ci.yml/runs?head_sha=${sha}&per_page=100`);
  const rows = inventory?.['workflow_runs'];
  if (!inventory || !Array.isArray(rows) || !Number.isSafeInteger(inventory['total_count'])
    || inventory['total_count'] !== rows.length || rows.length > 100) {
    return { branch, head, runs: [], reason: 'inventory_unavailable' };
  }
  const runs: Run[] = [];
  for (const row of rows) {
    const r = record(row);
    if (!r || !Number.isSafeInteger(r['id']) || (r['id'] as number) < 1 || r['head_sha'] !== sha
      || r['path'] !== '.github/workflows/ci.yml' || typeof r['event'] !== 'string' || !r['event']
      || typeof r['status'] !== 'string' || !statuses.has(r['status'])
      || (r['conclusion'] !== null && typeof r['conclusion'] !== 'string')) {
      return { branch, head, runs: [], reason: 'inventory_unavailable' };
    }
    runs.push({ id: r['id'] as number, event: r['event'], status: r['status'], conclusion: r['conclusion'] as string | null });
  }
  return { branch, head, runs, reason: runs.some(r => ['workflow_dispatch', 'schedule'].includes(r.event) && r.status !== 'completed') ? 'run_in_flight' : 'eligible' };
}

/** Submit only after fresh head and complete inventory reads. Dispatch by branch is not atomic with those reads. */
export async function startReleaseGate(repo: string, sha: string, opts: { apply?: boolean; runner?: GitRunner } = {}): Promise<ReleaseGateStartReport> {
  const runner = opts.runner ?? defaultGitRunner;
  const report: ReleaseGateStartReport = {
    version: 1, repo, sha, apply: opts.apply === true, outcome: 'unavailable', reason: 'pending',
    branch: null, head: null, runs: [],
    dispatch: { workflow: 'ci.yml', ref: null, inputs: { release_gate: true }, invoked: false, detail: null },
    note: 'Branch movement can race dispatch; check the actual run head and inspect the release candidate before downstream reuse. Submission does not mean published, attested, or installed.',
  };
  const read = async () => {
    const state = await inspect(runner, repo, sha);
    report.branch = state.branch; report.head = state.head; report.runs = state.runs; report.reason = state.reason;
    report.dispatch.ref = state.reason === 'eligible' ? state.branch : null;
    report.outcome = state.reason === 'eligible' ? 'planned' : state.reason === 'run_in_flight' ? 'no-op'
      : state.reason === 'head_mismatch' ? 'refused' : 'unavailable';
    return state;
  };
  const first = await read();
  if (!opts.apply || first.reason !== 'eligible') return report;
  const fresh = await read();
  if (fresh.reason !== 'eligible') return report;
  if (fresh.branch !== first.branch) { report.outcome = 'refused'; report.reason = 'branch_changed'; report.dispatch.ref = null; return report; }
  report.dispatch.invoked = true;
  const sent = await runner('gh', ['workflow', 'run', 'ci.yml', '--repo', repo, '--ref', fresh.branch!, '-f', 'release_gate=true'], OPTIONS).catch(() => null);
  if (!sent || sent.code !== 0 || sent.timedOut || sent.missing || sent.truncated) {
    report.outcome = 'refused'; report.reason = 'dispatch_failed';
    // eslint-disable-next-line no-control-regex
    const detail = scrubSecrets(stripVTControlCharacters(sent?.stderr || sent?.stdout || '').replace(/[\x00-\x1f\x7f-\x9f]/g, ' ')).trim().slice(0, 200);
    report.dispatch.detail = detail || null;
  } else { report.outcome = 'submitted'; report.reason = 'dispatch_accepted'; }
  return report;
}
