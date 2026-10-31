/**
 * core/verse/self-update-apply.ts — the APPLY half of Hub self-update. The
 * read-only status route (`GET /api/verse/ops/self-update`) is a sibling job;
 * a follow-up wires `{action:'apply'}` onto it. This module owns no route.
 *
 * Steps, each timed and recorded: `git status --porcelain` must be empty
 * (else `refused`, "dirty tree"); `git fetch origin master` (60 s);
 * `rev-parse HEAD` + `rev-parse origin/master` + `merge-base --is-ancestor`
 * (equal → `already-current`, not ancestor → `refused` "diverged", strict
 * ancestor = provable fast-forward); then `<nodeBin> <cliEntry> update
 * --json` (10 min) — the repo's own updater (src/cli/update.ts) is spawned,
 * never imported into core. The durable result lands at
 * `<ashlrHome>/verse/self-update-last.json` (tmp + rename) before returning.
 * One apply at a time: concurrent callers share the in-flight promise.
 *
 * RESTART evidence (desktop/src-tauri, read-only). `detectRestartMode`
 * reports `sidecar-supervised` only on markers the desktop alone sets:
 *   - env `ASHLR_WEB_PUBLIC` — `command.env("ASHLR_WEB_PUBLIC", &public)` at
 *     main.rs:1076, consumed by src/core/web/server.ts `assetsDir()`;
 *   - argv `--desktop-token-handoff` — appended only by `sidecar_args`,
 *     main.rs:262 (only with the phone gateway on), parsed at
 *     src/cli/verse.ts:120.
 * Under supervision ANY exit of the live served sidecar — code or signal,
 * including our own SIGTERM — restarts it: `CommandEvent::Terminated` at
 * main.rs:1254-1322 forwards to `handle_unexpected_exit` when `was_live`,
 * `!is_exiting` and `served` (main.rs:1306-1307), which consults
 * `RestartPolicy::on_unexpected_exit` (sidecar_supervisor.rs:89; backoff
 * 1 s→30 s, gives up past 5 exits in 10 min). `scheduleRestart` SIGTERMs this
 * process after a short delay — the route flushes its response inside it and
 * src/cli/verse.ts's SIGTERM handler already shuts down cleanly.
 *
 * STABLE SURFACE (bridge contract): SelfUpdateRunner, SelfUpdateApplyDeps,
 * SelfUpdateApplyResult, applySelfUpdate, detectRestartMode, scheduleRestart.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, rename, unlink, writeFile as fsWriteFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { ashlrHome } from '../cloud/store.js';
import { scrubSecrets } from '../util/scrub.js';

export interface SelfUpdateRunResult {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** The seam tests fake: argv arrays only, never a shell. */
export interface SelfUpdateRunner {
  run(cmd: string, args: string[], opts: { cwd: string; timeoutMs: number }): Promise<SelfUpdateRunResult>;
}

export interface SelfUpdateApplyDeps {
  runner: SelfUpdateRunner;
  repoRoot: string;
  /** Absolute path to `dist/cli/index.js`. */
  cliEntry: string;
  nodeBin?: string /* default process.execPath */;
  now?: () => number;
  resultPath?: string /* default <ashlrHome>/verse/self-update-last.json */;
  writeFile?: (path: string, text: string) => Promise<void>;
}

export type SelfUpdateRestartMode = 'sidecar-supervised' | 'manual';
export interface SelfUpdateApplyResult {
  v: 1;
  startedAt: string;
  finishedAt: string;
  outcome: 'updated' | 'already-current' | 'refused' | 'failed';
  reason: string | null;
  fromCommit: string | null;
  toCommit: string | null;
  steps: Array<{ name: 'status' | 'fetch' | 'ahead' | 'update'; ok: boolean; ms: number; note: string | null }>;
  restart: { required: boolean; mode: SelfUpdateRestartMode };
}

const GIT_STEP_TIMEOUT_MS = 30_000, FETCH_TIMEOUT_MS = 60_000;
const UPDATE_TIMEOUT_MS = 10 * 60_000, RESTART_DELAY_MS = 750, STDERR_TAIL_LINES = 20;

function tail(text: string, max: number): string {
  return text.split('\n').map((l) => l.trimEnd()).filter(Boolean).slice(-max).join('\n');
}

/** Why a spawn ended badly — timeout first, else a scrubbed stderr tail. */
function failureNote(r: SelfUpdateRunResult, timeoutMs: number): string {
  const scrubbed = tail(scrubSecrets(r.stderr || r.stdout), STDERR_TAIL_LINES);
  return r.timedOut ? [`timedOut after ${timeoutMs} ms`, scrubbed].filter(Boolean).join('\n') : scrubbed || `exit ${r.code ?? 'null'}`;
}

