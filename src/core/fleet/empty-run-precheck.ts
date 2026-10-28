/**
 * Empty-run precheck — a deterministic preflight for dispatch routing.
 *
 * A job whose declared acceptance command ALREADY passes on the repo's
 * default branch has no work left to do: dispatching it spends a lane slot
 * on a run that can only come back empty (worked-ledger 'empty'). The
 * precheck turns that waste into a close. The job names its proof-of-need
 * with an `acceptance:` tag, a caller-supplied runner executes the command
 * once per tick in a clean checkout of the default branch, and this module
 * renders the verdict the router acts on.
 *
 * PURE, like the dispatch router it feeds: no clock reads, no I/O, no
 * process launches. The run itself belongs to the caller and arrives as
 * data (`AcceptanceRunResult`), the same way the router's capacity
 * snapshot and presence do. The runner also owns the command's
 * confinement — it executes job-declared text, so it belongs in a
 * bounded, disposable checkout; this module only decides what the
 * answer means.
 *
 * Evidence honesty: `close-noop` requires a POSITIVE pass — exit 0 from a
 * run bound to the default branch. A job with no `acceptance:` command, a
 * run that never happened, and a run with no exit verdict all launch the
 * job instead: a check that cannot prove the work is done never closes it.
 */
import type { WorkItem } from '../types.js';

/** The tag prefix that declares a job's proof-of-need, e.g. `acceptance:npm run typecheck`. */
export const ACCEPTANCE_TAG_PREFIX = 'acceptance:';

/** Bound on a declared acceptance command; a longer tag is ignored, like a missing one. */
export const ACCEPTANCE_COMMAND_MAX_CHARS = 500;

const TAG_ACCEPTANCE = /^acceptance:([\s\S]*)$/;

/** A command line is printable text only — no C0/C1 control characters or DEL. */
function hasControlChars(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/**
 * The job's declared acceptance command — the first `acceptance:` tag that
 * yields a usable command, else null. "Usable" means non-empty after the
 * prefix, bounded, and free of control characters; a malformed tag is
 * skipped like a missing one — it can never close the job.
 */
export function acceptanceCommandOf(item: Pick<WorkItem, 'tags'>): string | null {
  for (const tag of item.tags ?? []) {
    const match = TAG_ACCEPTANCE.exec(tag);
    if (!match || hasControlChars(tag)) continue;
    const command = match[1]!.trim();
    if (command.length === 0 || command.length > ACCEPTANCE_COMMAND_MAX_CHARS) continue;
    return command;
  }
  return null;
}

/**
 * What the caller observed running the job's acceptance command in a clean
 * checkout of the repo's default branch.
 */
export interface AcceptanceRunResult {
  /**
   * The command's exit code — 0 means the job's acceptance already holds
   * on the default branch. `null` = the run produced no verdict (spawn
   * failure, timeout, killed, a missing checkout) — never proof the work
   * is done.
   */
  exitCode: number | null;
  /** The default-branch revision the run was bound to; null = unknown. */
  revision?: string | null;
  /**
   * One sentence about the run for audit (e.g. "timed out"), never the
   * command's output — task text is untrusted and output may carry
   * secrets or prompt injection.
   */
  detail?: string;
}

/** The job is closed without a dispatch: its acceptance already holds. */
export interface NoopClose {
  kind: 'close-noop';
  /** The declared acceptance command as run. */
  command: string;
  /** Why no lane has work to do — the sentence the journal and CLI print. */
  reason: string;
}

/** The job launches normally — the precheck proved nothing done. */
export interface LaunchVerdict {
  kind: 'launch';
  reason: string;
}

export type EmptyRunVerdict = NoopClose | LaunchVerdict;

/**
 * The deterministic verdict for one job. Only an observed exit-0 run on
 * the default branch closes the job as a no-op; every other answer —
 * failure, no verdict, no run, no command — launches it, because a
 * precheck that cannot prove the work is done must never suppress it.
 */
export function emptyRunPrecheck(
  command: string | null,
  run: AcceptanceRunResult | null | undefined,
): EmptyRunVerdict {
  if (command === null) {
    return { kind: 'launch', reason: 'The job declares no acceptance command to precheck.' };
  }
  if (run === null || run === undefined) {
    return { kind: 'launch', reason: 'Its acceptance command was not run on the default branch this tick.' };
  }
  if (run.exitCode === 0) {
    return {
      kind: 'close-noop',
      command,
      reason: `Its acceptance command already passes on the default branch (${command}); the job is closed as a no-op.`,
    };
  }
  if (run.exitCode === null) {
    return {
      kind: 'launch',
      reason: `The default-branch acceptance run gave no verdict${run.detail ? ` (${run.detail})` : ''} — a check that cannot prove the work is done never closes it.`,
    };
  }
  return {
    kind: 'launch',
    reason: `Its acceptance command still fails on the default branch (exit ${run.exitCode}).`,
  };
}

/**
 * The per-item prechecker a `DispatchRouterContext` takes: tag extraction
 * and the verdict, composed once. `runOf` is the caller's gathered answer
 * — the only I/O-shaped input — and it is asked only about items that
 * declare a command, so a job with no `acceptance:` tag never spends a
 * default-branch run.
 */
export function emptyRunPrechecker(
  runOf: (item: WorkItem) => AcceptanceRunResult | null,
): (item: WorkItem) => EmptyRunVerdict {
  return (item) => {
    const command = acceptanceCommandOf(item);
    return emptyRunPrecheck(command, command === null ? null : runOf(item));
  };
}
