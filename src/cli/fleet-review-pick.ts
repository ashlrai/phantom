/**
 * `phm fleet review-pick` — READ-ONLY answer to "give me one currently
 * unowned review task with repository, PR/head and current owner"
 * (RQ-PHX-REVIEWPICK371; the 2026-11-12 22:27 ET and 2026-11-13 13:13 ET
 * orders).
 *
 * One `gh pr list --state open` page plus the four live ownership readers
 * (queue/claimed.tsv, the bus work claims table, the coordination board and
 * the process table) feed pickUnownedReview. The pick is the open non-draft
 * PR no live claim or running worker names, ordered CLEAN, then
 * BLOCKED/UNSTABLE, then DIRTY, then oldest update. When any ownership
 * source cannot be read the report says so in `source.unavailable` and
 * answers `picked: null` — `owner: 'none'` is never a guess.
 *
 * Read-only: it never creates claims, comments, labels or checkouts.
 * Exit 0 the answer is trustworthy (including an honest "none"), 1 a source
 * read failed, 2 bad usage.
 */
import { isAbsolute } from 'node:path';
import { looksLikeOption } from './args.js';
import type { CloudGh } from '../core/cloud/pr-actions.js';
import type { BusWorkClaimsInspection } from '../core/fleet/bus-work-claims.js';
import type { FleetBoard } from '../core/fleet/coordination.js';
import { readReviewPick, type ReviewPickReport } from '../core/fleet/review-pick.js';
import type { LiveWorkersSnapshot } from '../core/fleet/runs-live-workers.js';

const USAGE = `Usage: phm fleet review-pick [--repo <owner/name>] [--limit <n>] [--root <abs>] [--json]
Print one currently unowned review task: an open, non-draft PR that no live
claim (claimed.tsv, bus work claims, coordination board) or running worker
names, with its repo, head and owner 'none'. Defaults --repo ashlrai/phantom,
--limit 100, --root ~/.ashlr-runs. Read-only.`;

const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;
const DEFAULT_REPO = 'ashlrai/phantom';

export interface FleetReviewPickDeps {
  gh?: CloudGh;
  readClaimedTsv?: () => Promise<{ state: 'healthy' | 'missing' | 'degraded'; text: string }>;
  inspectBusWork?: () => BusWorkClaimsInspection;
  readBoard?: () => FleetBoard;
  listWorkers?: () => Promise<LiveWorkersSnapshot>;
  /** Runs dir for queue/claimed.tsv; `--root` wins, default ~/.ashlr-runs. */
  runsDir?: string;
  now?: () => number;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

function textReport(report: ReviewPickReport): string {
  const lines: string[] = [`repo: ${report.repo}`, `as_of: ${report.as_of}`];
  if (report.picked !== null) {
    lines.push(
      `pr: ${report.picked.pr}`,
      `head: ${report.picked.head}`,
      `head_sha: ${report.picked.head_sha}`,
      `title: ${report.picked.title}`,
      `owner: ${report.picked.owner}`,
    );
  } else {
    lines.push('picked: none');
  }
  lines.push(
    `reason: ${report.reason}`,
    `unowned_candidates: ${report.unowned_candidates}`,
    `skipped: ${report.skipped.length}`,
    `source.prs: ${report.source.prs}`,
    `source.unavailable: ${report.source.unavailable.length ? report.source.unavailable.join(',') : 'none'}`,
  );
  for (const row of report.skipped.slice(0, 20)) lines.push(`skipped #${row.pr}: ${row.why} (owner: ${row.owner ?? 'unclaimed'})`);
  if (report.skipped.length > 20) lines.push(`… ${report.skipped.length - 20} more skipped`);
  return `${lines.join('\n')}\n`;
}

export async function cmdFleetReviewPick(args: string[], deps: FleetReviewPickDeps = {}): Promise<number> {
  const out = deps.stdout ?? ((text: string) => { process.stdout.write(text); });
  const err = deps.stderr ?? ((text: string) => { process.stderr.write(text); });
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) { out(`${USAGE}\n`); return 0; }

  let repo: string | null = null;
  let limit: number | null = null;
  let root = deps.runsDir;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !json) { json = true; continue; }
    if (arg === '--repo' && repo === null) {
      const value = args[++i];
      if (!REPO_RE.test(value ?? '')) {
        err(`error: --repo requires <owner/name>, got: ${value ?? '(missing)'}\n${USAGE}\n`);
        return 2;
      }
      repo = value!;
      continue;
    }
    if (arg === '--limit' && limit === null) {
      const value = args[++i];
      if (!/^\d+$/.test(value ?? '') || Number(value) < 1 || Number(value) > 500) {
        err(`error: --limit requires 1-500, got: ${value ?? '(missing)'}\n${USAGE}\n`);
        return 2;
      }
      limit = Number(value);
      continue;
    }
    if (arg === '--root') {
      const value = args[++i];
      if (value === undefined || looksLikeOption(value) || !isAbsolute(value)) {
        err(`error: --root requires an absolute path, got: ${value ?? '(missing)'}\n${USAGE}\n`);
        return 2;
      }
      root = value;
      continue;
    }
    err(`error: invalid fleet review-pick argument: ${arg}\n${USAGE}\n`);
    return 2;
  }

  const report = await readReviewPick({
    repo: repo ?? DEFAULT_REPO,
    ...(limit === null ? {} : { limit }),
    ...(root === undefined ? {} : { runsDir: root }),
    ...(deps.gh === undefined ? {} : { gh: deps.gh }),
    ...(deps.readClaimedTsv === undefined ? {} : { readClaimedTsv: deps.readClaimedTsv }),
    ...(deps.inspectBusWork === undefined ? {} : { inspectBusWork: deps.inspectBusWork }),
    ...(deps.readBoard === undefined ? {} : { readBoard: deps.readBoard }),
    ...(deps.listWorkers === undefined ? {} : { listWorkers: deps.listWorkers }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });
  out(json ? `${JSON.stringify(report)}\n` : textReport(report));
  return report.source.prs === 'unavailable' || report.source.unavailable.length > 0 ? 1 : 0;
}
