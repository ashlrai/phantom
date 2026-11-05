import {
  MAX_RETRY_INPUT_BYTES,
  parseReleaseRetryBatchInput,
  runReleaseRetryBatch,
  type ReleaseRetryBatchReport,
} from '../core/fleet/release-retry-batch.js';
import type { ReleaseAdvanceOnceOptions, ReleaseAdvanceOnceReport } from '../core/fleet/release-advance-once.js';
import type { GitRunner } from '../core/verse/git-ops.js';

const USAGE = 'usage: ashlr fleet release-retry-batch --stdin [--apply] [--json]';
const HELP = `${USAGE}

Feed a previous release-advance-batch report back through the serialized
advance, retrying only its unsuccessful entries. --stdin reads one UTF-8
JSON document (max 1 MiB) through EOF: the version-1 report's busy,
blocked, refused and unavailable entries become the retry batch in their
original order while planned, submitted, no-op and already-submitted
entries stay out. Malformed documents, unknown fields or outcomes,
tally/completed mismatches, invalid or duplicate repo/tag identities and
extra flags are all rejected before any candidate runs.

The supplied report only selects; it never proves current eligibility.
Every retried identity re-plans against fresh evidence, so an old blocked
entry can now dispatch and a candidate submitted elsewhere is still
deduped by the existing per-repo/tag receipt — this command stores no
receipt of its own.

Dry run by default: nothing is written and the report's own apply flag is
never inherited. --apply passes each retried candidate through the same
local per-repo/tag lock and receipt as release-advance-once — same-host
coordination only, never a global exactly-once. At most one evidence or
dispatch call is in flight. An accepted dispatch is a submission only: no
release is published, installed or notified.

exit: 0 every retried candidate planned|submitted|no-op|already-submitted,
      or nothing needed a retry,
      1 any retried candidate blocked|refused|unavailable|busy,
      2 invalid arguments or input`;

interface RetryDeps {
  input?: AsyncIterable<string | Uint8Array>;
  gh?: GitRunner;
  stateDir?: string;
  advance?: ReleaseAdvanceOnceOptions['advance'];
  once?: (repo: string, tag: string, opts: ReleaseAdvanceOnceOptions) => Promise<ReleaseAdvanceOnceReport>;
  now?: () => number;
}

async function readStdin(input: AsyncIterable<string | Uint8Array>): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of input) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_RETRY_INPUT_BYTES) throw new Error('input too large');
    chunks.push(buffer);
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}

const human = (report: ReleaseRetryBatchReport): string => {
  const lines = [
    `Release retry batch${report.apply ? ' --apply' : ' (dry run)'}: ${report.input} entries read, `
    + `${report.retried.length} retried, ${report.skipped.length} skipped`,
    ...report.retried.map(entry => `  retry ${entry.repo}@${entry.tag} (was ${entry.previousOutcome})`),
    ...report.skipped.map(entry => `  skip  ${entry.repo}@${entry.tag} (was ${entry.previousOutcome})`),
  ];
  if (report.batch === null) {
    lines.push('  Nothing needed a retry; no candidate was run.');
    return lines.join('\n');
  }
  lines.push(`  Fresh evidence: ${report.batch.succeeded} successful, ${report.batch.unsuccessful} unsuccessful`);
  lines.push(...report.batch.entries.map(entry => `    ${entry.repo}@${entry.tag}: ${entry.outcome} (${entry.reason})`));
  if (report.batch.entries.some(entry => entry.outcome === 'submitted')) {
    lines.push('  Accepted dispatches are submissions only; nothing is published, installed or notified.');
  }
  if (!report.apply && report.batch.entries.some(entry => entry.outcome === 'planned')) {
    lines.push('  Dry run; pass --apply to submit the proposed dispatches.');
  }
  return lines.join('\n');
};

/**
 * Retry driver over the serialized release batch. One supplied report on
 * stdin nominates which identities run again; every rejection happens
 * before the first evidence call, and the report carries the old outcome
 * beside the fresh batch result so the two are never confused.
 */
export async function cmdFleetReleaseRetryBatch(args: string[], deps: RetryDeps = {}): Promise<number> {
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
  let text: string;
  try { text = await readStdin(input); }
  catch (error) { return invalid(error instanceof Error && error.message === 'input too large' ? 'input_too_large' : 'input_unreadable'); }
  const parsed = parseReleaseRetryBatchInput(text);
  if (!parsed.ok) return invalid(parsed.reason);
  let report: ReleaseRetryBatchReport;
  try {
    report = await runReleaseRetryBatch(parsed.selection, {
      apply, runner: deps.gh, stateDir: deps.stateDir, advance: deps.advance, once: deps.once, now: deps.now,
    });
  } catch {
    return invalid('retry_list');
  }
  console.log(json ? JSON.stringify(report) : human(report));
  return report.batch === null || report.batch.unsuccessful === 0 ? 0 : 1;
}
