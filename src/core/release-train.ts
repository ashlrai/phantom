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
 *   dispatch    After the bump PR merges, pass four fail-closed gates —
 *               (1) the version-bump PR merged at master head, (2) no open
 *               P0 DAILYFIX line or PR for the repo, (3) the latest full-suite
 *               master run green, (4) the macOS and Windows legs green on the
 *               bump revision — then collect the qualified CI run,
 *               current-master attestor run, immutable attested artifact and
 *               dependency Audit run, then `gh workflow run` the repo's one
 *               sanctioned release workflow — for phantom that is
 *               publish-canonical-npm.yml and nothing else. The actual
 *               `gh workflow run` call additionally requires
 *               PHANTOM_RELEASE_TRAIN=1; without it `dispatch` is a dry run
 *               that reports the exact argv.
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
  /**
   * PHANTOM_RELEASE_TRAIN=1 opt-in arming the publish dispatch. Absent, or any
   * value other than exactly '1', makes `dispatch` a dry run: every gate
   * still evaluates and the exact argv is reported, but `gh workflow run` is
   * never invoked.
   */
  armed?(): boolean;
}

/** The only repositories with a sanctioned release-train lane, and the single workflow each may dispatch. */
export const RELEASE_TRAIN_LANES: Readonly<Record<string, { workflow: string }>> = {
  'ashlrai/phantom': { workflow: 'publish-canonical-npm.yml' },
};

export const RELEASE_TRAIN_BRANCH_PREFIX = 'release-train/v';
/** Opt-in env flag arming the publish dispatch; only the exact value '1' arms it. */
export const RELEASE_TRAIN_ENV = 'PHANTOM_RELEASE_TRAIN';
const HOLD_VARIABLE = 'RELEASE_HOLD';
const CI_WORKFLOW = 'ci.yml';
const ATTEST_WORKFLOW = 'attest-ci-build.yml';
const AUDIT_WORKFLOW = 'dependency-audit.yml';
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SHA = /^[0-9a-f]{40}$/;
const RUN_ID = /^[1-9][0-9]*$/;
const WORKFLOW_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.yml$/;
const FAILING = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'startup_failure']);
/** Suite legs — Mac exhaustive, shared/isolated Mac lanes and Windows legs — run only on these ci.yml events. */
const FULL_SUITE_EVENTS = new Set(['schedule', 'workflow_dispatch', 'workflow_call']);
const MAC_CHECK = /macos|\bmac\b/i;
const WIN_CHECK = /\bwindows\b/i;
const DAILYFIX = /dailyfix/i;

/** PHANTOM_RELEASE_TRAIN=1 arms the publisher dispatch; unset or any other value never dispatches. */
export const releaseTrainArmed = (env: { [key: string]: string | undefined } = process.env): boolean => env[RELEASE_TRAIN_ENV] === '1';
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

/** Newest check run per name (later ids supersede earlier attempts). */
function latestChecks(checks: readonly HeadCheck[]): HeadCheck[] {
  const latest = new Map<string, HeadCheck>();
  for (const check of checks) if ((latest.get(check.name)?.id ?? -1) < check.id) latest.set(check.name, check);
  return [...latest.values()];
}

function summarizeChecks(checks: readonly HeadCheck[]): 'green' | 'red' | 'pending' {
  const latest = latestChecks(checks);
  if (latest.length === 0) return 'pending';
  for (const check of latest) {
    if (check.status !== 'completed' || check.conclusion === null) return 'pending';
    if (FAILING.has(check.conclusion)) return 'red';
  }
  return 'green';
}

/**
 * Green only when at least one leg matches and every matching leg completed
 * success or neutral. A skipped/stale leg is not green evidence and a missing
 * leg means the suite never produced it on this revision: both refuse.
 */
function legState(checks: readonly HeadCheck[], pattern: RegExp): 'missing' | 'pending' | 'red' | 'green' {
  const legs = checks.filter((check) => pattern.test(check.name));
  if (legs.length === 0) return 'missing';
  for (const leg of legs) {
    if (leg.status !== 'completed' || leg.conclusion === null) return 'pending';
    if (FAILING.has(leg.conclusion)) return 'red';
    if (leg.conclusion !== 'success' && leg.conclusion !== 'neutral') return 'pending';
  }
  return 'green';
}