/** The `ashlr update --json` payload fields we read (src/cli/update.ts UpdateResult). */
function updateReport(stdout: string): { updated?: unknown; upToDate?: unknown; commitAfter?: unknown; versionAfter?: unknown } | null {
  const text = stdout.trim();
  if (!text.startsWith('{')) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/** tmp + rename (connector-manager convention); advisory — a failed write must not mask the outcome. */
async function persist(path: string, result: SelfUpdateApplyResult, writeFile: (p: string, t: string) => Promise<void>): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(tmp, `${JSON.stringify(result, null, 2)}\n`);
    await rename(tmp, path);
  } catch { /* the returned object is the truth; the file is for after we are gone */ }
  finally { await unlink(tmp).catch(() => {}); }
}

/** The production runner: execFile, argv arrays only, git never prompts. */
export const realSelfUpdateRunner: SelfUpdateRunner = {
  run: (cmd, args, opts) => new Promise((resolveRun) => {
    execFile(cmd, args, {
      cwd: opts.cwd, timeout: opts.timeoutMs, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, windowsHide: true,
      env: { ...process.env, NO_COLOR: '1', GIT_TERMINAL_PROMPT: '0' },
    }, (error, stdout, stderr) => {
      const err = error as ({ code?: number | string; killed?: boolean } & Error) | null;
      resolveRun({
        code: err === null ? 0 : typeof err.code === 'number' ? err.code : null,
        stdout: stdout ?? '', stderr: stderr ?? '', timedOut: err !== null && err.killed === true,
      });
    });
  }),
};

/**
 * `sidecar-supervised` only on a marker the desktop alone sets (file header
 * for the Rust references); a hand-run `ashlr verse --no-open --json` shares
 * argv but has neither marker, so it is `manual` — SIGTERM there would just
 * stop the server.
 */
export function detectRestartMode(env: NodeJS.ProcessEnv, argv: readonly string[]): SelfUpdateRestartMode {
  return (env.ASHLR_WEB_PUBLIC ?? '') !== '' || argv.includes('--desktop-token-handoff')
    ? 'sidecar-supervised'
    : 'manual';
}

/**
 * In `sidecar-supervised` mode SIGTERM the own process after `delayMs`
 * (default 750 ms — the route's response flushes inside it); the supervisor
 * restarts us on the new build. `manual` schedules nothing. `exit` is part
 * of the frozen signature (future hard-exit fallback) and unused today.
 */
export function scheduleRestart(opts: {
  mode: SelfUpdateRestartMode;
  delayMs?: number;
  kill?: (signal: NodeJS.Signals) => void;
  exit?: (code: number) => void;
}): { scheduled: boolean; at: string | null } {
  if (opts.mode !== 'sidecar-supervised') return { scheduled: false, at: null };
  const delayMs = opts.delayMs ?? RESTART_DELAY_MS;
  const kill = opts.kill ?? ((signal: NodeJS.Signals): void => { process.kill(process.pid, signal); });
  const timer = setTimeout(() => kill('SIGTERM'), delayMs);
  timer.unref?.();
  return { scheduled: true, at: new Date(Date.now() + delayMs).toISOString() };
}

let inFlight: Promise<SelfUpdateApplyResult> | null = null;

/** Concurrent callers share the single in-flight apply — the same promise. */
export function applySelfUpdate(deps: SelfUpdateApplyDeps): Promise<SelfUpdateApplyResult> {
  if (inFlight) return inFlight;
  const p = runApply(deps);
  inFlight = p;
  const clear = (): void => { if (inFlight === p) inFlight = null; };
  p.then(clear, clear);
  return p;
}

type Step = SelfUpdateApplyResult['steps'][number];

