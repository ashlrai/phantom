/**
 * `phm fleet xreview run|decide`: the bridge's entry to cross-model review
 * (src/core/fleet/cross-review*.ts; docs/CROSS-REVIEW.md). Thin: parse argv,
 * read the request file, delegate. Job text arrives only inside the request
 * FILE and goes only into the reviewer's prompt; this command never runs gh,
 * never merges, and prints structured fields only.
 */
import { rejectUnknownOptions } from './args.js';
import { isCommitSha, parseCrossReviewRequest, type CrossReviewDecision, type CrossReviewRecord } from '../core/fleet/cross-review.js';
import { decideCrossReviewAtHead, enqueueTier1FixJob, loadCrossReviewPolicy, readBoundedFile, runCrossReview } from '../core/fleet/cross-review-run.js';

const USAGE = [
  'usage: phm fleet xreview run --request <file> [--queue <router-queue.md>] [--json]',
  '       phm fleet xreview decide --request <file> --head <sha> [--pause-file <path>] [--queue <router-queue.md>] [--json]',
].join('\n');

function valueOf(args: readonly string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function fail(message: string): number {
  process.stderr.write(`error: fleet xreview: ${message}\n${USAGE}\n`);
  return 2;
}

function printDecision(decision: CrossReviewDecision, review: CrossReviewRecord | null, json: boolean, queuePath?: string): void {
  // tier1-verify: a rejected Tier-1 PR becomes a queued fix job, never a PR parked for a human.
  const queued = decision.fixJob && queuePath ? enqueueTier1FixJob(queuePath, decision.fixJob) : null;
  if (json) {
    process.stdout.write(JSON.stringify({ ...(review ? { review } : {}), decision, ...(queued ? { fixJobQueued: queued } : {}) }, null, 2) + '\n');
    return;
  }
  if (review) {
    const who = review.reviewerPool ? ` by ${review.reviewerFamily}@${review.reviewerPool}` : '';
    process.stdout.write(`review: ${review.outcome}${who}${review.reasons.length ? ` (${review.reasons.join(', ')})` : ''}\n`);
  }
  process.stdout.write(`decision: ${decision.action} [${decision.codes.join(', ')}] ${decision.prUrl}\n`);
  if (decision.checkStatus) process.stdout.write(`checks: ${decision.checkStatus}${decision.checkDetail ? ` — ${decision.checkDetail}` : ''}\n`);
  if (decision.matchHeadCommit) process.stdout.write(`match-head-commit: ${decision.matchHeadCommit}\n`);
  if (decision.tier1) {
    const t = decision.tier1;
    process.stdout.write(`tier1-verify: floor [${t.floor.join(', ')}] failures [${t.failures.join(', ')}] rules [${t.authority.rules.join(', ')}] regression ${t.regression.risk}/${t.regression.score} secret-shapes ${t.secretShapeHits}\n`);
  }
  if (review?.semantic) process.stdout.write(`semantic: ${review.semantic.outcome}${review.semantic.reviewerPool ? ` by ${review.semantic.reviewerFamily}@${review.semantic.reviewerPool}` : ''}${review.semantic.reasons.length ? ` (${review.semantic.reasons.join(', ')})` : ''}\n`);
  if (decision.fixJob) process.stdout.write(queued ? `fix-job: ${queued.queued ? 'queued' : 'already queued'} ${queued.id}\n` : `fix-job: ${decision.fixJob}\n`);
}

export async function cmdFleetCrossReview(args: string[]): Promise<number> {
  const [verb, ...rest] = args;
  if (verb === undefined || verb === '--help' || verb === '-h' || rest.includes('--help') || rest.includes('-h')) {
    process.stdout.write(`${USAGE}\n\nrun     take one cross-model review on another pool and decide at the request's head\ndecide  decide at the head observed now against the newest recorded review\n\n--queue appends the tier1-verify fix job of a rejected Tier-1 PR to that router queue (once per id).\n`);
    return 0;
  }
  if (verb !== 'run' && verb !== 'decide') return fail(`unknown verb: ${verb}`);
  const bad = rejectUnknownOptions(rest, verb === 'run'
    ? { flags: ['--json'], values: ['--request', '--queue'] }
    : { flags: ['--json'], values: ['--request', '--head', '--pause-file', '--queue'] });
  if (bad) return fail(bad.message);
  const json = rest.includes('--json');
  const queuePath = valueOf(rest, '--queue');
  if (queuePath !== undefined && !queuePath.startsWith('/')) return fail('--queue must be an absolute path');

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
    printDecision(decision, review, json, queuePath);
    return 0;
  }
  const head = valueOf(rest, '--head');
  if (!isCommitSha(head)) return fail('--head must be the full lowercase head SHA observed now');
  const pauseFile = valueOf(rest, '--pause-file');
  if (pauseFile !== undefined && !pauseFile.startsWith('/')) return fail('--pause-file must be an absolute path');
  printDecision(await decideCrossReviewAtHead(parsed.request, policy.policy, head, pauseFile ? { pauseFile } : {}), null, json, queuePath);
  return 0;
}
