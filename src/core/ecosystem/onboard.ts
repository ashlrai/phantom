/**
 * `ashlr ecosystem up` — one-command, idempotent onboarding of the whole Ashlr
 * ecosystem into autonomous Phantom work.
 *
 * Steps (every one is re-runnable and reports `already` when nothing changes):
 *   1. github     — `gh auth status` must pass (read-only).
 *   2. workspace  — find each ecosystem repo (workspace root, then any enrolled
 *                   path with the same name) or clone it into the workspace.
 *   3. enroll     — add each repo to ~/.ashlr/enrollment.json.
 *   4. doctor     — per repo: auto-merge on, required CI checks present, no
 *                   ashlr/verify requirement. Never writes to GitHub; prints the
 *                   exact fix command instead.
 *   5. grant      — one summary of scope, then sign a standing grant that names
 *                   every ecosystem repo (Touch ID via `ashlr authority grant`).
 *   6. schedule   — ensure the ecosystem steward automations exist and are on.
 *   7. resident   — the daemon that runs the schedule (`ashlr authority
 *                   resident start`, always confirmed by the operator).
 *
 * The engine is dependency-injected so tests, the CLI, MCP and the web console
 * share one implementation. Signing a grant is NEVER possible from MCP or the
 * web console: those surfaces get `grant: waiting-on-you` with the command.
 */

import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';

export const ECOSYSTEM_OWNER = 'ashlrai';

/** The repos Phantom stewards as one ecosystem, in launch/priority order. */
export const ECOSYSTEM_REPOS: readonly { name: string; role: string }[] = Object.freeze([
  { name: 'phantom', role: 'the agent workbench itself (hub)' },
  { name: 'phantom-secrets', role: 'keeps real API keys out of agent context' },
  { name: 'lexicon', role: 'shared vocabulary / context MCP server' },
  { name: 'locus', role: 'code locality + retrieval MCP server' },
  { name: 'ashlr-stack', role: 'stack scaffolding CLI' },
  { name: 'ashlr-md', role: 'markdown tooling' },
  { name: 'ashlr-plugin', role: 'Claude Code / Codex plugin' },
]);

/** What a signed ecosystem grant lets agents do without asking. */
export const ECOSYSTEM_ALLOWED_ACTIONS: readonly string[] = Object.freeze([
  'open branches and pull requests in the repos above',
  'merge their own PRs once every required CI check is green (GitHub enforces the checks)',
  'fix red default branches, labelled issues and flaky tests on the schedule',
  'run local and subscription models inside the grant’s seat reserves',
]);

/** What always stays with the human, whatever the grant says. */
export const ECOSYSTEM_RESERVED_ACTIONS: readonly string[] = Object.freeze([
  'release tags and package publishing',
  'secret creation or rotation',
  'deleting repos, branches with history, or data',
  'any spend (metered spend is $0/day in this grant)',
  'outside messages: email, social, chat, issues on other people’s repos',
  'changes to CI gates, rulesets or the grant itself',
]);

export const ECOSYSTEM_AUTOMATION_PREFIX = 'Ecosystem steward: ';
/** Built-in automation templates the steward schedule is made from. */
export const ECOSYSTEM_AUTOMATION_TEMPLATES = Object.freeze(['fix-red-main', 'fix-labeled-issues', 'nightly-flaky-tests']);

export type StepStatus = 'done' | 'already' | 'waiting-on-you' | 'failed' | 'skipped' | 'planned';

export interface EcosystemFix {
  readonly why: string;
  readonly command: string;
}

export interface EcosystemRepoStatus {
  name: string;
  nameWithOwner: string;
  path: string | null;
  present: 'found' | 'cloned' | 'missing' | 'would-clone';
  enrolled: boolean;
  autoMerge: boolean | null;
  defaultBranch: string | null;
  requiredChecks: string[] | null;
  verifyRequired: boolean | null;
  inGrant: boolean;
  ok: boolean;
  fixes: EcosystemFix[];
}

export interface EcosystemStep {
  step: 'github' | 'workspace' | 'enroll' | 'doctor' | 'grant' | 'schedule' | 'resident';
  status: StepStatus;
  detail: string;
  command?: string;
}

