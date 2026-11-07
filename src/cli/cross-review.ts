/**
 * `phm fleet xreview run|decide`: the bridge's entry to cross-model review
 * (src/core/fleet/cross-review*.ts; docs/CROSS-REVIEW.md). Thin: parse argv,
 * read the request file, delegate. Job text arrives only inside the request
 * FILE and goes only into the reviewer's prompt; this command never runs gh,
 * never merges, and prints structured fields only.
 */
import { rejectUnknownOptions } from './args.js';
import { isCommitSha, parseCrossReviewRequest, type CrossReviewDecision, type CrossReviewRecord } from '../core/fleet/cross-review.js';
import { decideCrossReviewAtHead, loadCrossReviewPolicy, readBoundedFile, runCrossReview } from '../core/fleet/cross-review-run.js';

const USAGE = [
  'usage: phm fleet xreview run --request <file> [--json]',
  '       phm fleet xreview decide --request <file> --head <sha> [--pause-file <path>] [--json]',
].join('\n');

function valueOf(args: readonly string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function fail(message: string): number {
  process.stderr.write(`error: fleet xreview: ${message}\n${USAGE}\n`);
  return 2;
}

function printDecision(decision: CrossReviewDecision, review: CrossReviewRecord | null, json: boolean): void {
  if (json) {
    process.stdout.write(JSON.stringify(review ? { review, decision } : { decision }, null, 2) + '\n');
    return;
  }
  if (review) {
    const who = review.reviewerPool ? ` by ${review.reviewerFamily}@${review.reviewerPool}` : '';
    process.stdout.write(`review: ${review.outcome}${who}${review.reasons.length ? ` (${review.reasons.join(', ')})` : ''}\n`);
  }
  process.stdout.write(`decision: ${decision.action} [${decision.codes.join(', ')}] ${decision.prUrl}\n`);
  if (decision.matchHeadCommit) process.stdout.write(`match-head-commit: ${decision.matchHeadCommit}\n`);
}

export async function cmdFleetCrossReview(args: string[]): Promise<number> {
  const [verb, ...rest] = args;
  if (verb === undefined || verb === '--help' || verb === '-h' || rest.includes('--help') || rest.includes('-h')) {
    process.stdout.write(`${USAGE}\n\nrun     take one cross-model review on another pool and decide at the request's head\ndecide  decide at the head observed now against the newest recorded review\n`);
    return 0;
  }
  if (verb !== 'run' && verb !== 'decide') return fail(`unknown verb: ${verb}`);
  const bad = rejectUnknownOptions(rest, verb === 'run'
    ? { flags: ['--json'], values: ['--request'] }
    : { flags: ['--json'], values: ['--request', '--head', '--pause-file'] });
  if (bad) return fail(bad.message);
  const json = rest.includes('--json');

  const requestPath = valueOf(rest, '--request');
  if (!requestPath) return fail('--request <file> is required');
  const requestText = readBoundedFile(requestPath);
  if (requestText === null) return fail('the request file is missing or unreadable');
  let raw: unknown;
  try { raw = JSON.parse(requestText); } catch { return fail('the request file is not valid JSON'); }
  const parsed = parseCrossReviewRequest(raw);
  if (!parsed.ok) return fail(`invalid request: ${parsed.errors.join('; ')}`);
  const policy = loadCrossReviewPolicy();
  if (!policy.ok) return fail(`invalid policy: ${policy.errors.join('; ')}`);

  if (verb === 'run') {
    const { review, decision } = await runCrossReview(parsed.request, policy.policy);
    printDecision(decision, review, json);
    return 0;
  }
  const head = valueOf(rest, '--head');
  if (!isCommitSha(head)) return fail('--head must be the full lowercase head SHA observed now');
  const pauseFile = valueOf(rest, '--pause-file');
  if (pauseFile !== undefined && !pauseFile.startsWith('/')) return fail('--pause-file must be an absolute path');
  printDecision(await decideCrossReviewAtHead(parsed.request, policy.policy, head, pauseFile ? { pauseFile } : {}), null, json);
  return 0;
}