async function runApply(deps: SelfUpdateApplyDeps): Promise<SelfUpdateApplyResult> {
  const now = deps.now ?? (() => Date.now());
  const nodeBin = deps.nodeBin ?? process.execPath;
  const writeFile = deps.writeFile ?? ((path, text) => fsWriteFile(path, text, { encoding: 'utf8', mode: 0o600 }));
  const resultPath = deps.resultPath ?? join(ashlrHome(), 'verse', 'self-update-last.json');
  const startedAt = new Date(now()).toISOString();
  const steps: Step[] = [];
  let fromCommit: string | null = null;
  let toCommit: string | null = null;

  /** A rejecting runner becomes a failed run result; apply never throws for a spawn. */
  const call = (cmd: string, args: string[], timeoutMs: number): Promise<SelfUpdateRunResult> =>
    deps.runner.run(cmd, args, { cwd: deps.repoRoot, timeoutMs }).catch((err: unknown): SelfUpdateRunResult => ({
      code: null, stdout: '', stderr: err instanceof Error ? err.message : String(err), timedOut: false,
    }));
  const git = (args: string[]): Promise<SelfUpdateRunResult> => call('git', args, GIT_STEP_TIMEOUT_MS);

  const finish = async (outcome: SelfUpdateApplyResult['outcome'], reason: string | null): Promise<SelfUpdateApplyResult> => {
    const result: SelfUpdateApplyResult = {
      v: 1, startedAt, finishedAt: new Date(now()).toISOString(), outcome, reason, fromCommit, toCommit, steps,
      restart: { required: outcome === 'updated', mode: detectRestartMode(process.env, process.argv) },
    };
    await persist(resultPath, result, writeFile);
    return result;
  };
  /** Record the step and end the apply (ok=false + outcome) or continue it (ok=true). */
  const step = (name: Step['name'], t0: number, ok: boolean, note: string | null, outcome?: SelfUpdateApplyResult['outcome'], reason: string | null = null): Promise<SelfUpdateApplyResult> | null => {
    steps.push({ name, ok, ms: Math.max(0, Math.round(now() - t0)), note });
    return outcome === undefined ? null : finish(outcome, reason);
  };

  // 1 — clean tree before any network traffic.
  let t0 = now();
  const status = await git(['status', '--porcelain']);
  let done = status.timedOut || status.code !== 0
    ? step('status', t0, false, failureNote(status, GIT_STEP_TIMEOUT_MS), 'failed', 'git status failed')
    : status.stdout.trim() !== ''
      ? step('status', t0, false, 'dirty tree', 'refused', 'dirty tree')
      : step('status', t0, true, null);
  if (done) return done;

  // 2 — refresh origin/master.
  t0 = now();
  const fetch = await call('git', ['fetch', 'origin', 'master'], FETCH_TIMEOUT_MS);
  done = fetch.timedOut || fetch.code !== 0
    ? step('fetch', t0, false, failureNote(fetch, FETCH_TIMEOUT_MS), 'failed', 'fetch failed')
    : step('fetch', t0, true, null);
  if (done) return done;

  // 3 — prove origin/master is a fast-forward of HEAD.
  t0 = now();
  const head = await git(['rev-parse', 'HEAD']);
  if (head.timedOut || head.code !== 0 || head.stdout.trim() === '') {
    return step('ahead', t0, false, failureNote(head, GIT_STEP_TIMEOUT_MS), 'failed', 'HEAD unresolvable')!;
  }
  fromCommit = head.stdout.trim();
  const remote = await git(['rev-parse', 'origin/master']);
  if (remote.timedOut || remote.code !== 0 || remote.stdout.trim() === '') {
    return step('ahead', t0, false, failureNote(remote, GIT_STEP_TIMEOUT_MS), 'failed', 'origin/master unresolvable')!;
  }
  toCommit = remote.stdout.trim();
  if (fromCommit === toCommit) {
    return step('ahead', t0, true, 'already up to date', 'already-current')!;
  }
  const ancestor = await git(['merge-base', '--is-ancestor', 'HEAD', 'origin/master']);
  done = ancestor.timedOut
    ? step('ahead', t0, false, `timedOut after ${GIT_STEP_TIMEOUT_MS} ms`, 'failed', 'merge-base timedOut')
    : ancestor.code !== 0
      ? step('ahead', t0, false, 'diverged', 'refused', 'diverged')
      : step('ahead', t0, true, 'origin/master is a fast-forward');
  if (done) return done;

  // 4 — the repo's own updater: pull --ff-only, install, build.
  t0 = now();
  const update = await call(nodeBin, [deps.cliEntry, 'update', '--json'], UPDATE_TIMEOUT_MS);
  if (update.timedOut) return step('update', t0, false, `timedOut after ${UPDATE_TIMEOUT_MS} ms`, 'failed', 'update timedOut')!;
  if (update.code !== 0) {
    return step('update', t0, false, tail(scrubSecrets(update.stderr || update.stdout), STDERR_TAIL_LINES) || `exit ${update.code}`, 'failed', 'update failed')!;
  }
  const report = updateReport(update.stdout);
  if (report?.updated === false && report.upToDate === true) {
    return step('update', t0, true, 'already up to date', 'already-current')!;
  }
  if (typeof report?.commitAfter === 'string' && report.commitAfter) toCommit = report.commitAfter;
  return step('update', t0, true, typeof report?.versionAfter === 'string' && report.versionAfter ? `updated to ${report.versionAfter}` : null, 'updated')!;
}