export interface EcosystemReportV1 {
  schemaVersion: 1;
  kind: 'ashlr-ecosystem-up';
  generatedAt: string;
  mode: 'status' | 'dry-run' | 'apply';
  workspace: string;
  ready: boolean;
  steps: EcosystemStep[];
  repos: EcosystemRepoStatus[];
  grantScope: { repos: string[]; allowed: readonly string[]; reserved: readonly string[] };
  nextCommand: string | null;
}

export interface ExecResult { code: number; stdout: string; stderr: string }

export interface GrantState {
  state: 'active' | 'none' | 'paused' | 'expired' | 'unknown';
  repos: string[];
  grantSeq: number | null;
  eliteDirect: boolean;
}

export interface EcosystemDeps {
  now(): Date;
  exists(path: string): boolean;
  /** Read-only `gh`/`git` call (status probes). */
  run(bin: 'gh' | 'git', args: readonly string[], cwd?: string): Promise<ExecResult>;
  /** The one writing git/gh call: `gh repo clone`. */
  clone(nameWithOwner: string, dest: string): Promise<ExecResult>;
  listEnrolled(): string[];
  enroll(path: string): { ok: boolean; changed: boolean; reason?: string };
  grantState(): Promise<GrantState>;
  /** Signs + installs a new grant over the enrolled repos. CLI only. */
  signGrant?: (opts: { eliteDirect: boolean }) => Promise<{ ok: boolean; detail: string }>;
  confirm?: (question: string) => Promise<boolean>;
  automations: {
    list(): Promise<{ id: string; name: string; enabled: boolean }[]>;
    createFromTemplate(templateId: string, name: string): Promise<{ id: string }>;
    enable(id: string): Promise<void>;
  };
  residentState(): Promise<'running' | 'loaded' | 'not-loaded' | 'absent' | 'unknown'>;
}

export interface EcosystemOptions {
  workspace?: string;
  /** Plan only: no clone, enroll, grant or schedule writes. */
  dryRun?: boolean;
  /** Read-only status (doctor) — implies dryRun, skips nothing else. */
  statusOnly?: boolean;
  /** Skip the confirmation prompt before signing (Touch ID still applies). */
  yes?: boolean;
  /** Surfaces that may never sign (MCP, web). */
  allowGrant?: boolean;
  noClone?: boolean;
  noSchedule?: boolean;
  repos?: readonly string[];
}

export function defaultEcosystemWorkspace(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env['ASHLR_ECOSYSTEM_ROOT'];
  return resolve(fromEnv && fromEnv.trim() ? fromEnv : join(homedir(), 'ashlr'));
}

const VERIFY_CHECK = /^ashlr\/verify$/i;

/** PURE: locate a repo — workspace dir first, then an enrolled path with the same basename. */
export function locateRepo(name: string, workspace: string, enrolled: readonly string[], exists: (p: string) => boolean): string | null {
  const direct = join(workspace, name);
  if (exists(join(direct, '.git'))) return direct;
  const match = enrolled.find((p) => basename(p) === name && exists(join(p, '.git')));
  return match ?? null;
}

/** PURE: pull required check contexts out of `GET /repos/:o/:r/rules/branches/:b`. */
export function requiredChecksFromRules(rules: unknown): string[] {
  if (!Array.isArray(rules)) return [];
  const out = new Set<string>();
  for (const rule of rules) {
    if (!rule || typeof rule !== 'object') continue;
    const r = rule as { type?: unknown; parameters?: { required_status_checks?: { context?: unknown }[] } };
    if (r.type !== 'required_status_checks') continue;
    for (const c of r.parameters?.required_status_checks ?? []) if (typeof c.context === 'string') out.add(c.context);
  }
  return [...out].sort();
}

/** PURE: contexts from classic branch protection `.../protection/required_status_checks`. */
export function requiredChecksFromClassic(body: unknown): string[] {
  if (!body || typeof body !== 'object') return [];
  const b = body as { contexts?: unknown; checks?: { context?: unknown }[] };
  const out = new Set<string>();
  if (Array.isArray(b.contexts)) for (const c of b.contexts) if (typeof c === 'string') out.add(c);
  if (Array.isArray(b.checks)) for (const c of b.checks) if (typeof c?.context === 'string') out.add(c.context);
  return [...out].sort();
}

