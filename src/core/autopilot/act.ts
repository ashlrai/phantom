/**
 * PR autopilot, the acting half: one tick for one pull request.
 *
 *   observe (github.ts) → plan (diagnose.ts) → act → record
 *
 * Acting happens in a throwaway detached worktree of the operator's checkout,
 * pinned to the exact head GitHub reported:
 *
 *   recut           the conflicting lane's changes replayed onto the current
 *                   base (`git merge --squash <head>` on a fresh checkout of
 *                   origin/<base>), pushed as `<head>-recut`, then opened as a
 *                   replacement PR and requeued through the merge queue when
 *                   the lane itself was queued. The old PR is never closed
 *                   here — only after the recut merges does `close-superseded`
 *                   close it.
 *   merge-base      `git merge origin/<base>`, on a head a strict base would
 *                   refuse as behind; conflicts go to the fixer, and every
 *                   conflict marker must be gone before anything commits
 *   fix-ci          the fixer gets the failing checks' log tails
 *   address-review  the fixer gets the review items on this head
 *   rerun           one re-run of an infrastructure failure, through GitHub
 *   close-superseded  comment + close through GitHub, after the recut merged
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
import { AUTONOMOUS_UNSET_ENV } from '../sandbox/autonomous-env.js';

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
import { closePr, commentOnPr, createPr, defaultGh, observe, queuePrMerge, readPr, readPrByBranch, rerunJob, type Gh } from './github.js';
import type { PrView } from './diagnose.js';

const mergeKey = (obs: Observation) => `merge-base:${obs.pr.headSha}:${obs.pr.baseSha}`;
const recutKey = (obs: Observation) => `recut:${obs.pr.headSha}:${obs.pr.baseSha}`;

export const DEFAULT_OWNED_PREFIXES = ['improve/', 'ashlr-cloud/', 'verse/', 'ashlr/proposal'] as const;

/** Edits files from the brief on stdin; not granted shell commands. */
export const DEFAULT_FIXER: readonly string[] = ['claude', '-p', '--permission-mode', 'acceptEdits'];

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
  /** What happened when acting: pushed, recut (branch pushed and its PR opened), requeued a recut onto the merge queue, closed a superseded PR, rerun, refused, verify-failed, no-change, error, or `planned` without --apply. */
  result: 'planned' | 'pushed' | 'recut' | 'requeued' | 'closed' | 'rerun' | 'refused' | 'verify-failed' | 'no-change' | 'error' | 'none';
  detail: string[];
  newHead: string | null;
}

export function autopilotDir(): string { return join(ashlrHome(), 'autopilot'); }
const stateFile = (repo: string, n: number) => join(autopilotDir(), 'state', `${repo.replace('/', '__')}__${n}.json`);

