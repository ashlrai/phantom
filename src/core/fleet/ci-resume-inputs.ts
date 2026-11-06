/**
 * Input-tree recovery planner for the RESUME-FROM-FAILURE order: given an
 * owner-written manifest of per-job covered repository paths and the receipts
 * a previous workflow attempt produced, decide which successful jobs may be
 * reused after a fix commit and which must run again.
 *
 * Digests are computed from git objects only (rev-parse, diff-tree, ls-tree);
 * the working tree is never read and no checks, statuses or workflows are
 * touched. A receipt counts only when its stored digest is reproduced from
 * objects at --base, so foreign or manifest-stale receipts cannot pass.
 */
import { createHash } from 'node:crypto';
import { defaultGitRunner, type GitRunner } from '../verse/git-ops.js';
import { scrubSecrets } from '../util/scrub.js';

const TIMEOUT_MS = 30_000;
const LS_TREE_MAX_BYTES = 16 * 1024 * 1024;
const DIFF_MAX_BYTES = 8 * 1024 * 1024;
const REV_PARSE_MAX_BYTES = 64 * 1024;
const MAX_JOBS = 128;
const MAX_PATHS_PER_JOB = 128;
const MAX_SHARED_PATHS = 128;
const MAX_COVERED_PATHS = 256;
const MAX_RECEIPTS = 512;
const MAX_FIELD = 200;
const MAX_PATH = 400;
const REV = /^[0-9a-f]{4,64}$/i;
const SHA40 = /^[0-9a-f]{40}$/i;
const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

export class CiResumeInputsError extends Error {}
const fail = (message: string): never => { throw new CiResumeInputsError(message); };

export interface CiResumeManifestJob { id: string; command: string; os: string; arch: string; toolchain: string; paths: string[] }
export interface CiResumeManifest { version: 1; repo: string; shared: string[]; jobs: CiResumeManifestJob[] }
export interface CiResumeReceipt { job: string; run: number; attempt: number | null; jobId: number | null; headSha: string | null; conclusion: string; inputsDigest: string }
export interface CiResumePrior { version: 1; repo: string; receipts: CiResumeReceipt[] }
interface TreeEntry { mode: string; type: string; oid: string; name: string }
export interface CiResumeJobPlan {
  job: string; decision: 'reuse' | 'rerun'; reasons: string[];
  baseDigest: string; headDigest: string;
  changedCoveredPaths: string[]; changedSharedPaths: string[];
  prior: CiResumeReceipt | null;
}
export interface CiResumePlan {
  version: 1; repo: string; base: string; head: string;
  changedPaths: string[]; unmappedChangedPaths: string[];
  jobs: CiResumeJobPlan[]; summary: { reuse: number; rerun: number };
}

const record = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
const field = (v: unknown): string | null =>
  // eslint-disable-next-line no-control-regex
  typeof v === 'string' && v.length > 0 && v.length <= MAX_FIELD && !/[\x00-\x1f\x7f]/.test(v) ? v : null;
const idNum = (v: unknown): number | null =>
  typeof v === 'number' && Number.isSafeInteger(v) && v >= 1 ? v : null;

/** Literal, repo-relative, slash-separated paths; rejects pathspec magic and traversal. */
function repoPath(v: unknown): string | null {
  // eslint-disable-next-line no-control-regex
  if (typeof v !== 'string' || v.length === 0 || v.length > MAX_PATH || /[\x00-\x1f\\:*?[\]\x7f]/.test(v)
    || v.startsWith('/') || v.startsWith('-') || v.startsWith('!') || v.startsWith('^')) return null;
  const parts = v.split('/').filter((s) => s !== '' && s !== '.');
  if (parts.length === 0 || parts.some((s) => s === '..')) return null;
  return parts.join('/');
}
function pathList(v: unknown, label: string, max: number): string[] {
  const list = Array.isArray(v) && v.length > 0 && v.length <= max ? v
    : fail(`${label} must be a non-empty array of at most ${max} paths`);
  const out = new Set<string>();
  for (const item of list) out.add(repoPath(item) ?? fail(`invalid repository path in ${label}: ${String(item).slice(0, 80)}`));
  return [...out].sort();
}

