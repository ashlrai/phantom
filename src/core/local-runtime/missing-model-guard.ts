/**
 * The missing-model guard — one clear blocked state for a launchd job whose
 * GGUF is gone.
 *
 * The launch agent's shim (see llama/launchd.ts) re-resolves the Ollama blob
 * at every start because the store is content-addressed: a re-pull or retag
 * garbage collects the digest that was current at install time. Until now an
 * UNRESOLVABLE miss still fell through to `exec llama-server -m <missing>`,
 * which exits immediately — and launchd's unconditional `KeepAlive` with
 * `ThrottleInterval 10` respawned it every ten seconds forever. That is the
 * Nov 1 incident: `~/.ollama` was recreated empty, the blob was gone, and the
 * job burned process starts on a machine already at load 126.
 *
 * A missing model is not a crash to retry; it is a blocked state. This module
 * is the decision the shim hands the attempt to:
 *
 *   - `run`         — the file is there (or was re-resolved): start normally.
 *   - `blocked`     — a NEW failure: stamp the state file, report ONE line
 *                     naming the model and the fix, and hold the attempt for
 *                     the whole backoff window before exiting nonzero.
 *   - `retry-after` — still inside the previous failure's window: hold only
 *                     the remainder, report nothing.
 *
 * Holding the attempt inside the shim is what makes the backoff real:
 * launchd sees a live job for the whole window instead of respawning every
 * ThrottleInterval, so attempts stay at least {@link MISSING_MODEL_BACKOFF_MS}
 * apart even when the job is kicked out manually. The stamp file is what
 * makes it hold ACROSS restarts — without it a mid-window bootout would print
 * the line and start a fresh window on every respawn.
 *
 * Recovery needs no human step: every attempt stats the model path first, so
 * a blob that is back is simply `run`; and while an attempt holds,
 * {@link waitMissingModelBackoff} polls for the file's return so a model
 * restored mid-window starts the runtime within one poll rather than waiting
 * the window out.
 *
 * {@link decideMissingModel} is the pure decision; {@link checkMissingModel}
 * is the thin file seam (stat + state file + stamp) around it. The shim
 * reaches this through `ashlr local-runtime missing-model-guard`, whose argv
 * the install path freezes into the shim like `resolve-model`'s.
 */

import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { localRuntimeDir } from './llama/paths.js';

/**
 * Minimum time between attempts once the model is known missing: 30 minutes.
 * The guard, not launchd's `ThrottleInterval`, sets the cadence — each blocked
 * or retrying attempt holds inside the shim for this long, so no manual
 * `launchctl kickstart` or respawn can produce two attempts closer together.
 */
export const MISSING_MODEL_BACKOFF_MS = 30 * 60 * 1000;

/** How often a holding attempt re-stats the model path for early recovery. */
export const MISSING_MODEL_POLL_MS = 30 * 1000;

/** What a start attempt should do about a model that may be absent. */
export type MissingModelDecision = 'run' | 'blocked' | 'retry-after';

/** Facts {@link decideMissingModel} needs — nothing it has to read itself. */
export interface MissingModelDecisionInput {
  /** The model file exists at the path the shim will exec. */
  modelExists: boolean;
  /** The file is missing BUT the shim re-resolved a usable replacement. */
  resolvable: boolean;
  /** Last recorded failure, epoch ms — null when absent or unreadable. */
  lastFailedAtMs: number | null;
  nowMs: number;
  backoffMs?: number;
}

/**
 * The pure decision.
 *
 * `run` dominates everything else: a file that exists — or a reference that
 * re-resolved — is never gated by the stamp, which is what makes recovery
 * need no human step. `blocked` and `retry-after` differ only in whether the
 * backoff window since the last recorded failure has elapsed; a stamp in the
 * future (clock skew) still counts as inside the window.
 */
export function decideMissingModel(input: MissingModelDecisionInput): MissingModelDecision {
  if (input.modelExists || input.resolvable) return 'run';
  const backoff = input.backoffMs ?? MISSING_MODEL_BACKOFF_MS;
  if (input.lastFailedAtMs === null || input.nowMs - input.lastFailedAtMs >= backoff) {
    return 'blocked';
  }
  return 'retry-after';
}

// ---------------------------------------------------------------------------
// The state file — one JSON document holding the last failure's epoch ms.
// ---------------------------------------------------------------------------

/** Refuse to parse anything larger; a state file is a few dozen bytes. */
const STATE_FILE_MAX_BYTES = 4 * 1024;

/**
 * `~/.ashlr/local-runtime/missing-model.json` — the guard's own stamp.
 * Re-resolved from `homedir()` at call time, like every path in this family.
 */
export function missingModelStatePath(): string {
  return join(localRuntimeDir(), 'missing-model.json');
}

/**
 * Read the last recorded failure, epoch ms. Null on every failure: absent,
 * corrupt, oversized, or the wrong shape are all "no prior failure" — a state
 * file that cannot be trusted must not be allowed to suppress a real blocked
 * report. Never throws.
 */