interface OpenItem { number: number; title: string; ref: string; labels: string[] }

/** Open PRs and plain issues, bounded to three pages each; both can carry a DAILYFIX queue line. */
async function readOpenItems(gh: Runner, repo: string): Promise<OpenItem[]> {
  const labelsOf = (v: Json): string[] => arr(v['labels']).map((label) => str(obj(label)['name']));
  const items: OpenItem[] = [];
  for (let page = 1; page <= 3; page++) {
    const pulls = arr(await api(gh, `repos/${repo}/pulls?state=open&per_page=100&page=${page}`)).map(obj);
    for (const pr of pulls) {
      items.push({ number: Number(pr['number']), title: str(pr['title']), ref: str(obj(pr['head'])['ref']), labels: labelsOf(pr) });
    }
    if (pulls.length < 100) break;
  }
  for (let page = 1; page <= 3; page++) {
    const issues = arr(await api(gh, `repos/${repo}/issues?state=open&per_page=100&page=${page}`)).map(obj);
    for (const issue of issues) {
      if (issue['pull_request'] !== undefined) continue;
      items.push({ number: Number(issue['number']), title: str(issue['title']), ref: '', labels: labelsOf(issue) });
    }
    if (issues.length < 100) break;
  }
  return items;
}

/** Explicit priority digit of an open item; null when nothing parses, which fails closed. */
function itemPriority(item: OpenItem): number | null {
  const title = /\bP([0-9])\b/.exec(item.title);
  if (title !== null) return Number(title[1]);
  for (const label of item.labels) {
    const marked = /^P?([0-9])$/i.exec(label.trim().replace(/^priority[\s:_-]*/i, ''));
    if (marked !== null) return Number(marked[1]);
  }
  return null;
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
 * Post-merge dispatch of the sanctioned publisher, behind four fail-closed
 * gates and the PHANTOM_RELEASE_TRAIN=1 opt-in. Without the flag `dispatch`
 * is a dry run: every gate still evaluates and the exact argv is reported,
 * but `gh workflow run` is never invoked. The gates, in order:
 *
 *   gate1  master head is the merged `release-train/v<version>` bump and the
 *          bumped package version parses as semver.
 *   gate2  no open P0 DAILYFIX line or PR for the repo; a DAILYFIX item whose
 *          priority cannot be parsed fails closed like a P0.
 *   gate3  the latest full-suite master run (schedule, dispatch or
 *          workflow_call — the events that carry the Mac/Windows legs) is green.
 *   gate4  every check on the bump sha is green and the macOS and Windows
 *          legs on that revision — only produced since the bump — are green.
 *
 * Past the gates the qualified CI run, current-master attestor run, immutable
 * attested artifact and dependency Audit run on that exact sha complete the
 * publisher evidence chain. Any gh error, missing data or unparseable result
 * refuses and `reason` names the gate that refused. `--ref` pins the dispatch
 * to the exact bump sha, never a branch name; the version flows as a separate
 * `-f version=` argv element after matching the semver regex.
 */
export async function dispatchReleaseTrain(deps: Pick<ReleaseTrainDeps, 'gh' | 'stopped' | 'armed'>, opts: { repo?: string; dryRun?: boolean } = {}): Promise<DispatchResult> {
  const repo = opts.repo ?? Object.keys(RELEASE_TRAIN_LANES)[0]!;
  const result: DispatchResult = { ok: false, reason: 'ready', repo, workflow: lane(repo).workflow, argv: null, dispatched: false };
  const refuse = (reason: string): DispatchResult => ({ ...result, reason });
  if (deps.stopped()) return refuse('stopped');
  let argv: string[] | null = null;
  let stage = 'precheck';
  try {
    const hold = await readHold(deps.gh, repo);
    if (hold !== null) return refuse(`held:${hold}`);

    // Gate 1: the version-bump PR merged at master head.
    stage = 'gate1';
    const branch = str(obj(await api(deps.gh, `repos/${repo}`))['default_branch']) || 'master';
    const head = str(obj(obj(await api(deps.gh, `repos/${repo}/branches/${encodeURIComponent(branch)}`))['commit'])['sha']);
    if (!SHA.test(head)) return refuse('gate1-head-unreadable');
    const version = await readPackageVersion(deps.gh, repo, head);
    if (version === null) return refuse('gate1-version-unreadable');
    const trainRef = `${RELEASE_TRAIN_BRANCH_PREFIX}${version}`;
    const merged = arr(await api(deps.gh, `repos/${repo}/commits/${head}/pulls`)).map(obj)
      .some((pr) => str(obj(pr['head'])['ref']) === trainRef && str(pr['merged_at']) !== '');
    if (!merged) return refuse('gate1-bump-not-merged');

    // Gate 2: no open P0 DAILYFIX line or PR for the repo.
    stage = 'gate2';
    for (const item of await readOpenItems(deps.gh, repo)) {
      if (!DAILYFIX.test(item.title) && !DAILYFIX.test(item.ref)) continue;
      const priority = itemPriority(item);
      if (priority === 0) return refuse(`gate2-dailyfix-p0-open:#${item.number}`);
      if (priority === null) return refuse(`gate2-dailyfix-priority-unparseable:#${item.number}`);
    }

    // Gate 3: the latest full-suite master run is green.
    stage = 'gate3';
    const suiteRuns = arr(obj(await api(deps.gh, `repos/${repo}/actions/workflows/${CI_WORKFLOW}/runs?branch=${encodeURIComponent(branch)}&per_page=10`))['workflow_runs']).map(obj);
    const suite = suiteRuns.find((run) => FULL_SUITE_EVENTS.has(str(run['event'])));
    if (suite === undefined) return refuse('gate3-full-suite-missing');
    if (str(suite['status']) !== 'completed') return refuse('gate3-full-suite-pending');
    const suiteConclusion = str(suite['conclusion']);
    if (suiteConclusion !== 'success' && suiteConclusion !== 'neutral') {
      return refuse(`gate3-full-suite-${suiteConclusion === '' ? 'unparseable' : suiteConclusion}`);
    }

    // Gate 4: every check on the bump sha is green and the macOS + Windows
    // legs on that revision are present and green. Those legs only run on the
    // full master suite, never on PR or merge_group, so their presence on the
    // bump sha is itself the since-the-bump evidence.
    stage = 'gate4';
    const checks = latestChecks(await readHeadChecks(deps.gh, repo, head));
    const mac = legState(checks, MAC_CHECK);
    if (mac !== 'green') return refuse(`gate4-mac-${mac}`);
    const win = legState(checks, WIN_CHECK);
    if (win !== 'green') return refuse(`gate4-win-${win}`);
    const summary = summarizeChecks(checks);
    if (summary === 'red') return refuse('gate4-checks-red');
    if (summary === 'pending') return refuse('gate4-checks-pending');

    // Publisher evidence chain on this exact sha: qualified CI run, current-
    // master attestor run, immutable attested artifact and dependency Audit.
    stage = 'evidence';
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

    stage = 'dispatch';
    if (!WORKFLOW_FILE.test(result.workflow)) return refuse('workflow-unusable');
    argv = [
      'workflow', 'run', result.workflow, '--repo', repo, '--ref', head,
      '-f', `candidate_sha=${head}`,
      '-f', `ci_run_id=${ci.id}`, '-f', `ci_run_attempt=${ci.attempt}`,
      '-f', `attestor_run_id=${attestor.id}`, '-f', `attestor_run_attempt=${attestor.attempt}`,
      '-f', `attested_artifact_id=${String(artifact['id'])}`,
      '-f', `version=${version}`,
      '-f', `audit_run_id=${audit.id}`, '-f', `audit_run_attempt=${audit.attempt}`,
    ];
    if (deps.armed?.() !== true) return { ...result, ok: true, reason: 'flag-off-dry-run', argv };
    if (opts.dryRun === true) return { ...result, ok: true, argv };
    await deps.gh(argv);
    return { ...result, ok: true, argv, dispatched: true };
  } catch (error) {
    const detail = String((error as Error).message ?? error).slice(0, 160);
    return { ...result, argv, reason: `${stage}-error:${detail}` };
  }
}
