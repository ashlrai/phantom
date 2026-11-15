/** Read-only multi-repository review picks, sharing one ownership snapshot. */
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CloudGh } from '../cloud/pr-actions.js';
import { defaultGitRunner } from '../verse/git-ops.js';
import { inspectBusWorkClaims } from './bus-work-claims.js';
import { readFleetBoard } from './coordination.js';
import { readSource } from './runs-parked-queue.js';
import { listLiveWorkers } from './runs-live-workers.js';
import {
  parseReviewPickPrs, pickUnownedReview, readReviewPick,
  type ReviewPickClaims, type ReviewPickPr, type ReviewPickReadOptions, type ReviewPickReport,
} from './review-pick.js';

export interface ReviewPickMultiReport {
  schema: 'fleet.review-pick-multi.v1';
  as_of: string;
  repos: ReviewPickReport[];
  first: { repo: string; pr: number; head: string; head_sha: string; title: string } | null;
  reason: string;
}

/** Cache failures too, so a failing reader is never retried across repos. */
function once<T>(read: () => T): () => T {
  let cached: { value: T } | { error: unknown } | undefined;
  return () => {
    if (cached === undefined) {
      try { cached = { value: read() }; } catch (error) { cached = { error }; }
    }
    if ('error' in cached) throw cached.error;
    return cached.value;
  };
}

const defaultGh: CloudGh = async args => {
  const result = await defaultGitRunner('gh', args, {
    cwd: tmpdir(), timeoutMs: 20_000, maxStdoutBytes: 2 * 1024 * 1024,
  });
  return { ok: result.code === 0 && !result.timedOut && !result.truncated, stdout: result.stdout, stderr: result.stderr };
};

/** Deduplicate before the ten-repo cap; collect GitHub pages sequentially. */
export async function readReviewPickAcross(
  repos: string[], options: Omit<ReviewPickReadOptions, 'repo'> = {},
): Promise<ReviewPickMultiReport> {
  const seen = new Set<string>();
  const unique = repos.filter(repo => {
    const key = repo.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 10);
  const nowMs = (options.now ?? Date.now)();
  const runsDir = options.runsDir ?? join(homedir(), '.ashlr-runs');
  const shared = {
    ...options,
    now: () => nowMs,
    readClaimedTsv: once(options.readClaimedTsv ?? (() => readSource(join(runsDir, 'queue', 'claimed.tsv'), 8 * 1024 * 1024, false))),
    inspectBusWork: once(options.inspectBusWork ?? inspectBusWorkClaims),
    readBoard: once(options.readBoard ?? (() => readFleetBoard({ now: nowMs }))),
    listWorkers: once(options.listWorkers ?? listLiveWorkers),
  };
  const reports: ReviewPickReport[] = [];
  const candidates: { repo: string; row: ReviewPickPr }[] = [];
  for (const repo of unique) {
    let page: ReviewPickPr[] = [];
    const gh: CloudGh = async args => {
      const result = await (options.gh ?? defaultGh)(args);
      if (result.ok) {
        try { page = parseReviewPickPrs(JSON.parse(result.stdout)) ?? []; } catch { /* readReviewPick reports invalid JSON. */ }
      }
      return result;
    };
    const report = await readReviewPick({ ...shared, repo, gh });
    reports.push(report);
    const row = page.find(pr => pr.number === report.picked?.pr);
    if (row !== undefined) candidates.push({ repo, row });
  }
  // Reuse the single-repo ordering rather than maintaining a second ranking.
  // These candidates already passed ownership checks; synthetic ids distinguish
  // identical PR numbers on different repos while preserving numeric tie order.
  candidates.sort((a, b) => a.row.number - b.row.number);
  const emptyClaims: ReviewPickClaims = {
    claimedTsv: { state: 'healthy', claims: [] }, busWork: { source: 'available', claims: [] },
    board: { schema: 'fleet.coordination.v1', state: 'known', claims: [], messages: [], proposals: [], expiredClaims: 0 },
    liveWorkers: { v: 1, generatedAt: '', sourceState: 'healthy', workers: [], leaders: [], orchestratorAgents: 0 },
  };
  const ranked = pickUnownedReview({
    repo: '', now: nowMs, claims: emptyClaims,
    prs: candidates.map(({ row }, index) => ({ ...row, number: index + 1 })),
  });
  const ownershipUnavailable = reports.some(report => report.source.unavailable.length > 0);
  const best = ownershipUnavailable || ranked.picked === null ? undefined : candidates[ranked.picked.pr - 1];
  return {
    schema: 'fleet.review-pick-multi.v1', as_of: ranked.as_of, repos: reports,
    first: best === undefined ? null : {
      repo: best.repo, pr: best.row.number, head: best.row.headRef, head_sha: best.row.headSha, title: best.row.title,
    },
    reason: ownershipUnavailable ? 'ownership source unavailable'
      : best === undefined ? 'no unowned non-draft open PRs' : ranked.reason,
  };
}
