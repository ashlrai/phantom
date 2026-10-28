/**
 * core/release-train.ts — the daily release train for a sanctioned repository.
 *
 * Two halves, both fail-closed:
 *
 *   plan/open   Decide the day's version bump from conventional commits since
 *               the latest GitHub release (feat -> minor; fix/perf/revert ->
 *               patch; nothing releasable or a breaking change -> none) and,
 *               on `open`, push a `release-train/vX.Y.Z` branch and create the
 *               version-bump PR. Branches only — the train never pushes tags.
 *
 *   dispatch    After the bump PR merges, verify master head is that merge,
 *               collect the qualified CI run, current-master attestor run,
 *               immutable attested artifact and dependency Audit run, then
 *               `gh workflow run` the repo's one sanctioned release workflow —
 *               for phantom that is publish-canonical-npm.yml and nothing else.
 *
 * Every GitHub/git/npm call goes through injected runners, so tests assert the
 * exact argv and no token is ever touched: `gh` owns its own auth. `--admin`,
 * tag pushes and any other workflow are unrepresentable here. A red or held
 * master (failing check runs, a truthy `RELEASE_HOLD` Actions variable, or an
 * engaged local kill switch) refuses every mutation.
 */
import { assertRepo } from './autopilot/github.js';

/** One external command run to stdout; throws on non-zero exit. */
export type Runner = (args: readonly string[]) => Promise<string>;

export interface ReleaseTrainDeps {
  gh: Runner;
  git: Runner;
  npm: Runner;
  /** Engaged local Stop/kill switch holds the train without any network read. */
  stopped(): boolean;
}

/** The only repositories with a sanctioned release-train lane, and the single workflow each may dispatch. */
export const RELEASE_TRAIN_LANES: Readonly<Record<string, { workflow: string }>> = {
  'ashlrai/phantom': { workflow: 'publish-canonical-npm.yml' },
};

export const RELEASE_TRAIN_BRANCH_PREFIX = 'release-train/v';
const HOLD_VARIABLE = 'RELEASE_HOLD';
const CI_WORKFLOW = 'ci.yml';
const ATTEST_WORKFLOW = 'attest-ci-build.yml';
const AUDIT_WORKFLOW = 'dependency-audit.yml';
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA = /^[0-9a-f]{40}$/;
const RUN_ID = /^[1-9][0-9]*$/;
const FAILING = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure']);
const CONVENTIONAL = /^([A-Za-z]+)(\([^()\n]*\))?(!)?[ \t]*:/;
const MINOR_TYPES = new Set(['feat']);
const PATCH_TYPES = new Set(['fix', 'perf', 'revert']);
const BREAKING_FOOTER = /^BREAKING[ -]CHANGE[ \t]*:/m;

export type BumpKind = 'patch' | 'minor' | 'none';
export type MainGate = 'green' | 'red' | 'pending' | 'held' | 'stopped';

export interface ReleaseTrainPlan {
  ok: boolean; reason: string; repo: string; branch: string; head: string | null;
  gate: MainGate; hold: string | null;
  currentVersion: string | null; bump: BumpKind; nextVersion: string | null;
  commits: number; since: string | null;
  prBranch: string | null; title: string | null;
}

export interface OpenBumpResult {
  ok: boolean; reason: string; plan: ReleaseTrainPlan; prUrl: string | null; alreadyOpen: boolean;
}

