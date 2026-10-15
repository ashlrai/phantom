/**
 * PR autopilot, the acting half: one tick for one pull request.
 *
 *   observe (github.ts) → plan (diagnose.ts) → act → record
 *
 * Acting happens in a throwaway detached worktree of the operator's checkout,
 * pinned to the exact head GitHub reported:
 *
 *   merge-base      `git merge origin/<base>`; conflicts go to the fixer, and
 *                   every conflict marker must be gone before anything commits
 *   fix-ci          the fixer gets the failing checks' log tails
 *   address-review  the fixer gets the review items on this head
 *   rerun           one re-run of an infrastructure failure, through GitHub
 *
 * Then: no fixer commits or history edits; no weakened checks (G1b
 * `detectTestTampering`, G1 `protectedPathHits`, and diagnose.ts
 * `weakeningRefusals`, on the fixer's diff and on every conflict resolution);
 * the `--verify` commands pass in the worktree; git config and hooks are
 * byte-identical to before the fixer ran; KILL and pause are re-read; and only
 * then one commit and a plain push to the push URL captured before the fixer
 * ran. Every git call after the fixer runs with hooks and fsmonitor disabled.
 * Never a force push, never `--admin`, never a merge: merging stays with the
 * promotion gate and branch protection. A head that moved is a refusal.
 *
 * The fixer is any command that reads the brief on stdin and edits files in
 * its working directory. The default, `claude -p --permission-mode
 * acceptEdits`, may edit files but is not granted shell commands. The fixer
 * and the --verify commands run with GitHub tokens, the SSH agent, the gh
 * config directory and global git config removed from their environment.
 * This is NOT a jail: they run as the operator and can read files under HOME.
 * Use a fixer you trust with that; the autopilot is the only thing that pushes.
 *
 * Every tick appends one row to `$ASHLR_HOME/autopilot/outcomes.jsonl` and
 * persists the per-PR bounds in `$ASHLR_HOME/autopilot/state/`.
 */
import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';

import { isHubRepositoryLabel } from '../authority/repository-binding.js';
import { detectTestTampering, protectedPathHits } from '../authority/protected-paths.js';
import { detectVerifyCommands } from '../run/verify-commands.js';

import { ashlrHome } from '../cloud/store.js';
import { scrubSecrets } from '../util/scrub.js';
import {
  DEFAULT_LIMITS,
  emptyState,
  fixBrief,
  plan as decide,
  weakeningRefusals,
  type AutopilotState,
  type DiffFile,
  type Guards,
  type Limits,
  type Observation,
  type Plan,
} from './diagnose.js';
import { defaultGh, observe, rerunJob, type Gh } from './github.js';

const mergeKey = (obs: Observation) => `merge-base:${obs.pr.headSha}:${obs.pr.baseSha}`;

export const DEFAULT_OWNED_PREFIXES = ['improve/', 'ashlr-cloud/', 'verse/', 'ashlr/proposal'] as const;

export type Run = (cmd: string, args: string[], opts: { cwd: string; timeoutMs?: number; input?: string; env?: NodeJS.ProcessEnv }) => Promise<{ code: number; stdout: string; stderr: string }>;

export const defaultRun: Run = (cmd, args, opts) => new Promise((resolve) => {
  const child = spawn(cmd, args, { cwd: opts.cwd, env: opts.env ?? process.env, stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  let stdout = '';
  let stderr = '';
  const cap = (s: string, d: Buffer) => (s + d.toString('utf8')).slice(-256 * 1024);
  child.stdout.on('data', (d: Buffer) => { stdout = cap(stdout, d); });
  child.stderr.on('data', (d: Buffer) => { stderr = cap(stderr, d); });
  const timer = setTimeout(() => {
    try { if (child.pid) process.kill(process.platform === 'win32' ? child.pid : -child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); }
  }, opts.timeoutMs ?? 120_000);
  child.on('error', (err) => { clearTimeout(timer); resolve({ code: 127, stdout, stderr: stderr + String(err.message) }); });
  child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code: code ?? (signal ? 137 : 1), stdout, stderr }); });
  child.stdin.on('error', () => undefined);
  child.stdin.end(opts.input ?? '');
});

