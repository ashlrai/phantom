import {
  MAX_BATCH_INPUT_BYTES,
  parseReleaseAdvanceBatchInput,
  runReleaseAdvanceBatch,
  type ReleaseAdvanceBatchReport,
} from '../core/fleet/release-advance-batch.js';
import type { ReleaseAdvanceOnceOptions, ReleaseAdvanceOnceReport } from '../core/fleet/release-advance-once.js';
import type { GitRunner } from '../core/verse/git-ops.js';

const USAGE = 'usage: ashlr fleet release-advance-batch --stdin [--apply] [--json]';
const HELP = `${USAGE}

Submit a bounded list of release candidates through the existing serialized
advance action, in input order, instead of one session per candidate. --stdin
reads one UTF-8 JSON document (max 64 KiB) through EOF:
{"version":1,"candidates":[{"repo":"owner/name","tag":"vX.Y.Z"}]} holding 1..16
distinct candidates; malformed input, unknown fields, duplicates and extra
flags are all rejected before any candidate runs.

Dry run by default: every candidate delegates read-only and nothing is
written. --apply passes each candidate through the same local per-repo/tag
lock and receipt as release-advance-once — same-host coordination only,
never a global exactly-once. At most one evidence or dispatch call is in
flight; a blocked, refused, unavailable or busy entry does not stop the
batch, so an unrelated repo can still advance. An accepted dispatch is a
submission only: no release is published, installed or notified.

When the batch is running, SIGINT or SIGTERM abort it without interrupting
an in-flight dispatch: the command awaits its result, emits a partial JSON
report with cancelled:true and remaining identities, and exits 1.  A
cancelled batch still preserves accepted dispatches — nothing is rolled
back.  Listeners are per-invocation and cleaned up in finally.

exit: 0 every candidate planned|submitted|no-op|already-submitted,
      1 any candidate blocked|refused|unavailable|busy OR cancelled,
      2 invalid arguments or input`;

interface BatchDeps {
  input?: AsyncIterable<string | Uint8Array>;
  gh?: GitRunner;
  stateDir?: string;
  advance?: ReleaseAdvanceOnceOptions['advance'];
  once?: (repo: string, tag: string, opts: ReleaseAdvanceOnceOptions) => Promise<ReleaseAdvanceOnceReport>;
  now?: () => number;
  /** Test seam: when provided, used instead of a process-created AbortController. */
  signal?: AbortSignal;
}

async function readStdin(input: AsyncIterable<string | Uint8Array>): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BATCH_INPUT_BYTES) throw new Error('input too large');
    chunks.push(buffer);
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}

const human = (report: ReleaseAdvanceBatchReport): string => {
  const lines = [
    `Release advance batch${report.apply ? ' --apply' : ' (dry run)'}: ${report.total} candidate(s), `
    + `${report.succeeded} successful, ${report.unsuccessful} unsuccessful`,
  ];
  if (report.cancelled) {
    lines.push('  CANCELLED: batch was interrupted before all candidates ran.');
  }
  lines.push(
    ...report.entries.map(entry => `  ${entry.repo}@${entry.tag}: ${entry.outcome} (${entry.reason})`),
  );
  if (report.remaining.length) lines.push(`  Not reached: ${report.remaining.join(', ')}`);
  if (report.entries.some(entry => entry.outcome === 'submitted')) {
    lines.push('  Accepted dispatches are submissions only; nothing is published, installed or notified.');
  }
  if (!report.apply && report.entries.some(entry => entry.outcome === 'planned')) {
    lines.push('  Dry run; pass --apply to submit the proposed dispatches.');
  }
  return lines.join('\n');
};

// Per-invocation signal handling.  Returns AbortController and cleanup
// function so the caller can remove listeners in finally, avoiding global
// listener leaks.  The optional `signal` parameter lets tests inject a
// pre-created AbortController whose abort signal is used instead of
// OS signals.
const setupSignalHandling = (
  testSignal?: AbortSignal,
): { ac: AbortController; cleanup: () => void } => {
  if (testSignal) {
    // Test seam: use the injected signal directly, no process.on needed.
    return {
      ac: { signal: testSignal } as AbortController,
      cleanup: () => {},
    };
  }
  const ac = new AbortController();
  let handled = false;
  const handler = (): void => {
    if (!handled) {
      handled = true;
      ac.abort();
    }
  };
  process.on('SIGINT', handler);
  process.on('SIGTERM', handler);
  return {
    ac,
    cleanup: () => {
      process.off('SIGINT', handler);
      process.off('SIGTERM', handler);
    },
  };
};

/**
 * Bounded batch driver over the serialized release advance. One JSON
 * document on stdin nominates 1..16 candidates; every rejection happens
 * before the first evidence call, and the aggregated report keeps each
 * candidate's own outcome and reason.
 *
 * Handles SIGINT/SIGTERM per-invocation via AbortController so a supervisor
 * can cancel the batch mid-flight.  Listeners are scoped to this command
 * invocation and cleaned up in finally, avoiding global listener leaks.
 * A cancelled batch writes a partial JSON report (cancelled:true) and exits 1.
 */
export async function cmdFleetReleaseAdvanceBatch(args: string[], deps: BatchDeps = {}): Promise<number> {
  if (args.includes('--help') || args.includes('-h')) { console.log(HELP); return 0; }
  const wantsJson = args.includes('--json');
  const invalid = (detail: string): number => {
    if (wantsJson) console.log(JSON.stringify({ version: 1, outcome: 'invalid', reason: detail }));
    else process.stderr.write(`Invalid input: ${detail}. ${USAGE}\n`);
    return 2;
  };
  let stdin = false;
  let apply = false;
  let json = false;
  for (const arg of args) {
    if (arg === '--stdin' && !stdin) { stdin = true; continue; }
    if (arg === '--apply' && !apply) { apply = true; continue; }
    if (arg === '--json' && !json) { json = true; continue; }
    return invalid('unexpected_argument');
  }
  if (!stdin) return invalid('missing_stdin_flag');
  const input = deps.input ?? process.stdin;
  if (deps.input === undefined && (input as { isTTY?: boolean }).isTTY === true) return invalid('stdin_must_be_a_pipe');
  const { ac, cleanup } = setupSignalHandling(deps.signal);
  try {
    let text: string;
    try { text = await readStdin(input); }
    catch (error) { return invalid(error instanceof Error && error.message === 'input too large' ? 'input_too_large' : 'input_unreadable'); }
    const parsed = parseReleaseAdvanceBatchInput(text);
    if (!parsed.ok) return invalid(parsed.reason);
    let report: ReleaseAdvanceBatchReport;
    try {
      report = await runReleaseAdvanceBatch(parsed.candidates, {
        apply, runner: deps.gh, stateDir: deps.stateDir, advance: deps.advance,
        once: deps.once, now: deps.now, signal: ac.signal,
      });
    } catch {
      return invalid('candidate_list');
    }
    console.log(json ? JSON.stringify(report) : human(report));
    return report.unsuccessful === 0 && !report.cancelled ? 0 : 1;
  } finally {
    cleanup();
  }
}