export function readMissingModelLastFailedAt(statePath: string): number | null {
  try {
    const stat = statSync(statePath);
    if (!stat.isFile() || stat.size > STATE_FILE_MAX_BYTES) return null;
    const parsed: unknown = JSON.parse(readFileSync(statePath, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const at = (parsed as Record<string, unknown>)['lastFailedAt'];
    return typeof at === 'number' && Number.isFinite(at) && at >= 0 ? at : null;
  } catch {
    return null;
  }
}

/**
 * Stamp a failure time. Best effort: if the write fails the next attempt
 * simply blocks again, which is the same state this call was recording — so
 * the guard never fails louder than the missing model itself did.
 */
export function recordMissingModelFailure(statePath: string, nowMs: number): void {
  try {
    mkdirSync(dirname(statePath), { recursive: true, mode: 0o700 });
    writeFileSync(statePath, `${JSON.stringify({ schemaVersion: 1, lastFailedAt: nowMs })}\n`, {
      mode: 0o600,
    });
  } catch {
    // A failed stamp means the next attempt re-blocks — the intended state anyway.
  }
}

/**
 * The single operator-facing line a blocked attempt leaves. It names the
 * model (the Ollama reference when there is one, else the configured path)
 * and the one command that fixes the state — reinstalling rewrites the plist
 * and shim against the current store.
 */
export function missingModelBlockedLine(modelName: string): string {
  return `[ashlr local-runtime] model ${modelName} is missing and could not be re-resolved — fix: ashlr local-runtime install`;
}

// ---------------------------------------------------------------------------
// checkMissingModel — the thin seam: stat + stamp + decide in one call.
// ---------------------------------------------------------------------------

/** What an attempt should do, derived from the file, the store and the stamp. */
export interface MissingModelCheck {
  decision: MissingModelDecision;
  /**
   * How long this attempt should hold before exiting nonzero — the full
   * window on a fresh `blocked`, only the remainder on `retry-after`, zero
   * when the decision is `run`.
   */
  waitMs: number;
  /** The one line to report — set only on a fresh `blocked`, else null. */
  line: string | null;
}

export interface CheckMissingModelOptions {
  /** The model path the shim is about to exec. */
  modelPath: string;
  /**
   * Whether the shim re-resolved a usable path this attempt. The launchd
   * shim only calls the guard when it could NOT re-resolve, so production
   * always passes false; the input exists because the decision table is
   * defined over it.
   */
  resolvable: boolean;
  /** Name reported in the blocked line; defaults to the path itself. */
  modelName?: string | null;
  statePath?: string;
  nowMs?: number;
  backoffMs?: number;
  /** Injectable for tests; defaults to a real `statSync().isFile()`. */
  fileExists?: (path: string) => boolean;
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The seam {@link decideMissingModel} documents: stat the model, read the
 * stamp, decide — and on a fresh `blocked`, write the stamp BEFORE returning
 * so a crash between the decision and the hold still counts as the recorded
 * attempt it was.
 */
export function checkMissingModel(options: CheckMissingModelOptions): MissingModelCheck {
  const now = options.nowMs ?? Date.now();
  const backoff = options.backoffMs ?? MISSING_MODEL_BACKOFF_MS;
  const statePath = options.statePath ?? missingModelStatePath();
  const fileExists = options.fileExists ?? isFile;
  const lastFailedAtMs = readMissingModelLastFailedAt(statePath);
  const decision = decideMissingModel({
    modelExists: fileExists(options.modelPath),
    resolvable: options.resolvable,
    lastFailedAtMs,
    nowMs: now,
    backoffMs: backoff,
  });
  if (decision === 'run') return { decision, waitMs: 0, line: null };
  if (decision === 'blocked') {
    recordMissingModelFailure(statePath, now);
    return {
      decision,
      waitMs: backoff,
      line: missingModelBlockedLine(options.modelName ?? options.modelPath),
    };
  }
  // `retry-after`: hold only what is left of the window. lastFailedAtMs is
  // non-null here by construction; the clamp also covers a future stamp.
  const elapsed = lastFailedAtMs === null ? backoff : now - lastFailedAtMs;
  return { decision, waitMs: Math.min(backoff, Math.max(0, backoff - elapsed)), line: null };
}

// ---------------------------------------------------------------------------
// waitMissingModelBackoff — hold the window, recover the moment the file is
// back.
// ---------------------------------------------------------------------------

export interface WaitMissingModelBackoffOptions {
  modelPath: string;
  /** Total hold requested by {@link checkMissingModel}, ms. */
  waitMs: number;
  pollMs?: number;
  fileExists?: (path: string) => boolean;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * Hold an attempt for `waitMs`, exiting early with `'run'` if the model file
 * reappears — the operator's `ollama pull` or reinstall must not have to wait
 * out a backoff it already fixed. `'expired'` means the window elapsed with
 * the file still absent; the caller then exits nonzero so launchd's next
 * respawn decides again (into `blocked`, since the window has now elapsed).
 */
export async function waitMissingModelBackoff(
  options: WaitMissingModelBackoffOptions,
): Promise<'run' | 'expired'> {
  const fileExists = options.fileExists ?? isFile;
  const now = options.now ?? (() => Date.now());
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const poll = options.pollMs ?? MISSING_MODEL_POLL_MS;
  const deadline = now() + options.waitMs;
  for (;;) {
    const remaining = deadline - now();
    if (remaining <= 0) return 'expired';
    await sleep(Math.min(poll, remaining));
    if (fileExists(options.modelPath)) return 'run';
  }
}