export interface TickOptions {
  repo: string;
  number: number;
  /** A local clone of `repo` with `origin` pointing at it. */
  checkout: string;
  /** false = report the plan only. */
  apply: boolean;
  /** argv of the fixer; null = no code changes (merge-base without conflicts and reruns still act). */
  fixer: string[] | null;
  /**
   * Each entry is one argv run in the worktree before pushing; all must exit 0.
   * Empty = the repository's own toolchain decides: its `quick` verify profile
   * (ashlr.verify.json or detected scripts, read before the fixer runs) plus
   * `vitest related --run` over the changed files when the repo uses vitest.
   */
  verify: string[][];
  ownedPrefixes?: readonly string[];
  limits?: Limits;
  gh?: Gh;
  run?: Run;
  /** Read before planning, again before a re-run, and again right before every push. */
  guards?: () => Pick<Guards, 'killSwitch' | 'paused'> | Promise<Pick<Guards, 'killSwitch' | 'paused'>>;
  fixerTimeoutMs?: number;
  now?: () => Date;
}

export interface TickResult {
  repo: string;
  number: number;
  headSha: string;
  plan: Plan['action'];
  reason: string;
  /** What happened when acting: pushed, rerun, refused, verify-failed, no-change, error, or `planned` without --apply. */
  result: 'planned' | 'pushed' | 'rerun' | 'refused' | 'verify-failed' | 'no-change' | 'error' | 'none';
  detail: string[];
  newHead: string | null;
}

export function autopilotDir(): string { return join(ashlrHome(), 'autopilot'); }
const stateFile = (repo: string, n: number) => join(autopilotDir(), 'state', `${repo.replace('/', '__')}__${n}.json`);

export function loadState(repo: string, n: number): AutopilotState {
  try {
    const raw = JSON.parse(readFileSync(stateFile(repo, n), 'utf8')) as Partial<AutopilotState>;
    const base = emptyState();
    return {
      pushes: Number.isSafeInteger(raw.pushes) ? raw.pushes! : 0,
      attempts: raw.attempts && typeof raw.attempts === 'object' ? raw.attempts : base.attempts,
      actedHeads: Array.isArray(raw.actedHeads) ? raw.actedHeads.slice(-50) : [],
      reruns: Array.isArray(raw.reruns) ? raw.reruns.slice(-100) : [],
      handledReviews: Array.isArray(raw.handledReviews) ? raw.handledReviews.slice(-500) : [],
    };
  } catch {
    return emptyState();
  }
}