export function parseCiResumeManifest(value: unknown): CiResumeManifest {
  const m = record(value) ?? fail('manifest must be a JSON object');
  if (m['version'] !== 1) fail('manifest version must be 1');
  const repo = field(m['repo']) ?? '';
  if (!REPO.test(repo) || repo.split('/')[0]!.endsWith('-')) fail('manifest repo is invalid');
  const shared = m['shared'] === undefined ? [] : pathList(m['shared'], 'shared', MAX_SHARED_PATHS);
  const list = Array.isArray(m['jobs']) && m['jobs'].length > 0 && m['jobs'].length <= MAX_JOBS ? m['jobs']
    : fail('manifest jobs must be a non-empty array');
  const seen = new Set<string>();
  const jobs = list.map((row): CiResumeManifestJob => {
    const j = record(row) ?? fail('manifest job must be an object');
    const req = (key: string): string => field(j[key]) ?? fail(`manifest job requires ${key}`);
    const id = req('id');
    if (seen.has(id)) fail(`duplicate job id ${id}`);
    seen.add(id);
    return { id, command: req('command'), os: req('os'), arch: req('arch'), toolchain: req('toolchain'),
      paths: pathList(j['paths'], `job ${id} paths`, MAX_PATHS_PER_JOB) };
  });
  const covered = new Set(shared);
  for (const job of jobs) for (const p of job.paths) covered.add(p);
  if (covered.size > MAX_COVERED_PATHS) fail(`manifest covers more than ${MAX_COVERED_PATHS} paths`);
  jobs.sort((a, b) => a.id.localeCompare(b.id));
  return { version: 1, repo, shared, jobs };
}

export function parseCiResumePrior(value: unknown): CiResumePrior {
  const p = record(value) ?? fail('prior file must be a JSON object');
  if (p['version'] !== 1) fail('prior version must be 1');
  const repo = field(p['repo']) ?? '';
  if (!REPO.test(repo)) fail('prior repo is invalid');
  if (!Array.isArray(p['receipts']) || p['receipts'].length > MAX_RECEIPTS) fail('prior receipts must be an array');
  const receipts = (p['receipts'] as unknown[]).map((row): CiResumeReceipt => {
    const r = record(row) ?? fail('receipt must be an object');
    const absent = (key: string): boolean => r[key] === undefined || r[key] === null;
    const opt = (key: string, re: RegExp): string | null => {
      if (absent(key)) return null;
      const v = r[key];
      return typeof v === 'string' && re.test(v) ? v : fail('receipt is malformed');
    };
    const optNum = (key: string): number | null => absent(key) ? null : idNum(r[key]) ?? fail('receipt is malformed');
    return {
      job: field(r['job']) ?? fail('receipt is malformed'),
      run: idNum(r['run']) ?? fail('receipt is malformed'),
      attempt: optNum('attempt'),
      jobId: optNum('jobId'),
      headSha: opt('headSha', SHA40)?.toLowerCase() ?? null,
      conclusion: field(r['conclusion']) ?? fail('receipt is malformed'),
      inputsDigest: opt('inputsDigest', DIGEST) ?? fail('receipt is malformed'),
    };
  });
  return { version: 1, repo, receipts };
}

async function runGit(run: GitRunner, cwd: string, args: string[], maxStdoutBytes: number): Promise<string> {
  let r;
  try { r = await run('git', args, { cwd, timeoutMs: TIMEOUT_MS, maxStdoutBytes }); }
  catch { throw new CiResumeInputsError(`git ${args[0]} could not run`); }
  if (r.missing) fail('git is not installed');
  if (r.timedOut) fail(`git ${args[0]} timed out`);
  if (r.truncated) fail(`git ${args[0]} output exceeded its bound`);
  if (r.code !== 0) fail(`git ${args[0]} failed: ${scrubSecrets((r.stderr.split('\n')[0] ?? '').trim()).slice(0, 160)}`);
  return r.stdout;
}

function parseLsTree(stdout: string): TreeEntry[] {
  const out: TreeEntry[] = [];
  for (const row of stdout.split('\0')) {
    if (!row) continue;
    const tab = row.indexOf('\t');
    const [mode, type, oid] = tab < 0 ? [] : row.slice(0, tab).split(' ');
    const name = tab < 0 ? '' : row.slice(tab + 1);
    if (!/^[0-7]{6}$/.test(mode ?? '') || !['blob', 'tree', 'commit'].includes(type ?? '') || !SHA40.test(oid ?? '') || !name) {
      fail('git ls-tree output was malformed');
    }
    out.push({ mode: mode!, type: type!, oid: oid!, name });
  }
  return out;
}

const covers = (covered: string[], p: string): boolean => covered.some((c) => p === c || p.startsWith(`${c}/`));

