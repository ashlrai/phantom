import { lstat } from 'node:fs/promises';
import { readGuardianDrainCheckpoint } from './guardian-drain-checkpoint.js';
import { createGuardianDrainSession, guardianDrainStopStatus } from './guardian-drain-session.js';
import { drainGuardianInfraRetries, type GuardianDrainDeps, type GuardianDrainSummary, type GuardianDrainTermination } from './guardian-retry-drain.js';

// Supervised repetition of `guardian-drain`: one awaited drain at a time,
// first immediately, later after an interruptible interval, all inside one
// total duration. Each applied pass gets a fresh private session directory and
// receives the previous pass's latest verified state as its source; the
// original source file is never written. Verification, eligibility, holds,
// exclusion and exclusive-lock policy stay in the drain it delegates to. Only
// bounded counters and the latest verified path/session are retained.
export type GuardianRepeatTermination = GuardianDrainTermination | 'duration';

export interface GuardianRepeatOptions {
  manifest: string; sourceState: string; outputDir: string;
  durationMs: number; intervalMs: number; maxRetries: number; timeoutMs: number;
  idleBackoffMaxMs?: number;
  apply: boolean; stopFile?: string; signal?: AbortSignal;
}

export interface GuardianRepeatDrainRequest {
  manifest: string; sourceState: string; outputDir: string;
  maxRetries: number; timeoutMs: number; apply: boolean; stopFile?: string; signal?: AbortSignal;
}
export interface GuardianRepeatDrainResult { summary: GuardianDrainSummary; session: string | null; checkpoint?: string | null }
export type GuardianRepeatDrain = (request: GuardianRepeatDrainRequest) => Promise<GuardianRepeatDrainResult>;