function saveState(repo: string, n: number, s: AutopilotState): void {
  const file = stateFile(repo, n);
  mkdirSync(join(autopilotDir(), 'state'), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(s, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, file);
}

function record(row: TickResult, at: Date): void {
  try {
    mkdirSync(autopilotDir(), { recursive: true, mode: 0o700 });
    appendFileSync(join(autopilotDir(), 'outcomes.jsonl'), `${JSON.stringify({ v: 1, at: at.toISOString(), ...row, detail: row.detail.map((d) => scrubSecrets(d).slice(0, 500)) })}\n`, { mode: 0o600 });
  } catch { /* the ledger is evidence, never a reason to fail the tick */ }
}

/** One tick at a time per PR, across processes. A lock older than 2 hours is a crashed tick. */
function lock(repo: string, n: number): (() => void) | null {
  const path = `${stateFile(repo, n)}.lock`;
  mkdirSync(join(autopilotDir(), 'state'), { recursive: true, mode: 0o700 });
  try {
    if (existsSync(path) && Date.now() - statSync(path).mtimeMs > 2 * 60 * 60 * 1000) unlinkSync(path);
    closeSync(openSync(path, 'wx', 0o600));
  } catch {
    return null;
  }
  return () => { try { unlinkSync(path); } catch { /* gone */ } };
}

/** Without an explicit guard source the live KILL switch and pause flag decide. */
function defaultGuards(): Promise<Pick<Guards, 'killSwitch' | 'paused'>> {
  return liveGuards();
}

async function stopNow(opts: TickOptions): Promise<string | null> {
  const g = await (opts.guards ?? defaultGuards)();
  if (g.killSwitch) return 'the kill switch was engaged while acting; nothing pushed';
  if (g.paused) return 'Phantom was paused while acting; nothing pushed';
  return null;
}

/** Git with repository hooks and fsmonitor off: nothing the fixer planted in the tree runs. */
export const SAFE_GIT = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', 'core.sshCommand=ssh'];

/**
 * A digest of everything that changes what git runs or where it pushes: the
 * shared .git/config and hooks, the worktree's own git dir and `.git` link
 * file, and the operator's global git config. Compared before and after the
 * fixer (and verify) ran; any difference refuses the tick.
 */
export function gitControlDigest(commonDir: string, worktreeGitDir: string, worktree: string): string {
  const h = createHash('sha256');
  const add = (label: string, path: string) => {
    h.update(`\0${label}\0`);
    try { h.update(readFileSync(path)); } catch { h.update('<absent>'); }
  };
  add('config', join(commonDir, 'config'));
  add('wt-config', join(worktreeGitDir, 'config.worktree'));
  add('wt-gitdir', join(worktreeGitDir, 'gitdir'));
  add('wt-link', join(worktree, '.git'));
  add('global', join(homedir(), '.gitconfig'));
  add('xdg', join(process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config'), 'git', 'config'));
  for (const dir of [join(commonDir, 'hooks'), join(worktreeGitDir, 'hooks')]) {
    let names: string[] = [];
    try { names = readdirSync(dir).sort(); } catch { /* none */ }
    for (const n of names) add(`hook:${dir}:${n}`, join(dir, n));
  }
  return h.digest('hex');
}

/** Every reason a diff weakens checks or reaches protected paths. `files` is name-status + added lines. */
export function diffRefusals(repo: string, files: readonly DiffFile[], unifiedDiff: string): string[] {
  const out = weakeningRefusals(files);
  const tamper = detectTestTampering(unifiedDiff);
  if (tamper.parseError && files.length) out.push(`the diff could not be checked for test tampering (${tamper.parseError})`);
  out.push(...tamper.findings.map((f) => `${f.path}: ${f.detail}`));
  out.push(...protectedPathHits(files.map((f) => f.path), { selfRepo: isHubRepositoryLabel(repo) }).map((h) => `${h.path}: protected path (${h.why})`));
  return [...new Set(out)];
}

export async function liveGuards(): Promise<Pick<Guards, 'killSwitch' | 'paused'>> {
  const [{ killSwitchOn }, { isPaused }] = await Promise.all([import('../sandbox/policy.js'), import('../comms/pause.js')]);
  return { killSwitch: killSwitchOn(), paused: isPaused() };
}

/** `git diff -U0` → added lines per file, plus name-status. */
export function parseDiff(nameStatus: string, patch: string): DiffFile[] {
  const files = new Map<string, DiffFile>();
  for (const line of nameStatus.split('\n').filter(Boolean)) {
    const [status, ...paths] = line.split('\t');
    const path = paths[paths.length - 1]!;
    files.set(path, { path, status: status!.charAt(0), added: [] });
  }
  let current: DiffFile | null = null;
  for (const line of patch.split('\n')) {
    if (line.startsWith('+++ ')) { current = files.get(line.replace(/^\+\+\+ (b\/)?/, '')) ?? null; continue; }
    if (current && line.startsWith('+') && !line.startsWith('+++')) current.added.push(line.slice(1));
  }
  return [...files.values()];
}

export async function tick(opts: TickOptions): Promise<TickResult> {
  const now = opts.now ?? (() => new Date());
  const gh = opts.gh ?? defaultGh;
  const run = opts.run ?? defaultRun;
  const limits = opts.limits ?? DEFAULT_LIMITS;
  const base: TickResult = { repo: opts.repo, number: opts.number, headSha: '', plan: 'wait', reason: '', result: 'none', detail: [], newHead: null };
  const release = lock(opts.repo, opts.number);
  if (!release) return { ...base, plan: 'wait', reason: 'another autopilot tick holds this PR', result: 'none' };
  try {
    let obs: Observation;
    try {
      obs = await observe(opts.repo, opts.number, gh);
    } catch (err) {
      const row: TickResult = { ...base, plan: 'wait', reason: `could not read the PR: ${err instanceof Error ? err.message : String(err)}`, result: 'error' };
      record(row, now());
      return row;
    }
    const guards: Guards = { ...(await (opts.guards ?? defaultGuards)()), ownedPrefixes: opts.ownedPrefixes ?? DEFAULT_OWNED_PREFIXES };
    const state = loadState(opts.repo, opts.number);
    const p = decide(obs, guards, state, limits);
    const row: TickResult = { ...base, headSha: obs.pr.headSha, plan: p.action, reason: p.reason };
    if ('failures' in p && p.failures) row.detail.push(...p.failures.map((f) => `${f.cause}: ${f.why}`));
    row.detail.push(...(obs.droppedReviews ?? []));

    if (!['merge-base', 'fix-ci', 'address-review', 'rerun'].includes(p.action)) { record(row, now()); return row; }
    if (!opts.apply) { row.result = 'planned'; record(row, now()); return row; }

    if (p.action === 'rerun') {
      const stopped = await stopNow(opts);
      if (stopped) { row.result = 'refused'; row.detail.push(stopped); record(row, now()); return row; }
      for (const c of p.checks) {
        await rerunJob(opts.repo, c.id, gh);
        state.reruns.push(`${obs.pr.headSha}:${c.name}`);
      }
      saveState(opts.repo, opts.number, state);
      row.result = 'rerun';
      record(row, now());
      return row;
    }

    // Attempts are counted BEFORE acting, so a crash or a failed verify is never retried in a burst.
    if (p.action === 'merge-base') state.attempts[mergeKey(obs)] = (state.attempts[mergeKey(obs)] ?? 0) + 1;
    if (p.action === 'fix-ci') state.attempts[p.signature] = (state.attempts[p.signature] ?? 0) + 1;
    if (p.action === 'address-review') state.handledReviews.push(...p.reviews.map((r) => r.id));
    saveState(opts.repo, opts.number, state);

    const outcome = await actInWorktree(opts, obs, p as Extract<Plan, { action: 'merge-base' | 'fix-ci' | 'address-review' }>, run);
    Object.assign(row, { result: outcome.result, newHead: outcome.newHead });
    row.detail.push(...outcome.detail);
    if (outcome.result === 'pushed') {
      state.pushes++;
      state.actedHeads.push(obs.pr.headSha);
      saveState(opts.repo, opts.number, state);
    }
    record(row, now());
    return row;
  } finally {
    release();
  }
}

async function actInWorktree(opts: TickOptions, obs: Observation, p: Extract<Plan, { action: 'merge-base' | 'fix-ci' | 'address-review' }>, run: Run): Promise<Pick<TickResult, 'result' | 'detail' | 'newHead'>> {
  const { pr } = obs;
  const detail: string[] = [];
  const git = async (cwd: string, args: string[], timeoutMs = 120_000) => run('git', [...SAFE_GIT, ...args], { cwd, timeoutMs });
  const must = async (cwd: string, args: string[]) => {
    const r = await git(cwd, args);
    if (r.code !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr.trim().split('\n').pop() ?? '').slice(0, 200)}`);
    return r.stdout.trim();
  };
  const wt = join(mkdtempSync(join(tmpdir(), 'phm-autopilot-')), 'wt');
  let added = false;
  try {
    await must(opts.checkout, ['fetch', '--no-tags', 'origin', `+refs/heads/${pr.headRef}:refs/remotes/origin/${pr.headRef}`, `+refs/heads/${pr.baseRef}:refs/remotes/origin/${pr.baseRef}`]);
    const remoteHead = await must(opts.checkout, ['rev-parse', `refs/remotes/origin/${pr.headRef}`]);
    if (remoteHead !== pr.headSha) return { result: 'refused', detail: [`the branch moved to ${remoteHead.slice(0, 8)} since GitHub was read; next tick re-reads`], newHead: null };
    // Captured before any untrusted code runs: the push goes here, not to whatever `origin` says later.
    const pushUrl = await must(opts.checkout, ['remote', 'get-url', '--push', 'origin']);
    await must(opts.checkout, ['worktree', 'add', '--detach', wt, pr.headSha]);
    added = true;
    const abs = (p: string, from: string) => (isAbsolute(p) ? p : join(from, p));
    const commonDir = abs(await must(wt, ['rev-parse', '--git-common-dir']), wt);
    const wtGitDir = abs(await must(wt, ['rev-parse', '--git-dir']), wt);
    const control = gitControlDigest(commonDir, wtGitDir, wt);
    // The verify plan is read from the pinned head before untrusted code runs.
    const plannedVerify = verifyPlan(opts, wt);
    const tampered = () => (gitControlDigest(commonDir, wtGitDir, wt) !== control ? 'git config, hooks or the worktree link changed while the fixer or verify ran; nothing pushed' : null);
    const nm = join(opts.checkout, 'node_modules');
    if (existsSync(nm) && !existsSync(join(wt, 'node_modules'))) { try { symlinkSync(nm, join(wt, 'node_modules'), 'dir'); } catch { /* verify will say so */ } }

    let message: string;
    if (p.action === 'merge-base') {
      const merged = await git(wt, ['merge', '--no-edit', '--no-ff', `refs/remotes/origin/${pr.baseRef}`]);
      if (merged.code !== 0) {
        const conflicted = (await must(wt, ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean);
        if (!conflicted.length) return { result: 'error', detail: [`merge failed without conflicts: ${merged.stderr.trim().slice(0, 200)}`], newHead: null };
        if (!opts.fixer) { await git(wt, ['merge', '--abort']); return { result: 'refused', detail: [`conflicts in ${conflicted.join(', ')} and no fixer is configured`], newHead: null }; }
        const fx = await runFixer(opts, wt, fixBrief(p, pr, { conflicted }), run);
        detail.push(fx);
        const changedGit = tampered();
        if (changedGit) return { result: 'refused', detail: [...detail, changedGit], newHead: null };
        const left = (await must(wt, ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean);
        const markers = conflicted.filter((f) => { try { return /^(<{7}|>{7}|={7})( |$)/m.test(readFileSync(join(wt, f), 'utf8')); } catch { return false; } });
        if (markers.length) return { result: 'refused', detail: [...detail, `conflict markers remain in ${markers.join(', ')}`], newHead: null };
        await must(wt, ['add', '--', ...new Set([...conflicted, ...left])]);
        const rest = (await must(wt, ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean);
        if (rest.length) return { result: 'refused', detail: [...detail, `unresolved: ${rest.join(', ')}`], newHead: null };
        // The resolution is the fixer's work: scan it like any fix, against the pre-merge head.
        const resolved = parseDiff(await must(wt, ['diff', '--no-ext-diff', '--no-textconv', '--cached', '--name-status', pr.headSha, '--', ...conflicted]), (await git(wt, ['diff', '--no-ext-diff', '--no-textconv', '--cached', '-U0', pr.headSha, '--', ...conflicted])).stdout);
        const weak = diffRefusals(opts.repo, resolved, (await git(wt, ['diff', '--no-ext-diff', '--no-textconv', '--cached', pr.headSha, '--', ...conflicted])).stdout);
        if (weak.length) return { result: 'refused', detail: [...detail, ...weak], newHead: null };
        await must(wt, ['commit', '--no-edit', '--no-verify']);
      }
      message = '';
      const verified = await verify(plannedVerify, wt, run, (await git(wt, ['diff', '--no-ext-diff', '--no-textconv', '--name-only', pr.headSha, 'HEAD'])).stdout.split('\n').filter(Boolean));
      const afterVerify = tampered();
      if (afterVerify) return { result: 'refused', detail: [...detail, afterVerify], newHead: null };
      if (verified) return { result: 'verify-failed', detail: [...detail, verified], newHead: null };
    } else {
      if (!opts.fixer) return { result: 'refused', detail: ['a code fix is needed and no fixer is configured (--fixer)'], newHead: null };
      detail.push(await runFixer(opts, wt, fixBrief(p, pr), run));
      // Before ANY further git command: a planted filter driver or config would run inside it.
      const changedGit = tampered();
      if (changedGit) return { result: 'refused', detail: [...detail, changedGit], newHead: null };
      const head = await must(wt, ['rev-parse', 'HEAD']);
      if (head !== pr.headSha) return { result: 'refused', detail: [...detail, 'the fixer moved HEAD (commits are the autopilot\'s job); nothing pushed'], newHead: null };
      await must(wt, ['add', '-A']);
      const files = parseDiff(await must(wt, ['diff', '--no-ext-diff', '--no-textconv', '--cached', '--name-status']), (await git(wt, ['diff', '--no-ext-diff', '--no-textconv', '--cached', '-U0'])).stdout);
      if (!files.length) return { result: 'no-change', detail: [...detail, 'the fixer changed nothing'], newHead: null };
      const weak = diffRefusals(opts.repo, files, (await git(wt, ['diff', '--no-ext-diff', '--no-textconv', '--cached'])).stdout);
      if (weak.length) return { result: 'refused', detail: [...detail, ...weak], newHead: null };
      const verified = await verify(plannedVerify, wt, run, files.filter((f) => f.status !== 'D').map((f) => f.path));
      // Verify ran the head's own code: nothing it wrote to git config may reach the commit below.
      const afterVerify = tampered();
      if (afterVerify) return { result: 'refused', detail: [...detail, afterVerify], newHead: null };
      if (verified) return { result: 'verify-failed', detail: [...detail, verified], newHead: null };
      message = p.action === 'fix-ci'
        ? `autopilot: fix ${p.failures.map((f) => f.check.name).join(', ')} on #${pr.number}`
        : `autopilot: address review on #${pr.number}`;
      await must(wt, ['commit', '--no-verify', '-m', `${message.slice(0, 120)}\n\n${p.reason.slice(0, 600)}\n\nPhantom-Autopilot: ${p.action}${p.action === 'fix-ci' ? ` ${p.signature} attempt ${p.attempt}` : ''}`]);
    }
    const newHead = await must(wt, ['rev-parse', 'HEAD']);
    if (newHead === pr.headSha) return { result: 'no-change', detail: [...detail, 'already up to date with the base'], newHead: null };
    const changedGit = tampered();
    if (changedGit) return { result: 'refused', detail: [...detail, changedGit], newHead: null };
    const stopped = await stopNow(opts);
    if (stopped) return { result: 'refused', detail: [...detail, stopped], newHead: null };
    // A plain push: GitHub refuses it if the branch moved, and nothing here can force it.
    const pushed = await git(wt, ['push', '--no-verify', pushUrl, `HEAD:refs/heads/${pr.headRef}`], 180_000);
    if (pushed.code !== 0) return { result: 'refused', detail: [...detail, `push refused: ${pushed.stderr.trim().split('\n').pop()?.slice(0, 200) ?? ''}`], newHead: null };
    return { result: 'pushed', detail: [...detail, message || `merged ${pr.baseRef} into ${pr.headRef}`], newHead };
  } catch (err) {
    return { result: 'error', detail: [...detail, err instanceof Error ? err.message : String(err)], newHead: null };
  } finally {
    if (added) await git(opts.checkout, ['worktree', 'remove', '--force', '--force', wt]);
    try { rmSync(join(wt, '..'), { recursive: true, force: true }); } catch { /* tmp */ }
  }
}

/**
 * Env for the fixer and verify commands: no GitHub tokens, no SSH agent, an
 * empty gh config dir, no global/system git config (so no credential helper)
 * and no prompting. Reduces what untrusted code can push with; not a jail.
 */
function untrustedEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const k of Object.keys(env)) {
    if (/^(GH_|GITHUB_|GIT_CONFIG|GIT_ASKPASS|SSH_ASKPASS)/.test(k) || /TOKEN$/.test(k) && /GIT|GH/.test(k)) delete env[k];
  }
  delete env['SSH_AUTH_SOCK'];
  env['GH_CONFIG_DIR'] = mkdtempSync(join(tmpdir(), 'phm-autopilot-gh-'));
  env['GIT_CONFIG_GLOBAL'] = '/dev/null';
  env['GIT_CONFIG_NOSYSTEM'] = '1';
  env['GIT_TERMINAL_PROMPT'] = '0';
  env['GIT_ASKPASS'] = 'false';
  return env;
}