function parseJson(text: string): unknown {
  try { return JSON.parse(text) as unknown; } catch { return null; }
}

async function probeRepo(deps: EcosystemDeps, repo: EcosystemRepoStatus): Promise<void> {
  const meta = await deps.run('gh', ['api', `repos/${repo.nameWithOwner}`]);
  if (meta.code !== 0) {
    repo.fixes.push({ why: `cannot read ${repo.nameWithOwner} from GitHub`, command: 'gh auth refresh -h github.com -s repo,workflow' });
    return;
  }
  const m = parseJson(meta.stdout) as { allow_auto_merge?: boolean; default_branch?: string } | null;
  repo.autoMerge = m?.allow_auto_merge === true;
  repo.defaultBranch = typeof m?.default_branch === 'string' ? m.default_branch : 'main';
  if (!repo.autoMerge) repo.fixes.push({ why: 'auto-merge is off, so green agent PRs wait for a click', command: `gh repo edit ${repo.nameWithOwner} --enable-auto-merge` });
  const rules = await deps.run('gh', ['api', `repos/${repo.nameWithOwner}/rules/branches/${repo.defaultBranch}`]);
  if (rules.code !== 0) {
    repo.requiredChecks = null;
    repo.fixes.push({ why: 'could not read branch rules', command: `gh api repos/${repo.nameWithOwner}/rules/branches/${repo.defaultBranch}` });
    return;
  }
  const classic = await deps.run('gh', ['api', `repos/${repo.nameWithOwner}/branches/${repo.defaultBranch}/protection/required_status_checks`]);
  const checks = [...new Set([...requiredChecksFromRules(parseJson(rules.stdout)), ...(classic.code === 0 ? requiredChecksFromClassic(parseJson(classic.stdout)) : [])])].sort();
  repo.requiredChecks = checks;
  repo.verifyRequired = checks.some((c) => VERIFY_CHECK.test(c));
  if (checks.length === 0) {
    repo.fixes.push({ why: 'no required CI check guards the default branch, so agent merges are unverified', command: 'ashlr authority protect --print   # review, then: ashlr authority protect --apply' });
  }
  if (repo.verifyRequired) {
    repo.fixes.push({ why: 'ashlr/verify is required but only fleet PRs post it, so every other PR stalls', command: `gh api repos/${repo.nameWithOwner}/rulesets   # remove the ashlr/verify context from the ruleset that lists it` });
  }
}

/** PURE: the human-readable grant scope block, shared by CLI, MCP and web. */
export function grantScopeLines(repos: readonly string[]): string[] {
  return [
    `Repos (${repos.length}): ${repos.join(', ')}`,
    'Agents may, without asking:',
    ...ECOSYSTEM_ALLOWED_ACTIONS.map((a) => `  ✓ ${a}`),
    'Always reserved for you:',
    ...ECOSYSTEM_RESERVED_ACTIONS.map((a) => `  ✗ ${a}`),
  ];
}

