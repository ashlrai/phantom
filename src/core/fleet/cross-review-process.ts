/**
 * The reviewer process for cross-model review (cross-review.ts). One review =
 * one child process that shares nothing with the producer or with any other
 * review (RQ-SUPERVISOR requirement 7):
 *  - argv only, `shell: false`: job text never reaches a shell, and never argv
 *    either: the prompt is written to the child's stdin;
 *  - a fresh 0700 scratch root per review (cwd, HOME, TMPDIR, XDG dirs), empty
 *    and removed afterwards, so there is no shared memory or scratch file and
 *    no `~/.config/gh`, `~/.ssh` or `~/.ashlr` to find through HOME;
 *  - an env built from nothing (buildReviewerEnv), never a filtered copy of
 *    the parent's: PATH, the scratch dirs, locale, and only the model
 *    credential names the reviewer's family is allowed. GitHub, git, ssh and
 *    cloud names are refused even if a policy lists them;
 *  - its own process group, killed on timeout or on output past the cap;
 *  - stderr is counted, never kept: it may echo the prompt (job text).
 */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FORBIDDEN_CREDENTIAL_ENV_RE, parseReviewVerdict, reviewerLaunchProblem, type CrossReviewer, type ReviewFailure, type ReviewVerdict } from './cross-review.js';

/** Reviewer stdout cap; a verdict is a few hundred bytes. */
export const REVIEWER_MAX_OUTPUT_BYTES = 64 * 1024;

export interface ReviewerScratch {
  root: string;
  cwd: string;
  home: string;
  tmp: string;
}

function makeScratch(): ReviewerScratch {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'ashlr-xreview-')));
  const scratch = { root, cwd: join(root, 'work'), home: join(root, 'home'), tmp: join(root, 'tmp') };
  for (const dir of [scratch.cwd, scratch.home, scratch.tmp, join(root, 'home', '.config'), join(root, 'home', '.cache')]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  return scratch;
}

/**
 * The complete reviewer env. Built from nothing; `parentEnv` is consulted for
 * PATH and for the reviewer's allowed credential names only.
 */
export function buildReviewerEnv(reviewer: Pick<CrossReviewer, 'credentialEnv'>, scratch: ReviewerScratch, parentEnv: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: parentEnv['PATH'] ?? '/usr/bin:/bin',
    HOME: scratch.home,
    TMPDIR: scratch.tmp,
    XDG_CONFIG_HOME: join(scratch.home, '.config'),
    XDG_CACHE_HOME: join(scratch.home, '.cache'),
    XDG_DATA_HOME: join(scratch.home, '.local', 'share'),
    LANG: 'en_US.UTF-8',
    NO_COLOR: '1',
    // Even with no credential, no git or gh call from the child may prompt or read global config.
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GH_PROMPT_DISABLED: '1',
  };
  for (const name of reviewer.credentialEnv) {
    if (FORBIDDEN_CREDENTIAL_ENV_RE.test(name)) continue;
    const value = parentEnv[name];
    if (typeof value === 'string' && value.length > 0 && !/[\0\r\n]/.test(value)) env[name] = value;
  }
  return env;
}

export type ReviewerRun =
  | { ok: true; verdict: ReviewVerdict }
  | { ok: false; failure: ReviewFailure | 'launch-refused' };

export interface ReviewerRunOptions {
  parentEnv?: NodeJS.ProcessEnv;
  /** Test seam: observe the scratch root before it is removed. */
  onScratch?: (scratch: ReviewerScratch) => void;
}

/** Run one review in its own isolated process. Never throws; every failure is a failed review (escalates). */
export async function runReviewerProcess(reviewer: CrossReviewer, prompt: string, options: ReviewerRunOptions = {}): Promise<ReviewerRun> {
  if (reviewerLaunchProblem(reviewer) !== null) return { ok: false, failure: 'launch-refused' };
  let scratch: ReviewerScratch;
  try { scratch = makeScratch(); } catch { return { ok: false, failure: 'spawn-failed' }; }
  options.onScratch?.(scratch);
  try {
    const env = buildReviewerEnv(reviewer, scratch, options.parentEnv ?? process.env);
    const result = await new Promise<{ code: number | null; stdout: Buffer; timedOut: boolean; overflow: boolean; spawnError: boolean }>((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(reviewer.bin, reviewer.args, {
          cwd: scratch.cwd,
          env,
          shell: false,
          detached: process.platform !== 'win32',
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } catch {
        resolve({ code: null, stdout: Buffer.alloc(0), timedOut: false, overflow: false, spawnError: true });
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      let timedOut = false;
      let overflow = false;
      let spawnError = false;
      const killGroup = (): void => {
        try {
          if (child.pid !== undefined && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch { /* already gone */ }
      };
      const timer = setTimeout(() => { timedOut = true; killGroup(); }, reviewer.timeoutMs);
      child.stdout!.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > REVIEWER_MAX_OUTPUT_BYTES) { overflow = true; killGroup(); return; }
        chunks.push(chunk);
      });
      child.stderr!.resume();
      child.stdin!.on('error', () => { /* child closed stdin early; its exit status decides */ });
      child.on('error', () => { spawnError = true; });
      child.on('close', (code) => {
        clearTimeout(timer);
        // Reap anything the reviewer left behind in its group.
        killGroup();
        resolve({ code, stdout: Buffer.concat(chunks), timedOut, overflow, spawnError });
      });
      child.stdin!.end(prompt, 'utf8');
    });
    if (result.spawnError) return { ok: false, failure: 'spawn-failed' };
    if (result.timedOut) return { ok: false, failure: 'timeout' };
    if (result.overflow) return { ok: false, failure: 'output-too-large' };
    if (result.code !== 0) return { ok: false, failure: 'exit-nonzero' };
    const verdict = parseReviewVerdict(result.stdout.toString('utf8'));
    return verdict ? { ok: true, verdict } : { ok: false, failure: 'unparseable-verdict' };
  } finally {
    try { rmSync(scratch.root, { recursive: true, force: true }); } catch { /* temp dir; best effort */ }
  }
}