export async function planCiResumeInputs(opts: {
  manifest: unknown; prior: unknown; base: string; head: string; cwd: string; git?: GitRunner;
}): Promise<CiResumePlan> {
  const manifest = parseCiResumeManifest(opts.manifest);
  const prior = parseCiResumePrior(opts.prior);
  if (!REV.test(opts.base) || !REV.test(opts.head)) fail('base and head must be hexadecimal revisions');
  const run = opts.git ?? defaultGitRunner;
  const resolveRev = async (rev: string, label: string): Promise<string> => {
    const out = (await runGit(run, opts.cwd, ['rev-parse', '--verify', `${rev}^{commit}`], REV_PARSE_MAX_BYTES)).trim();
    return SHA40.test(out) ? out.toLowerCase() : fail(`cannot resolve ${label} revision`);
  };
  const base = await resolveRev(opts.base, 'base');
  const head = await resolveRev(opts.head, 'head');
  const coveredAll = [...new Set([...manifest.shared, ...manifest.jobs.flatMap((j) => j.paths)])].sort();
  const entriesAt = async (rev: string): Promise<TreeEntry[]> => coveredAll.length === 0 ? []
    : parseLsTree(await runGit(run, opts.cwd, ['ls-tree', '--full-tree', '-r', '-z', rev, '--', ...coveredAll], LS_TREE_MAX_BYTES));
  const baseEntries = await entriesAt(base);
  const headEntries = await entriesAt(head);
  const changedPaths = [...new Set(
    (await runGit(run, opts.cwd, ['diff-tree', '-r', '--no-renames', '--name-only', '-z', base, head], DIFF_MAX_BYTES)).split('\0').filter(Boolean),
  )].sort();
  const unmapped = changedPaths.filter((p) => !covers(coveredAll, p));

  const digestFor = (job: CiResumeManifestJob, covered: string[], entries: TreeEntry[]): string => {
    const lines = ['ci-resume-inputs/v1', `repo ${manifest.repo.toLowerCase()}`, `job ${job.id}`,
      `command ${job.command}`, `os ${job.os}`, `arch ${job.arch}`, `toolchain ${job.toolchain}`];
    const hit = new Set<string>();
    for (const e of entries) if (covers(covered, e.name)) hit.add(`entry ${e.mode} ${e.type} ${e.oid} ${e.name}`);
    lines.push(...[...hit].sort());
    for (const c of covered) if (!entries.some((e) => e.name === c || e.name.startsWith(`${c}/`))) lines.push(`missing ${c}`);
    return `sha256:${createHash('sha256').update(lines.join('\n')).digest('hex')}`;
  };
  const rank = (a: CiResumeReceipt, b: CiResumeReceipt): number =>
    (b.run - a.run) || ((b.attempt ?? 0) - (a.attempt ?? 0)) || ((b.jobId ?? 0) - (a.jobId ?? 0))
    || a.conclusion.localeCompare(b.conclusion) || a.inputsDigest.localeCompare(b.inputsDigest);
  const repoMismatch = prior.repo.toLowerCase() !== manifest.repo.toLowerCase();

  const jobs = manifest.jobs.map((job): CiResumeJobPlan => {
    const covered = [...new Set([...manifest.shared, ...job.paths])].sort();
    const baseDigest = digestFor(job, covered, baseEntries);
    const headDigest = digestFor(job, covered, headEntries);
    const candidates = repoMismatch ? [] : prior.receipts.filter((r) => r.job === job.id);
    const verified = candidates.filter((r) => r.inputsDigest === baseDigest);
    const okReceipt = verified.filter((r) => r.conclusion === 'success').sort(rank)[0];
    const shown = okReceipt ?? [...verified].sort(rank)[0] ?? [...candidates].sort(rank)[0] ?? null;
    const reasons: string[] = [];
    if (repoMismatch) reasons.push('prior_repo_mismatch');
    else if (candidates.length === 0) reasons.push('no_prior_receipt');
    else if (verified.length === 0) reasons.push('prior_digest_unverified');
    else if (!okReceipt) reasons.push('prior_not_success');
    if (baseDigest !== headDigest) reasons.push('inputs_changed');
    if (unmapped.length > 0) reasons.push('unmapped_changes');
    const reuse = Boolean(okReceipt) && baseDigest === headDigest && unmapped.length === 0;
    return {
      job: job.id, decision: reuse ? 'reuse' : 'rerun', reasons: reuse ? ['inputs_unchanged'] : reasons,
      baseDigest, headDigest,
      changedCoveredPaths: changedPaths.filter((p) => covers(covered, p)),
      changedSharedPaths: changedPaths.filter((p) => covers(manifest.shared, p)),
      prior: shown,
    };
  });
  return { version: 1, repo: manifest.repo, base, head, changedPaths, unmappedChangedPaths: unmapped, jobs,
    summary: { reuse: jobs.filter((j) => j.decision === 'reuse').length, rerun: jobs.filter((j) => j.decision === 'rerun').length } };
}