export interface DispatchResult {
  ok: boolean; reason: string; repo: string; workflow: string;
  argv: string[] | null; dispatched: boolean;
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json => (v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Json : {});
const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

async function api(gh: Runner, path: string): Promise<unknown> {
  return JSON.parse(await gh(['api', '-H', 'Accept: application/vnd.github+json', path])) as unknown;
}

/** Semantic-release rules: feat -> minor; fix/perf/revert -> patch; breaking -> none (a human owns majors). */
export function commitBump(message: string): BumpKind | 'breaking' {
  const head = message.split('\n', 1)[0] ?? '';
  const match = CONVENTIONAL.exec(head);
  if (match?.[3] === '!' || BREAKING_FOOTER.test(message)) return 'breaking';
  const type = match?.[1]?.toLowerCase();
  if (type !== undefined && MINOR_TYPES.has(type)) return 'minor';
  if (type !== undefined && PATCH_TYPES.has(type)) return 'patch';
  return 'none';
}

export function decideBump(messages: readonly string[]): { bump: BumpKind; reason: string } {
  let bump: BumpKind = 'none';
  for (const message of messages) {
    const kind = commitBump(message);
    if (kind === 'breaking') return { bump: 'none', reason: 'breaking-change-needs-manual-release' };
    if (kind === 'minor') bump = 'minor';
    else if (kind === 'patch' && bump === 'none') bump = 'patch';
  }
  return { bump, reason: bump === 'none' ? 'no-releasing-commits' : 'ready' };
}

function bumpVersion(version: string, bump: Exclude<BumpKind, 'none'>): string {
  const [major, minor, patch] = version.split('.').map(Number) as [number, number, number];
  return bump === 'minor' ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
}

function lane(repo: string): { workflow: string } {
  const found = RELEASE_TRAIN_LANES[assertRepo(repo)];
  if (!found) throw new Error(`No sanctioned release-train lane for ${repo}`);
  return found;
}

/** Truthy RELEASE_HOLD Actions variable value, else null. A missing variable is not a hold. */
async function readHold(gh: Runner, repo: string): Promise<string | null> {
  try {
    const value = str(obj(await api(gh, `repos/${repo}/actions/variables/${HOLD_VARIABLE}`))['value']).trim();
    return value !== '' && value !== '0' && value.toLowerCase() !== 'false' ? value.slice(0, 200) : null;
  } catch (error) {
    if (/\b404\b|Not Found/i.test(String(error))) return null;
    throw error;
  }
}

interface HeadCheck { id: number; name: string; status: string; conclusion: string | null }

async function readHeadChecks(gh: Runner, repo: string, sha: string): Promise<HeadCheck[]> {
  const out: HeadCheck[] = [];
  for (let page = 1; page <= 3; page++) {
    const raw = obj(await api(gh, `repos/${repo}/commits/${sha}/check-runs?per_page=100&page=${page}`));
    const runs = arr(raw['check_runs']);
    for (const run of runs.map(obj)) {
      out.push({ id: Number(run['id']), name: str(run['name']).slice(0, 160), status: str(run['status']), conclusion: typeof run['conclusion'] === 'string' ? run['conclusion'] : null });
    }
    if (runs.length < 100) break;
  }
  return out;
}

function summarizeChecks(checks: readonly HeadCheck[]): 'green' | 'red' | 'pending' {
  const latest = new Map<string, HeadCheck>();
  for (const check of checks) if ((latest.get(check.name)?.id ?? -1) < check.id) latest.set(check.name, check);
  if (latest.size === 0) return 'pending';
  for (const check of latest.values()) {
    if (check.status !== 'completed' || check.conclusion === null) return 'pending';
    if (FAILING.has(check.conclusion)) return 'red';
  }
  return 'green';
}

async function readPackageVersion(gh: Runner, repo: string, ref: string): Promise<string | null> {
  const raw = obj(await api(gh, `repos/${repo}/contents/package.json?ref=${encodeURIComponent(ref)}`));
  const content = Buffer.from(str(raw['content']).replace(/\s+/g, ''), 'base64').toString('utf8');
  const pkg = obj(JSON.parse(content));
  const version = str(pkg['version']);
  return SEMVER.test(version) ? version : null;
}

interface WorkflowRun { id: number; attempt: number; headSha: string; event: string }

/** Newest successful run of `workflow` on `sha`; null when none completed green. */
async function successfulRun(gh: Runner, repo: string, workflow: string, sha: string): Promise<WorkflowRun | null> {
  const raw = obj(await api(gh, `repos/${repo}/actions/workflows/${workflow}/runs?head_sha=${sha}&status=success&per_page=10`));
  for (const run of arr(raw['workflow_runs']).map(obj)) {
    const candidate = { id: Number(run['id']), attempt: Number(run['run_attempt']), headSha: str(run['head_sha']), event: str(run['event']) };
    if (RUN_ID.test(String(candidate.id)) && RUN_ID.test(String(candidate.attempt)) && candidate.headSha === sha) return candidate;
  }
  return null;
}

/**
 * The day's plan: gate state, the bump decision and the PR identity. Read-only;
 * `ok` means `open` would proceed — a green, unheld main and a real bump.
 */
export async function planReleaseTrain(deps: Pick<ReleaseTrainDeps, 'gh' | 'stopped'>, opts: { repo?: string } = {}): Promise<ReleaseTrainPlan> {
  const repo = opts.repo ?? Object.keys(RELEASE_TRAIN_LANES)[0]!;
  lane(repo);
  const plan: ReleaseTrainPlan = {
    ok: false, reason: 'ready', repo, branch: 'master', head: null, gate: 'green', hold: null,
    currentVersion: null, bump: 'none', nextVersion: null, commits: 0, since: null, prBranch: null, title: null,
  };
  if (deps.stopped()) { plan.gate = 'stopped'; plan.reason = 'stopped'; return plan; }
  plan.branch = str(obj(await api(deps.gh, `repos/${repo}`))['default_branch']) || 'master';
  plan.hold = await readHold(deps.gh, repo);
  const head = str(obj(obj(await api(deps.gh, `repos/${repo}/branches/${encodeURIComponent(plan.branch)}`))['commit'])['sha']);
  if (!SHA.test(head)) throw new Error('Default branch head is unreadable');
  plan.head = head;
  plan.currentVersion = await readPackageVersion(deps.gh, repo, head);
  const checks = summarizeChecks(await readHeadChecks(deps.gh, repo, head));
  plan.gate = plan.hold !== null ? 'held' : checks;
  if (plan.currentVersion !== null) {
    const tag = str(obj(await api(deps.gh, `repos/${repo}/releases/latest`))['tag_name']);
    const compare = tag ? obj(await api(deps.gh, `repos/${repo}/compare/${encodeURIComponent(tag)}...${head}`)) : null;
    const messages = compare === null ? [] : arr(compare['commits']).map((c) => str(obj(obj(c)['commit'])['message']));
    plan.since = tag || null;
    plan.commits = messages.length;
    const decision = decideBump(messages);
    plan.bump = decision.bump; plan.reason = decision.reason;
    if (plan.bump !== 'none') {
      plan.nextVersion = bumpVersion(plan.currentVersion, plan.bump);
      plan.prBranch = `${RELEASE_TRAIN_BRANCH_PREFIX}${plan.nextVersion}`;
      plan.title = `release: v${plan.nextVersion}`;
    }
  } else plan.reason = 'version-unreadable';
  plan.ok = plan.gate === 'green' && plan.bump !== 'none';
  if (plan.gate === 'held') plan.reason = `held:${plan.hold}`;
  else if (plan.gate !== 'green') plan.reason = `main-${plan.gate}`;
  return plan;
}

/**
 * Push the bump branch and open its PR. Refuses unless the plan says go; an
 * already-open PR for the same version is returned instead of duplicated.
 */
export async function openReleaseBumpPr(deps: ReleaseTrainDeps, opts: { repo?: string } = {}): Promise<OpenBumpResult> {
  const plan = await planReleaseTrain(deps, opts);
  const idle = { ok: false, reason: plan.reason, plan, prUrl: null, alreadyOpen: false };
  if (!plan.ok || plan.nextVersion === null || plan.prBranch === null || plan.head === null) return idle;
  const owner = plan.repo.split('/')[0]!;
  const open = arr(await api(deps.gh, `repos/${plan.repo}/pulls?state=open&head=${owner}:${plan.prBranch}&per_page=5`)).map(obj);
  const existing = str(open[0]?.['html_url']);
  if (existing) return { ok: true, reason: 'already-open', plan, prUrl: existing, alreadyOpen: true };
  // `add -A` below stages everything: a dirty checkout would ride the bump commit.
  if ((await deps.git(['status', '--porcelain'])).trim() !== '') return { ...idle, reason: 'dirty-worktree' };
  await deps.git(['fetch', 'origin', plan.branch]);
  await deps.git(['checkout', '-B', plan.prBranch, `origin/${plan.branch}`]);
  await deps.npm(['run', 'version:sync', '--', plan.nextVersion]);
  await deps.git(['add', '-A']);
  await deps.git(['commit', '-m', `chore(release): v${plan.nextVersion}`]);
  // Branch push only: tags are never created or pushed by the train.
  await deps.git(['push', '-u', 'origin', plan.prBranch]);
  const body = `Daily release-train version bump: ${plan.currentVersion} -> ${plan.nextVersion} (${plan.bump}).\n\n` +
    `${plan.commits} commit(s) since ${plan.since ?? 'the last release'}.\n\n` +
    'After merge, `phm release-train dispatch` runs the canonical npm publisher for this revision.';
  const out = await deps.gh(['pr', 'create', '--repo', plan.repo, '--base', plan.branch, '--head', plan.prBranch,
    '--title', plan.title ?? `release: v${plan.nextVersion}`, '--body', body]);
  const prUrl = out.trim().split('\n').pop() ?? '';
  return { ok: true, reason: 'opened', plan, prUrl, alreadyOpen: false };
}

/**
 * Post-merge dispatch of the sanctioned publisher. Master head must be the
 * merged `release-train/v<version>` bump with green checks and the full
 * CI -> attestor -> artifact -> Audit evidence chain on that exact revision.
 * Returns the exact `gh workflow run` argv; `dryRun` reports without running.
 */
export async function dispatchReleaseTrain(deps: Pick<ReleaseTrainDeps, 'gh' | 'stopped'>, opts: { repo?: string; dryRun?: boolean } = {}): Promise<DispatchResult> {
  const repo = opts.repo ?? Object.keys(RELEASE_TRAIN_LANES)[0]!;
  const result: DispatchResult = { ok: false, reason: 'ready', repo, workflow: lane(repo).workflow, argv: null, dispatched: false };
  const refuse = (reason: string): DispatchResult => ({ ...result, reason });
  if (deps.stopped()) return refuse('stopped');
  const branch = str(obj(await api(deps.gh, `repos/${repo}`))['default_branch']) || 'master';
  const hold = await readHold(deps.gh, repo);
  if (hold !== null) return refuse(`held:${hold}`);
  const head = str(obj(obj(await api(deps.gh, `repos/${repo}/branches/${encodeURIComponent(branch)}`))['commit'])['sha']);
  if (!SHA.test(head)) return refuse('head-unreadable');
  const checks = summarizeChecks(await readHeadChecks(deps.gh, repo, head));
  if (checks === 'red') return refuse('main-red');
  if (checks === 'pending') return refuse('main-pending');
  const version = await readPackageVersion(deps.gh, repo, head);
  if (version === null) return refuse('version-unreadable');
  const trainRef = `${RELEASE_TRAIN_BRANCH_PREFIX}${version}`;
  const merged = arr(await api(deps.gh, `repos/${repo}/commits/${head}/pulls`)).map(obj)
    .some((pr) => str(obj(pr['head'])['ref']) === trainRef && str(pr['merged_at']) !== '');
  if (!merged) return refuse('not-a-train-merge');
  const ci = await successfulRun(deps.gh, repo, CI_WORKFLOW, head);
  if (ci === null) return refuse('ci-missing');
  const attestor = await successfulRun(deps.gh, repo, ATTEST_WORKFLOW, head);
  if (attestor === null || attestor.event !== 'workflow_dispatch') return refuse('attestor-missing');
  const artifacts = arr(obj(await api(deps.gh, `repos/${repo}/actions/runs/${attestor.id}/artifacts?per_page=100`))['artifacts']).map(obj);
  const attested = `ashlr-attested-${ci.id}-${ci.attempt}-${attestor.id}-${attestor.attempt}`;
  const artifact = artifacts.find((a) => str(a['name']) === attested && a['expired'] === false);
  if (artifact === undefined || !RUN_ID.test(String(artifact['id']))) return refuse('artifact-missing');
  const audit = await successfulRun(deps.gh, repo, AUDIT_WORKFLOW, head);
  if (audit === null) return refuse('audit-missing');
  const argv = [
    'workflow', 'run', result.workflow, '--repo', repo, '--ref', branch,
    '-f', `candidate_sha=${head}`,
    '-f', `ci_run_id=${ci.id}`, '-f', `ci_run_attempt=${ci.attempt}`,
    '-f', `attestor_run_id=${attestor.id}`, '-f', `attestor_run_attempt=${attestor.attempt}`,
    '-f', `attested_artifact_id=${String(artifact['id'])}`,
    '-f', `version=${version}`,
    '-f', `audit_run_id=${audit.id}`, '-f', `audit_run_attempt=${audit.attempt}`,
  ];
  if (opts.dryRun === true) return { ...result, ok: true, argv };
  await deps.gh(argv);
  return { ...result, ok: true, argv, dispatched: true };
}