export interface GuardianRepeatDeps {
  drain?: GuardianRepeatDrain;
  now?: () => number;
  /** Resolves early (never rejects) when the signal aborts. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  onPass?: (record: GuardianRepeatPass) => void | Promise<void>;
}

export interface GuardianRepeatPass {
  pass: number; termination: string; attempts: number; verified: number; refused: number;
  latestOutput: string | null; session: string | null;
  consecutiveIdle?: number; nextDelayMs?: number;
}

export interface GuardianRepeatSummary {
  mode: 'preview' | 'apply'; termination: GuardianRepeatTermination;
  passes: number; attempts: number; verified: number; refused: number;
  latestOutput: string | null; session: string | null;
}

// Outcomes after which another drain is meaningful.
const REPEATABLE = new Set(['no-work', 'exhausted', 'drained', 'max-retries']);
const STOP_POLL_MS = 1000;

/** Production adapter: the real core drain over a fresh private session. */
export const drainWithFreshSession = (deps: GuardianDrainDeps = {}, now?: () => number): GuardianRepeatDrain =>
  async request => {
    const { apply, outputDir } = request;
    if (!apply) {
      return { summary: await drainGuardianInfraRetries({ ...request, now }, deps), session: null };
    }
    let preflight = await guardianDrainStopStatus(request.stopFile);
    let session: string | null = null;
    if (!preflight) {
      try { session = await createGuardianDrainSession(outputDir); } catch { preflight = 'unsafe'; }
    }
    if (preflight || session === null) {
      return { summary: { mode: 'apply', termination: preflight ?? 'unsafe', attempts: 0, verified: 0, refused: 0, attempted: [], planned: [], latestOutput: null }, session: null };
    }
    const summary = await drainGuardianInfraRetries({ ...request, outputDir: session, now }, deps);
    let checkpoint: string | null = null;
    try { checkpoint = readGuardianDrainCheckpoint(session)?.latestOutput ?? null; } catch { /* no safe resumable checkpoint */ }
    return { summary, session, checkpoint };
  };

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise<void>(resolve => {
  if (signal?.aborted) { resolve(); return; }
  const done = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
  const timer = setTimeout(done, ms);
  signal?.addEventListener('abort', done, { once: true });
});

async function stopFileExists(path?: string): Promise<'stopped' | 'unsafe' | null> {
  if (path === undefined) return null;
  try { await lstat(path); return 'stopped'; }
  catch (error) { return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'unsafe'; }
}

export async function repeatGuardianDrains(
  options: GuardianRepeatOptions,
  deps: GuardianRepeatDeps = {},
): Promise<GuardianRepeatSummary> {
  if (options.idleBackoffMaxMs !== undefined && (!Number.isSafeInteger(options.idleBackoffMaxMs)
    || options.idleBackoffMaxMs < options.intervalMs || options.idleBackoffMaxMs > 86_400_000)) {
    throw new RangeError('idleBackoffMaxMs must be a safe integer between intervalMs and 86400000');
  }
  const now = deps.now ?? Date.now;
  const drain = deps.drain ?? drainWithFreshSession({}, deps.now);
  const sleep = deps.sleep ?? defaultSleep;
  const summary: GuardianRepeatSummary = {
    mode: options.apply ? 'apply' : 'preview', termination: 'duration',
    passes: 0, attempts: 0, verified: 0, refused: 0, latestOutput: null, session: null,
  };
  const startedAt = now();
  let source = options.sourceState;
  let consecutiveIdle = 0, nextDelayMs = options.intervalMs;
  for (;;) {
    const halted = options.signal?.aborted ? 'cancelled' as const : await stopFileExists(options.stopFile);
    if (halted) { summary.termination = halted; return summary; }
    const remaining = Math.floor(options.durationMs - (now() - startedAt));
    if (remaining < 1) { summary.termination = 'duration'; return summary; }
    const timeoutMs = Math.min(options.timeoutMs, remaining);
    let result: GuardianRepeatDrainResult;
    try {
      result = await drain({
        manifest: options.manifest, sourceState: source, outputDir: options.outputDir,
        maxRetries: options.maxRetries, timeoutMs, apply: options.apply,
        stopFile: options.stopFile, signal: options.signal,
      });
    } catch { summary.termination = 'unsafe'; return summary; }
    const drained = result.summary;
    summary.passes++; summary.attempts += drained.attempts;
    summary.verified += drained.verified; summary.refused += drained.refused;
    const ok = REPEATABLE.has(drained.termination);
    if (options.idleBackoffMaxMs !== undefined) {
      if (drained.termination === 'no-work' && drained.refused === 0) {
        consecutiveIdle++;
        nextDelayMs = Math.min(options.idleBackoffMaxMs, nextDelayMs * 2);
      } else { consecutiveIdle = 0; nextDelayMs = options.intervalMs; }
    }
    // Only a completed successful drain's verified state becomes the next source.
    if (ok && drained.latestOutput) source = drained.latestOutput;
    const checkpoint = result.checkpoint === undefined ? drained.latestOutput : result.checkpoint;
    if (options.apply && checkpoint && result.session) {
      summary.latestOutput = checkpoint; summary.session = result.session;
    }
    try {
      await deps.onPass?.({ pass: summary.passes, termination: drained.termination, attempts: drained.attempts,
        verified: drained.verified, refused: drained.refused, latestOutput: drained.latestOutput, session: result.session,
        ...(options.idleBackoffMaxMs !== undefined ? { consecutiveIdle, nextDelayMs } : {}) });
    } catch { summary.termination = 'observer-error'; return summary; }
    if (!options.apply) { summary.termination = drained.termination; return summary; }
    if (!ok) {
      // A deadline caused only by the shrunken total budget is the duration ending.
      summary.termination = drained.termination === 'deadline' && timeoutMs < options.timeoutMs ? 'duration'
        : drained.termination;
      return summary;
    }
    const left = Math.floor(options.durationMs - (now() - startedAt));
    if (left <= nextDelayMs) { summary.termination = 'duration'; return summary; }
    // Wait in short slices so a stop file also interrupts the interval.
    for (let waited = 0; waited < nextDelayMs && !options.signal?.aborted;) {
      const budget = Math.floor(options.durationMs - (now() - startedAt));
      if (budget < 1) { summary.termination = 'duration'; return summary; }
      const slice = Math.min(STOP_POLL_MS, nextDelayMs - waited, budget);
      await sleep(slice, options.signal);
      waited += slice;
      if (options.signal?.aborted) { summary.termination = 'cancelled'; return summary; }
      const stopped = await stopFileExists(options.stopFile);
      if (stopped) { summary.termination = stopped; return summary; }
      if (Math.floor(options.durationMs - (now() - startedAt)) < 1) { summary.termination = 'duration'; return summary; }
    }
  }
}