export async function runEcosystemUp(deps: EcosystemDeps, opts: EcosystemOptions = {}): Promise<EcosystemReportV1> {
  const workspace = resolve(opts.workspace ?? defaultEcosystemWorkspace());
  const write = !opts.dryRun && !opts.statusOnly;
  const mode: EcosystemReportV1['mode'] = opts.statusOnly ? 'status' : opts.dryRun ? 'dry-run' : 'apply';
  const wanted = ECOSYSTEM_REPOS.filter((r) => !opts.repos || opts.repos.includes(r.name));
  const steps: EcosystemStep[] = [];
  const note = (s: EcosystemStep) => { steps.push(s); };

  // 1. GitHub auth
  const auth = await deps.run('gh', ['auth', 'status']);
  const ghOk = auth.code === 0;
  note(ghOk
    ? { step: 'github', status: 'already', detail: 'gh is signed in' }
    : { step: 'github', status: 'waiting-on-you', detail: 'gh is not signed in', command: 'gh auth login -h github.com -s repo,workflow' });

  // 2. workspace
  const enrolledBefore = deps.listEnrolled();
  const repos: EcosystemRepoStatus[] = [];
  let cloned = 0; let missing = 0;
  for (const r of wanted) {
    const nameWithOwner = `${ECOSYSTEM_OWNER}/${r.name}`;
    let path = locateRepo(r.name, workspace, enrolledBefore, deps.exists);
    let present: EcosystemRepoStatus['present'] = path ? 'found' : 'missing';
    const fixes: EcosystemFix[] = [];
    if (!path) {
      const dest = join(workspace, r.name);
      if (!write || opts.noClone || !ghOk) {
        present = write ? 'missing' : 'would-clone';
        if (write) { missing++; fixes.push({ why: 'repo is not on this machine', command: `gh repo clone ${nameWithOwner} ${dest}` }); }
      } else {
        const res = await deps.clone(nameWithOwner, dest);
        if (res.code === 0) { path = dest; present = 'cloned'; cloned++; }
        else { missing++; fixes.push({ why: `clone failed: ${res.stderr.trim().split('\n')[0] ?? ''}`, command: `gh repo clone ${nameWithOwner} ${dest}` }); }
      }
    }
    repos.push({ name: r.name, nameWithOwner, path, present, enrolled: false, autoMerge: null, defaultBranch: null, requiredChecks: null, verifyRequired: null, inGrant: false, ok: false, fixes });
  }
  const found = repos.filter((r) => r.path).length;
  note({
    step: 'workspace',
    status: missing > 0 ? 'failed' : cloned > 0 ? 'done' : repos.some((r) => r.present === 'would-clone') ? 'planned' : 'already',
    detail: `${found}/${repos.length} repos on disk under ${workspace.replace(homedir(), '~')}${cloned ? ` (${cloned} cloned)` : ''}${repos.some((r) => r.present === 'would-clone') ? ` (${repos.filter((r) => r.present === 'would-clone').length} to clone)` : ''}`,
  });

  // 3. enroll
  const enrolledSet = new Set(enrolledBefore.map((p) => resolve(p)));
  let newlyEnrolled = 0; let enrollFailed = 0; let toEnroll = 0;
  for (const repo of repos) {
    if (!repo.path) continue;
    if (enrolledSet.has(resolve(repo.path))) { repo.enrolled = true; continue; }
    if (!write) { toEnroll++; continue; }
    const res = deps.enroll(repo.path);
    if (res.ok) { repo.enrolled = true; newlyEnrolled++; }
    else { enrollFailed++; repo.fixes.push({ why: `enroll failed: ${res.reason ?? 'unknown'}`, command: `ashlr sandbox enroll ${repo.path}` }); }
  }
  const enrolledCount = repos.filter((r) => r.enrolled).length;
  note({
    step: 'enroll',
    status: enrollFailed ? 'failed' : newlyEnrolled ? 'done' : toEnroll ? 'planned' : 'already',
    detail: `${enrolledCount}/${repos.length} enrolled${newlyEnrolled ? ` (${newlyEnrolled} new)` : ''}${toEnroll ? ` (${toEnroll} to enroll)` : ''}`,
  });

  // 4. doctor (read-only GitHub probes)
  if (ghOk) for (const repo of repos) await probeRepo(deps, repo);
  const gateProblems = repos.filter((r) => r.autoMerge === false || (r.requiredChecks !== null && r.requiredChecks.length === 0) || r.verifyRequired === true || r.requiredChecks === null);
  note(ghOk
    ? { step: 'doctor', status: gateProblems.length ? 'waiting-on-you' : 'already', detail: gateProblems.length ? `${gateProblems.length} repo(s) need a fix: ${gateProblems.map((r) => r.name).join(', ')}` : 'auto-merge on and CI gates required on every repo' }
    : { step: 'doctor', status: 'skipped', detail: 'needs gh auth first' });

  // 5. grant
  const names = repos.map((r) => r.nameWithOwner);
  let grant = await deps.grantState();
  const covers = (g: GrantState) => names.every((n) => g.repos.some((x) => x.toLowerCase() === n.toLowerCase()));
  const grantCommand = 'ashlr ecosystem up';
  if (grant.state === 'active' && covers(grant)) {
    note({ step: 'grant', status: 'already', detail: `grant #${grant.grantSeq ?? '?'} covers all ${names.length} repos` });
  } else if (!write || opts.allowGrant === false || !deps.signGrant) {
    const why = grant.state === 'active' ? `grant #${grant.grantSeq ?? '?'} is missing ${names.filter((n) => !grant.repos.some((x) => x.toLowerCase() === n.toLowerCase())).map((n) => n.split('/')[1]).join(', ')}` : `no active grant (${grant.state})`;
    note({ step: 'grant', status: mode === 'apply' ? 'waiting-on-you' : 'planned', detail: `${why}; signing needs you (Touch ID)`, command: `${grantCommand}   # in your own terminal` });
  } else if (enrolledCount < repos.length) {
    note({ step: 'grant', status: 'waiting-on-you', detail: 'not every repo is enrolled yet; fix the workspace/enroll rows, then rerun', command: grantCommand });
  } else {
    const ok = opts.yes || (deps.confirm ? await deps.confirm(`Sign a standing grant for these ${names.length} repos (Touch ID)?`) : false);
    if (!ok) note({ step: 'grant', status: 'waiting-on-you', detail: 'not signed', command: grantCommand });
    else {
      const signed = await deps.signGrant({ eliteDirect: grant.eliteDirect });
      note({ step: 'grant', status: signed.ok ? 'done' : 'failed', detail: signed.detail, ...(signed.ok ? {} : { command: 'ashlr authority grant' }) });
      if (signed.ok) grant = await deps.grantState();
    }
  }
  for (const repo of repos) repo.inGrant = grant.state === 'active' && grant.repos.some((x) => x.toLowerCase() === repo.nameWithOwner.toLowerCase());

  // 6. schedule
  if (opts.noSchedule) note({ step: 'schedule', status: 'skipped', detail: '--no-schedule' });
  else {
    try {
      const existing = await deps.automations.list();
      let created = 0; let enabled = 0; let pending = 0;
      for (const template of ECOSYSTEM_AUTOMATION_TEMPLATES) {
        const name = `${ECOSYSTEM_AUTOMATION_PREFIX}${template}`;
        const have = existing.find((a) => a.name === name);
        if (have?.enabled) continue;
        if (!write) { pending++; continue; }
        const id = have?.id ?? (await deps.automations.createFromTemplate(template, name)).id;
        if (!have) created++;
        await deps.automations.enable(id); enabled++;
      }
      note({
        step: 'schedule',
        status: enabled ? 'done' : pending ? 'planned' : 'already',
        detail: enabled ? `${created} created, ${enabled} enabled (${ECOSYSTEM_AUTOMATION_TEMPLATES.join(', ')}) over every grant repo` : pending ? `${pending} steward automation(s) to enable` : `steward automations on (${ECOSYSTEM_AUTOMATION_TEMPLATES.join(', ')})`,
      });
    } catch (error) {
      note({ step: 'schedule', status: 'failed', detail: (error as Error).message, command: 'ashlr automations list' });
    }
  }

  // 7. resident daemon (observation only — starting it is always operator-confirmed)
  const resident = await deps.residentState().catch(() => 'unknown' as const);
  note(resident === 'running'
    ? { step: 'resident', status: 'already', detail: 'ai.ashlr.daemon is running the schedule' }
    : { step: 'resident', status: 'waiting-on-you', detail: `daemon is ${resident}; it runs the schedule once started`, command: 'ashlr authority resident start' });

  for (const repo of repos) repo.ok = !!repo.path && repo.enrolled && repo.fixes.length === 0 && repo.inGrant;
  const ready = steps.every((s) => s.status === 'already' || s.status === 'done' || s.status === 'skipped');
  const next = steps.find((s) => s.command && (s.status === 'waiting-on-you' || s.status === 'failed' || s.status === 'planned'));
  return {
    schemaVersion: 1,
    kind: 'ashlr-ecosystem-up',
    generatedAt: deps.now().toISOString(),
    mode,
    workspace,
    ready,
    steps,
    repos,
    grantScope: { repos: names, allowed: ECOSYSTEM_ALLOWED_ACTIONS, reserved: ECOSYSTEM_RESERVED_ACTIONS },
    nextCommand: ready ? null : next?.command ?? (mode !== 'apply' ? 'ashlr ecosystem up' : null),
  };
}

export { existsSync as defaultExists };