export function loadState(repo: string, n: number): AutopilotState {
  try {
    const raw = JSON.parse(readFileSync(stateFile(repo, n), 'utf8')) as Partial<AutopilotState>;
    const base = emptyState();
    const r = raw.recut && typeof raw.recut === 'object' ? raw.recut : null;
    const recut = r && typeof r.branch === 'string' && r.branch && typeof r.fromHead === 'string' && r.fromHead
      ? { branch: r.branch, number: Number.isSafeInteger(r.number) ? r.number! : 0, fromHead: r.fromHead, ...(r.queued === true ? { queued: true } : {}) }
      : undefined;
    return {
      pushes: Number.isSafeInteger(raw.pushes) ? raw.pushes! : 0,
      recut,
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
export const SAFE_GIT = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgsign=false', '-c', 'tag.gpgsign=false', '-c', 'core.sshCommand=ssh',
  // Fixed diff path prefixes and quoting: parseDiff and the tamper scans read `+++ b/<path>`.
  '-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false', '-c', 'diff.srcPrefix=a/', '-c', 'diff.dstPrefix=b/', '-c', 'core.quotePath=false',
  // Fixed conflict style: the leftover-marker check reads merge markers only.
  '-c', 'merge.conflictStyle=merge'];

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

/**
 * The live state of the replacement a previous recut opened, for `obs.recut`.
 * A recorded PR number is read directly; a recut whose open was never
 * confirmed (number 0) is found by its branch head. null = unreadable.
 */
async function readRecut(repo: string, recut: { branch: string; number: number }, gh: Gh): Promise<Observation['recut']> {
  try {
    if (!recut.number) return await readPrByBranch(repo, recut.branch, gh);
    const p = await readPr(repo, recut.number, gh);
    return { number: p.number, state: p.state, merged: p.merged };
  } catch {
    return null;
  }
}

/** The replacement PR a recut opens: the lane's title and base, the fresh branch, and its provenance. */
function recutSpec(pr: PrView, branch: string): { title: string; head: string; base: string; body: string; draft: boolean } {
  return {
    title: pr.title || `recut of ${pr.headRef}`,
    head: branch,
    base: pr.baseRef,
    draft: pr.draft,
    body: `Recut of #${pr.number} (\`${pr.headRef}\` @ ${pr.headSha.slice(0, 8)}) onto the current \`${pr.baseRef}\`.\n\nThe original stays open until this merges; it is then closed as superseded.\n\nPhantom-Autopilot: recut`,
  };
}

const RECUT_QUEUE_ATTEMPTS = 3;

/**
 * Put a pushed recut back on the merge queue when the lane it replaces was
 * queued — the conflicting PR's auto-merge was armed, so its replacement goes
 * through the same sanctioned entry (`gh pr merge --auto --squash
 * --match-head-commit`): required checks and branch protection still decide.
 * `state.recut.queued` makes it once-only, so a repeated event never queues
 * twice. Bounded retries while the queue call keeps failing, then the line
 * says a person queues it. An unqueued lane's recut is never queued for it.
 */
async function requeueRecut(opts: TickOptions, obs: Observation, state: AutopilotState, gh: Gh): Promise<{ line: string; queued: boolean } | null> {
  const recut = state.recut;
  if (!recut?.number || recut.queued === true || !obs.pr.autoMerge) return null;
  const key = `recut-queue:${recut.branch}`;
  if ((state.attempts[key] ?? 0) >= RECUT_QUEUE_ATTEMPTS) return null;
  let head: string;
  try {
    const live = await readPr(opts.repo, recut.number, gh);
    if (live.state !== 'open') return null;
    head = live.headSha;
  } catch {
    return null; // unreadable this tick; the next one re-reads — no attempt spent
  }
  const stopped = await stopNow(opts);
  if (stopped) return { line: `${stopped}; recut #${recut.number} is open but not requeued`, queued: false };
  state.attempts[key] = (state.attempts[key] ?? 0) + 1;
  saveState(opts.repo, opts.number, state);
  try {
    await queuePrMerge(opts.repo, recut.number, head, gh);
    recut.queued = true;
    saveState(opts.repo, opts.number, state);
    return { line: `requeued recut #${recut.number} onto the merge queue (auto-merge pinned to ${head.slice(0, 8)}; required checks still decide)`, queued: true };
  } catch (err) {
    const last = (state.attempts[key] ?? 0) >= RECUT_QUEUE_ATTEMPTS;
    return { line: `could not requeue recut #${recut.number} on the merge queue: ${err instanceof Error ? err.message : String(err)}${last ? '; no more retries — a person queues it' : ''}`, queued: false };
  }
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
    // A recut supersedes this PR: the plan reads the replacement's live state.
    if (state.recut) {
      obs.recut = await readRecut(opts.repo, state.recut, gh);
      if (obs.recut && !state.recut.number) {
        state.recut.number = obs.recut.number;
        saveState(opts.repo, opts.number, state);
      }
    }
    const p = decide(obs, guards, state, limits);
    const row: TickResult = { ...base, headSha: obs.pr.headSha, plan: p.action, reason: p.reason };
    if ('failures' in p && p.failures) row.detail.push(...p.failures.map((f) => `${f.cause}: ${f.why}`));
    row.detail.push(...(obs.droppedReviews ?? []));

    // A queued lane's replacement belongs back on the merge queue as soon as
    // its PR exists — whatever this tick's plan is for the superseded PR —
    // so a queue a crashed or refused tick left pending is finished here.
    if (opts.apply && !['done', 'stop'].includes(p.action)) {
      const requeued = await requeueRecut(opts, obs, state, gh);
      if (requeued) {
        row.detail.push(requeued.line);
        if (requeued.queued && row.result === 'none') row.result = 'requeued';
      }
    }

    if (!['merge-base', 'fix-ci', 'address-review', 'rerun', 'recut', 'close-superseded'].includes(p.action)) { record(row, now()); return row; }
    if (!opts.apply) { row.result = 'planned'; record(row, now()); return row; }

    if (p.action === 'close-superseded') {
      const stopped = await stopNow(opts);
      if (stopped) { row.result = 'refused'; row.detail.push(stopped); record(row, now()); return row; }
      try {
        await commentOnPr(opts.repo, opts.number, `Superseded by #${p.recut}, which merged into ${obs.pr.baseRef}.`, gh);
      } catch (err) {
        row.detail.push(`could not leave the closing comment: ${err instanceof Error ? err.message : String(err)}`);
      }
      try {
        await closePr(opts.repo, opts.number, gh);
      } catch (err) {
        row.result = 'error';
        row.detail.push(`could not close the PR: ${err instanceof Error ? err.message : String(err)}`);
        record(row, now());
        return row;
      }
      row.result = 'closed';
      record(row, now());
      return row;
    }

    if (p.action === 'rerun') {
      const stopped = await stopNow(opts);
      if (stopped) { row.result = 'refused'; row.detail.push(stopped); record(row, now()); return row; }
      // Counted and saved before asking: a refused re-run, or a crash mid-request, is never retried.
      for (const c of p.checks) state.reruns.push(`${obs.pr.headSha}:${c.name}`);
      saveState(opts.repo, opts.number, state);
      for (const c of p.checks) {
        try {
          await rerunJob(opts.repo, c.id, gh);
        } catch (err) {
          row.result = 'error';
          row.detail.push(`could not re-run ${c.name}: ${err instanceof Error ? err.message : String(err)}`);
          record(row, now());
          return row;
        }
      }
      row.result = 'rerun';
      record(row, now());
      return row;
    }

    if (p.action === 'recut' && state.recut && !state.recut.number) {
      // The recut branch is already pushed; only its PR open is missing.
      const stopped = await stopNow(opts);
      if (stopped) { row.result = 'refused'; row.detail.push(stopped); record(row, now()); return row; }
      state.attempts[`recut-open:${state.recut.branch}`] = (state.attempts[`recut-open:${state.recut.branch}`] ?? 0) + 1;
      saveState(opts.repo, opts.number, state);
      try {
        state.recut.number = await createPr(opts.repo, recutSpec(obs.pr, state.recut.branch), gh);
        saveState(opts.repo, opts.number, state);
        row.result = 'recut';
        row.detail.push(`opened #${state.recut.number} on ${state.recut.branch}`);
        const requeued = await requeueRecut(opts, obs, state, gh);
        if (requeued) row.detail.push(requeued.line);
      } catch (err) {
        row.result = 'error';
        row.detail.push(`could not open the recut's PR: ${err instanceof Error ? err.message : String(err)}`);
      }
      record(row, now());
      return row;
    }

    // Attempts are counted BEFORE acting, so a crash or a failed verify is never retried in a burst.
    if (p.action === 'merge-base') state.attempts[mergeKey(obs)] = (state.attempts[mergeKey(obs)] ?? 0) + 1;
    if (p.action === 'recut') state.attempts[recutKey(obs)] = (state.attempts[recutKey(obs)] ?? 0) + 1;
    if (p.action === 'fix-ci') state.attempts[p.signature] = (state.attempts[p.signature] ?? 0) + 1;
    if (p.action === 'address-review') state.handledReviews.push(...p.reviews.map((r) => r.id));
    saveState(opts.repo, opts.number, state);

    const outcome = await actInWorktree(opts, obs, p as Extract<Plan, { action: 'merge-base' | 'fix-ci' | 'address-review' | 'recut' }>, run);
    Object.assign(row, { result: outcome.result, newHead: outcome.newHead });
    row.detail.push(...outcome.detail);
    if (outcome.recutBranch) {
      // The replacement branch is pushed; open its PR. The recut is recorded
      // with number 0 first, so a failure here is finished next tick — never re-cut.
      state.recut = { branch: outcome.recutBranch, number: 0, fromHead: obs.pr.headSha };
      const stopped = await stopNow(opts);
      if (stopped) {
        row.result = 'refused';
        row.detail.push(`${stopped}; the pushed recut branch's PR opens next tick`);
      } else {
        try {
          state.recut.number = await createPr(opts.repo, recutSpec(obs.pr, outcome.recutBranch), gh);
          row.result = 'recut';
          row.detail.push(`opened #${state.recut.number} on ${outcome.recutBranch}`);
          const requeued = await requeueRecut(opts, obs, state, gh);
          if (requeued) row.detail.push(requeued.line);
        } catch (err) {
          row.result = 'error';
          row.detail.push(`the recut branch ${outcome.recutBranch} is pushed but its PR could not be opened: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    if (outcome.result === 'pushed' || outcome.recutBranch) {
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

interface WorktreeOutcome {
  result: TickResult['result'];
  detail: string[];
  newHead: string | null;
  /** The fresh branch a recut pushed (`<headRef>-recut`); the caller opens its PR. */
  recutBranch?: string;
}

async function actInWorktree(opts: TickOptions, obs: Observation, p: Extract<Plan, { action: 'merge-base' | 'fix-ci' | 'address-review' | 'recut' }>, run: Run): Promise<WorktreeOutcome> {
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
    // A recut starts from the current base, not the PR head: the lane's changes
    // are replayed on top, which is exactly what `merge --squash <head>` stages.
    await must(opts.checkout, ['worktree', 'add', '--detach', wt, p.action === 'recut' ? `refs/remotes/origin/${pr.baseRef}` : pr.headSha]);
    added = true;
    // The worktree's start commit: the pre-merge head, or the fetched base for a recut.
    const startSha = await must(wt, ['rev-parse', 'HEAD']);
    const abs = (p: string, from: string) => (isAbsolute(p) ? p : join(from, p));
    const commonDir = abs(await must(wt, ['rev-parse', '--git-common-dir']), wt);
    const wtGitDir = abs(await must(wt, ['rev-parse', '--git-dir']), wt);
    const control = gitControlDigest(commonDir, wtGitDir, wt);
    // The verify plan is read from the pinned head before untrusted code runs.
    const plannedVerify = verifyPlan(opts, wt);
    // HEAD and the staged tree, so what is committed is exactly what was scanned.
    const snapshot = async () => ({ head: await must(wt, ['rev-parse', 'HEAD']), tree: await must(wt, ['write-tree']) });
    const moved = async (was: { head: string; tree: string }) => {
      const now = await snapshot();
      return now.head !== was.head || now.tree !== was.tree ? 'HEAD or the staged tree changed while verify ran; nothing pushed' : null;
    };
    const tampered = () => (gitControlDigest(commonDir, wtGitDir, wt) !== control ? 'git config, hooks or the worktree link changed while the fixer or verify ran; nothing pushed' : null);
    const nm = join(opts.checkout, 'node_modules');
    // Borrow the checkout's installed dependencies for verify. The link is the autopilot's, never part of a commit.
    let linkedModules = false;
    if (existsSync(nm) && !existsSync(join(wt, 'node_modules'))) { try { symlinkSync(nm, join(wt, 'node_modules'), 'dir'); linkedModules = true; } catch { /* verify will say so */ } }

    let message: string;
    let targetRef = `refs/heads/${pr.headRef}`;
    if (p.action === 'merge-base' || p.action === 'recut') {
      const merged = await git(wt, p.action === 'merge-base'
        ? ['merge', '--no-edit', '--no-ff', `refs/remotes/origin/${pr.baseRef}`]
        : ['merge', '--squash', pr.headSha]);
      if (merged.code !== 0) {
        const conflicted = (await must(wt, ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean);
        if (!conflicted.length) return { result: 'error', detail: [`merge failed without conflicts: ${merged.stderr.trim().slice(0, 200)}`], newHead: null };
        if (!opts.fixer) { await git(wt, p.action === 'recut' ? ['reset', '--hard', 'HEAD'] : ['merge', '--abort']); return { result: 'refused', detail: [`conflicts in ${conflicted.join(', ')} and no fixer is configured`], newHead: null }; }
        // The commit takes the whole index, but only the conflicted files are the fixer's to change.
        const stagedOutside = async () => {
          const raw = await must(wt, ['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--cached', '--raw', '--abbrev=40', startSha]);
          return raw.split('\n').filter((l) => l && !conflicted.includes(l.slice(l.indexOf('\t') + 1))).join('\n');
        };
        const outsideBefore = await stagedOutside();
        const fx = await runFixer(opts, wt, fixBrief(p, pr, { conflicted }), run);
        detail.push(fx);
        const changedGit = tampered();
        if (changedGit) return { result: 'refused', detail: [...detail, changedGit], newHead: null };
        if (await must(wt, ['rev-parse', 'HEAD']) !== startSha) return { result: 'refused', detail: [...detail, 'the fixer moved HEAD during the merge; nothing pushed'], newHead: null };
        if (await stagedOutside() !== outsideBefore) return { result: 'refused', detail: [...detail, 'the fixer changed the index outside the conflicted files; nothing pushed'], newHead: null };
        const left = (await must(wt, ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean);
        const markers = conflicted.filter((f) => { try { return /^(<{7}|>{7}|={7})( |$)/m.test(readFileSync(join(wt, f), 'utf8')); } catch { return false; } });
        if (markers.length) return { result: 'refused', detail: [...detail, `conflict markers remain in ${markers.join(', ')}`], newHead: null };
        await must(wt, ['add', '--', ...new Set([...conflicted, ...left])]);
        const rest = (await must(wt, ['diff', '--no-ext-diff', '--no-textconv', '--name-only', '--diff-filter=U'])).split('\n').filter(Boolean);
        if (rest.length) return { result: 'refused', detail: [...detail, `unresolved: ${rest.join(', ')}`], newHead: null };
        // The resolution is the fixer's work: scan it like any fix, against the pre-merge head.
        const resolved = parseDiff(await must(wt, ['diff', '--no-ext-diff', '--no-textconv', '--cached', '--name-status', startSha, '--', ...conflicted]), (await git(wt, ['diff', '--no-ext-diff', '--no-textconv', '--cached', '-U0', startSha, '--', ...conflicted])).stdout);
        const weak = diffRefusals(opts.repo, resolved, (await git(wt, ['diff', '--no-ext-diff', '--no-textconv', '--cached', startSha, '--', ...conflicted])).stdout);
        if (weak.length) return { result: 'refused', detail: [...detail, ...weak], newHead: null };
      }
      if (p.action === 'recut') {
        // Everything staged is the lane's change set: a lane PR may never carry
        // protected paths, and a recut may never smuggle one into a fresh PR.
        const staged = (await must(wt, ['diff', '--no-ext-diff', '--no-textconv', '--cached', '--name-only', startSha])).split('\n').filter(Boolean);
        if (!staged.length) return { result: 'no-change', detail: [...detail, `the PR's changes are already in ${pr.baseRef}; there is nothing to recut`], newHead: null };
        const protectedHits = protectedPathHits(staged, { selfRepo: isHubRepositoryLabel(opts.repo) });
        if (protectedHits.length) return { result: 'refused', detail: [...detail, ...protectedHits.map((h) => `${h.path}: protected path (${h.why})`)], newHead: null };
        await must(wt, ['commit', '--no-verify', '-m', `${(pr.title || `recut of ${pr.headRef}`).slice(0, 120)}\n\nSquashed recut of #${pr.number} (${pr.headRef} @ ${pr.headSha.slice(0, 8)}) onto ${pr.baseRef}.\n\nPhantom-Autopilot: recut`]);
      } else if (merged.code !== 0) {
        await must(wt, ['commit', '--no-edit', '--no-verify']);
      }
      message = '';
      const before = await snapshot();
      const verified = await verify(plannedVerify, wt, run, (await git(wt, ['diff', '--no-ext-diff', '--no-textconv', '--name-only', startSha, 'HEAD'])).stdout.split('\n').filter(Boolean));
      const afterVerify = tampered() ?? await moved(before);
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
      await must(wt, ['add', '-A', '--', '.', ...(linkedModules ? [':(exclude,top)node_modules'] : [])]);
      const files = parseDiff(await must(wt, ['diff', '--no-ext-diff', '--no-textconv', '--cached', '--name-status']), (await git(wt, ['diff', '--no-ext-diff', '--no-textconv', '--cached', '-U0'])).stdout);
      if (!files.length) return { result: 'no-change', detail: [...detail, 'the fixer changed nothing'], newHead: null };
      const weak = diffRefusals(opts.repo, files, (await git(wt, ['diff', '--no-ext-diff', '--no-textconv', '--cached'])).stdout);
      if (weak.length) return { result: 'refused', detail: [...detail, ...weak], newHead: null };
      const before = await snapshot();
      const verified = await verify(plannedVerify, wt, run, files.filter((f) => f.status !== 'D').map((f) => f.path));
      // Verify ran the head's own code: nothing it wrote to git config, HEAD or the index may reach the commit below.
      const afterVerify = tampered() ?? await moved(before);
      if (afterVerify) return { result: 'refused', detail: [...detail, afterVerify], newHead: null };
      if (verified) return { result: 'verify-failed', detail: [...detail, verified], newHead: null };
      message = p.action === 'fix-ci'
        ? `autopilot: fix ${p.failures.map((f) => f.check.name).join(', ')} on #${pr.number}`
        : `autopilot: address review on #${pr.number}`;
      await must(wt, ['commit', '--no-verify', '-m', `${message.slice(0, 120)}\n\n${p.reason.slice(0, 600)}\n\nPhantom-Autopilot: ${p.action}${p.action === 'fix-ci' ? ` ${p.signature} attempt ${p.attempt}` : ''}`]);
    }
    const newHead = await must(wt, ['rev-parse', 'HEAD']);
    if (newHead === (p.action === 'merge-base' || p.action === 'recut' ? startSha : pr.headSha)) return { result: 'no-change', detail: [...detail, 'already up to date with the base'], newHead: null };
    const changedGit = tampered();
    if (changedGit) return { result: 'refused', detail: [...detail, changedGit], newHead: null };
    const stopped = await stopNow(opts);
    if (stopped) return { result: 'refused', detail: [...detail, stopped], newHead: null };
    if (p.action === 'recut') {
      // One fresh branch per conflicting lane PR: <head>-recut, then -recut-2…
      const listed = await git(opts.checkout, ['ls-remote', '--heads', pushUrl, `${pr.headRef}-recut*`]);
      if (listed.code !== 0) return { result: 'error', detail: [...detail, `could not list origin's recut branches: ${(listed.stderr.trim().split('\n').pop() ?? '').slice(0, 200)}`], newHead: null };
      const used = new Set(listed.stdout.split('\n').map((l) => l.split('\t')[1]?.replace('refs/heads/', '')).filter(Boolean));
      let branch: string | null = null;
      for (let i = 1; i <= 20 && !branch; i++) {
        const candidate = i === 1 ? `${pr.headRef}-recut` : `${pr.headRef}-recut-${i}`;
        if (!used.has(candidate)) branch = candidate;
      }
      if (!branch) return { result: 'refused', detail: [...detail, `every recut branch name under ${pr.headRef}-recut is taken on origin; a person cleans up`], newHead: null };
      targetRef = `refs/heads/${branch}`;
    }
    // A plain push: GitHub refuses it if the branch moved, and nothing here can force it.
    const pushed = await git(wt, ['push', '--no-verify', pushUrl, `HEAD:${targetRef}`], 180_000);
    if (pushed.code !== 0) return { result: 'refused', detail: [...detail, `push refused: ${pushed.stderr.trim().split('\n').pop()?.slice(0, 200) ?? ''}`], newHead: null };
    if (p.action === 'recut') {
      return { result: 'pushed', detail: [...detail, `recut ${pr.headRef} onto ${pr.baseRef} as ${targetRef.replace('refs/heads/', '')}`], newHead, recutBranch: targetRef.replace('refs/heads/', '') };
    }
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
 * empty gh config dir, no global/system git config (so no credential helper),
 * no prompting, and no other credential-shaped variables. Verify runs the PR's
 * own code, so it gets no model credentials either; the fixer keeps only the
 * Anthropic and Claude variables its CLI signs in with. Reduces what untrusted
 * code can push or read with; not a jail.
 */
export function untrustedEnv(role: 'fixer' | 'verify', base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...base };
  const fixerAuth = (k: string) => role === 'fixer' && /^(ANTHROPIC_|CLAUDE_)/.test(k);
  for (const k of Object.keys(env)) {
    if (fixerAuth(k)) continue;
    if (/^(GH_|GITHUB_|GIT_CONFIG|GIT_ASKPASS|SSH_ASKPASS|AWS_|AZURE_|GOOGLE_APPLICATION_CREDENTIALS$)/.test(k) || /TOKEN$/.test(k) && /GIT|GH/.test(k)) delete env[k];
    else if (/(TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|ACCESS_KEY|PRIVATE_KEY|SECRET_KEY|AUTH_CONFIG|(^|_)AUTH|CREDENTIALS?)$/i.test(k)) delete env[k];
  }
  for (const k of AUTONOMOUS_UNSET_ENV) if (!fixerAuth(k)) delete env[k];
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
  const r = await run(cmd!, args, { cwd, input: brief, timeoutMs: opts.fixerTimeoutMs ?? 30 * 60_000, env: untrustedEnv('fixer') });
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
    const r = await run(cmd!, args, { cwd, timeoutMs: step.timeoutMs ?? 20 * 60_000, env: untrustedEnv('verify') });
    if (r.code !== 0) {
      const tail = `${r.stdout}\n${r.stderr}`.trim().split('\n').filter(Boolean).slice(-3).join(' | ');
      return `verify \`${step.cmd.join(' ')}\` exited ${r.code}: ${scrubSecrets(tail).slice(0, 400)}`;
    }
  }
  return null;
}