async function runFixer(opts: TickOptions, cwd: string, brief: string, run: Run): Promise<string> {
  const [cmd, ...args] = opts.fixer!;
  const r = await run(cmd!, args, { cwd, input: brief, timeoutMs: opts.fixerTimeoutMs ?? 30 * 60_000, env: untrustedEnv() });
  const said = (r.stdout.trim().split('\n').filter(Boolean).pop() ?? '').slice(0, 300);
  return `fixer exited ${r.code}${said ? `: ${scrubSecrets(said)}` : ''}`;
}

export interface VerifyStep { cmd: string[]; cwd?: string; timeoutMs?: number }
export interface VerifyPlan { steps: VerifyStep[]; affectedTests: boolean }

/** What re-verifies a change before it is pushed: explicit --verify, else the repo's own quick profile plus affected tests. */
export function verifyPlan(opts: Pick<TickOptions, 'verify'>, worktree: string): VerifyPlan {
  if (opts.verify.length) return { steps: opts.verify.map((cmd) => ({ cmd })), affectedTests: false };
  let steps: VerifyStep[] = [];
  try {
    steps = detectVerifyCommands(worktree, 'quick').filter((c) => c.kind !== 'test')
      .map((c) => ({ cmd: c.cmd, ...(c.cwd ? { cwd: c.cwd } : {}), ...(c.timeoutMs ? { timeoutMs: c.timeoutMs } : {}) }));
  } catch { /* no contract: affected tests alone */ }
  let vitest = false;
  try {
    const pkg = JSON.parse(readFileSync(join(worktree, 'package.json'), 'utf8')) as Record<string, Record<string, string> | undefined>;
    vitest = Boolean(pkg['devDependencies']?.['vitest'] ?? pkg['dependencies']?.['vitest']);
  } catch { /* not a node repo */ }
  return { steps, affectedTests: vitest };
}

/** null when every verify step passed, else the first failure in one line. */
async function verify(plan: VerifyPlan, worktree: string, run: Run, changed: readonly string[]): Promise<string | null> {
  const steps = [...plan.steps];
  const sources = changed.filter((f) => /\.[cm]?[jt]sx?$/.test(f));
  if (plan.affectedTests && sources.length) steps.push({ cmd: ['npx', '--no-install', 'vitest', 'related', '--run', '--passWithNoTests', ...sources], timeoutMs: 20 * 60_000 });
  for (const step of steps) {
    const [cmd, ...args] = step.cmd;
    const cwd = step.cwd && !isAbsolute(step.cwd) && !step.cwd.split('/').includes('..') ? join(worktree, step.cwd) : worktree;
    const r = await run(cmd!, args, { cwd, timeoutMs: step.timeoutMs ?? 20 * 60_000, env: untrustedEnv() });
    if (r.code !== 0) {
      const tail = `${r.stdout}\n${r.stderr}`.trim().split('\n').filter(Boolean).slice(-3).join(' | ');
      return `verify \`${step.cmd.join(' ')}\` exited ${r.code}: ${scrubSecrets(tail).slice(0, 400)}`;
    }
  }
  return null;
}
