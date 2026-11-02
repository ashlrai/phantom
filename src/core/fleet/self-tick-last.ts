/**
 * self-tick-last.ts — persistence for the last self-tick report. A host
 * timer's `ashlr fleet self-tick` otherwise leaves no trace: nothing could
 * say whether it ran, when, or which step failed. The run writes
 * queue/self-tick-last.json while its lock is still held; `--last` reads it
 * back without running a step or touching the lock.
 *
 * Step reports pass through sanitizePublicJson before landing on disk — a
 * verb's --json output can carry this user's home path, and the file is a
 * shared read surface. Each step's stored report is capped at 16 KB of JSON;
 * larger ones degrade to { truncated: true } rather than pinning a verb's
 * whole payload in the queue.
 */
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { sanitizePublicJson } from '../util/public-json.js';
import { SELF_TICK_STEP_ORDER, type SelfTickReport, type SelfTickStepName } from './self-tick.js';

/** Last-report path relative to the runs dir, under the queue/ directory. */
export const SELF_TICK_LAST = 'queue/self-tick-last.json';

/** A step report whose JSON exceeds this is stored as { truncated: true }. */
const STEP_REPORT_MAX_BYTES = 16 * 1024;

/** The record's format version; the writer always stores 1. */
const SELF_TICK_LAST_VERSION = 1;

/** Largest exit status a POSIX process can report. */
const EXIT_CODE_MAX = 255;

/** One persisted step's verdict-relevant fields, after validation. */
interface StepEvidence {
  step: SelfTickStepName;
  state: 'ok' | 'failed';
}

export type SelfTickLastView =
  | {
      state: 'ok';
      /** ISO timestamp the run started (the report's `at`). */
      at: string;
      mode: 'apply' | 'dry-run';
      /** The recorded run's own state — 'ran' or 'busy'. */
      ranState: 'ran' | 'busy';
      /** Whole seconds between the recorded `at` and the injected `now`. */
      ageSeconds: number;
      /** Names of the steps the recorded run marked failed. */
      failedSteps: string[];
    }
  | { state: 'unreadable' };

/** Sanitize one step report, then store it only when it fits the cap. */
const storedReport = (report: unknown): unknown => {
  const sanitized = sanitizePublicJson(report);
  const serialized = JSON.stringify(sanitized);
  if (serialized === undefined) return null;
  return Buffer.byteLength(serialized, 'utf8') <= STEP_REPORT_MAX_BYTES
    ? sanitized
    : { truncated: true };
};

/**
 * Persist the last self-tick report atomically: a fresh tmp file in the same
 * directory renamed over the target, mode 0o600, with the queue dir made
 * first. Callers run this inside the self-tick lock, so plain rename (not
 * O_EXCL at the target) is the right commit.
 */
export function writeSelfTickLast(runsDir: string, report: SelfTickReport): void {
  const path = join(runsDir, SELF_TICK_LAST);
  mkdirSync(dirname(path), { recursive: true });
  const persisted = {
    v: SELF_TICK_LAST_VERSION,
    at: report.at,
    mode: report.mode,
    state: report.state,
    steps: report.steps.map((step) => ({
      step: step.step,
      state: step.state,
      exitCode: step.exitCode,
      report: storedReport(step.report),
    })),
  };
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(persisted), { mode: 0o600, flag: 'wx' });
    renameSync(tmp, path);
    // rename keeps the tmp's mode; chmod anyway so a permissive umask edge
    // can never leave the record group/world-readable.
    chmodSync(path, 0o600);
  } finally {
    try { unlinkSync(tmp); } catch { /* renamed already, or never created */ }
  }
}

/**
 * Read the last self-tick report back into a view. null means no recorded
 * run; 'unreadable' covers a present file that will not parse or fails
 * field-by-field validation — the file's shape is never trusted.
 */
export function readSelfTickLast(runsDir: string, now: number): SelfTickLastView | null {
  let raw: string;
  try {
    raw = readFileSync(join(runsDir, SELF_TICK_LAST), 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : { state: 'unreadable' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { state: 'unreadable' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { state: 'unreadable' };
  }
  const row = parsed as Record<string, unknown>;
  const at = row['at'];
  const atMs = typeof at === 'string' ? Date.parse(at) : Number.NaN;
  const mode = row['mode'];
  const ranState = row['state'];
  if (row['v'] !== SELF_TICK_LAST_VERSION ||
    !Number.isFinite(atMs) ||
    (mode !== 'apply' && mode !== 'dry-run') ||
    (ranState !== 'ran' && ranState !== 'busy')) {
    return { state: 'unreadable' };
  }
  // The whole steps array is validated before any of it feeds the verdict:
  // one malformed entry makes the record unreadable, never a partial ok.
  const steps = readSteps(ranState, row['steps']);
  if (steps === null) return { state: 'unreadable' };
  return {
    state: 'ok',
    at: at as string,
    mode,
    ranState,
    ageSeconds: Math.max(0, Math.floor((now - atMs) / 1_000)),
    failedSteps: steps.filter((step) => step.state === 'failed').map((step) => step.step),
  };
}

const isStepName = (value: unknown): value is SelfTickStepName =>
  SELF_TICK_STEP_ORDER.includes(value as SelfTickStepName);

/**
 * Validate one persisted step against the writer's shape: a known name,
 * state 'ok' or 'failed' where ok means exit 0 and failed means a nonzero
 * exit (the writer derives state from the exit code, so they must agree),
 * and a `report` key whose value may be any JSON, null included.
 */
const readStep = (raw: unknown): StepEvidence | null => {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const row = raw as Record<string, unknown>;
  const { step, state, exitCode } = row;
  if (!isStepName(step)) return null;
  if (state !== 'ok' && state !== 'failed') return null;
  if (typeof exitCode !== 'number' || !Number.isInteger(exitCode) ||
    exitCode < 0 || exitCode > EXIT_CODE_MAX) {
    return null;
  }
  if ((state === 'ok') !== (exitCode === 0)) return null;
  if (!('report' in row)) return null;
  return { step, state };
};

/**
 * Validate the steps array as the writer produces it. A busy run never
 * steps, so it records none; a ran pass records at least one, in the fixed
 * SELF_TICK_STEP_ORDER with no name twice. Returns null for any violation.
 */
const readSteps = (ranState: 'ran' | 'busy', raw: unknown): StepEvidence[] | null => {
  if (!Array.isArray(raw)) return null;
  if (ranState === 'busy' ? raw.length !== 0 : raw.length === 0) return null;
  const evidence: StepEvidence[] = [];
  let lastIndex = -1;
  for (const entry of raw) {
    const step = readStep(entry);
    if (step === null) return null;
    const index = SELF_TICK_STEP_ORDER.indexOf(step.step);
    if (index <= lastIndex) return null;
    lastIndex = index;
    evidence.push(step);
  }
  return evidence;
};
