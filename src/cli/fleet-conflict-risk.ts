/**
 * `ashlr fleet conflict-risk` — read-only conflict predictor for the rebase
 * scheduler.
 *
 * For each --repo, predicts which open PRs will conflict with the next
 * `--next` merges: open PRs and their file lists come from one bounded
 * `gh pr list` read, merge order from the fleet backlog planner (ready, then
 * behind, then non-draft pending — oldest first), and recency from a merged
 * page plus the jobs ledger's MERGED outcomes. High-risk PRs carry
 * `rebaseRecommended` so the scheduler can rebase them before their turn.
 *
 * READ-ONLY: never rebases, merges, queues or writes. Exit 0 when every
 * repo's reads are complete, 1 on any failed or truncated leg, 2 bad usage.
 */
import {
  CONFLICT_RISK_DEFAULT_LIMIT,
  CONFLICT_RISK_DEFAULT_MERGED_LIMIT,
  CONFLICT_RISK_DEFAULT_NEXT,
  CONFLICT_RISK_DEFAULT_WINDOW_HOURS,
  CONFLICT_RISK_MAX_LIMIT,
  CONFLICT_RISK_MAX_MERGED_LIMIT,
  CONFLICT_RISK_MAX_NEXT,
  CONFLICT_RISK_MAX_WINDOW_HOURS,
  readConflictRisk,
  type ConflictRiskReport,
} from '../core/fleet/conflict-risk.js';
import type { CloudGh } from '../core/cloud/pr-actions.js';
import type { FleetMergeStateRead } from '../core/fleet/fleet-merge-state.js';
import { readTaskCheckJobs, type TaskCheckReader } from './fleet-task-check.js';

const usage = 'Usage: ashlr fleet conflict-risk [--repo <owner/name>]... (default ashlrai/phantom) '
  + `[--next 1-${CONFLICT_RISK_MAX_NEXT}] [--limit 1-${CONFLICT_RISK_MAX_LIMIT}] `
  + `[--merged-limit 1-${CONFLICT_RISK_MAX_MERGED_LIMIT}] [--window-hours 1-${CONFLICT_RISK_MAX_WINDOW_HOURS}] [--json]`;

const DEFAULT_REPO = 'ashlrai/phantom';
const MAX_REPOS = 8;
const REPO_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/[A-Za-z0-9._-]{1,100}$/;

export interface FleetConflictRiskDeps {
  /** Injected gh reader; defaults to the bounded production runner in core. */
  gh?: CloudGh;
  /** Injected jobs-ledger reader; defaults to ~/.ashlr-runs/metrics/jobs.jsonl. */
  jobs?: TaskCheckReader;
  /** Injected merge-state join; defaults to the local record store. */
  states?: (repo: string) => ReadonlyMap<number, FleetMergeStateRead>;
  now?: () => Date;
}

const intFlag = (raw: string | undefined, min: number, max: number): number | null => {
  if (raw === undefined || !/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) && n >= min && n <= max ? n : null;
};

function humanReport(report: ConflictRiskReport): string[] {
  const lines: string[] = [];
  if (report.source === 'open-failed') {
    lines.push(`${report.repo}: open PR read failed (${report.reason ?? 'unknown'})`);
    return lines;
  }
  const v = report.velocity;
  lines.push(`${report.repo}: ${v.mergesPerHour === null ? 'unknown' : v.mergesPerHour.toFixed(2)} merges/hour`
    + ` (${v.source}, ${v.windowHours}h window${v.truncated ? ', truncated' : ''})`
    + `; horizon ${report.horizonHours === null ? 'unknown' : `${report.horizonHours}h`} for next ${report.next}`
    + `; hot window ${report.hotWindowHours}h${report.complete ? '' : ' — open page truncated'}`);
  const seq = report.nextMerges.map(m => `#${m.number} ${m.tier}`).join(', ');
  lines.push(`  next merges: ${seq || 'none predicted'}`);
  for (const risk of report.risks.slice(0, 12)) {
    const paths = risk.threats.flatMap(t => t.shared).slice(0, 3).join(', ');
    lines.push(`  ${risk.band === 'high' ? 'HIGH' : risk.band} #${risk.number} score ${risk.score}`
      + ` — conflicts by merge ${risk.conflictByPosition} (${risk.threats.length} threat${risk.threats.length === 1 ? '' : 's'}`
      + `${paths ? `, e.g. ${paths}` : ''})${risk.rebaseRecommended ? ' — rebase recommended' : ''}`);
  }
  if (report.risksOmitted > 0 || report.risks.length > 12) {
    lines.push(`  … ${Math.max(report.risksOmitted, report.risks.length - 12)} more threatened PR(s) not shown`);
  }
  if (report.conflicting.length > 0) {
    lines.push(`  already conflicting (recut, not rebase): ${report.conflicting.map(c => `#${c.number}`).join(' ')}`);
  }
  const c = report.counts;
  lines.push(`  open ${c.open} (${c.unreadable} unreadable), predicted ${c.predicted},`
    + ` bands: high ${c.high}, medium ${c.medium}, low ${c.low}, none ${c.none}`);
  return lines;
}

export async function cmdFleetConflictRisk(args: string[], deps: FleetConflictRiskDeps = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(`${usage}\nPredicts which open PRs will conflict with the next --next merges (file-overlap + recency heuristic); high-risk rows carry rebaseRecommended for the rebase scheduler. Read-only.`);
    return 0;
  }
  const repos: string[] = [];
  let json = false;
  let next = CONFLICT_RISK_DEFAULT_NEXT;
  let limit = CONFLICT_RISK_DEFAULT_LIMIT;
  let mergedLimit = CONFLICT_RISK_DEFAULT_MERGED_LIMIT;
  let windowHours = CONFLICT_RISK_DEFAULT_WINDOW_HOURS;
  const invalid = (): number => { console.error(`error: invalid fleet conflict-risk arguments\n${usage}`); return 2; };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') { json = true; continue; }
    if (arg === '--repo') {
      const value = args[++i];
      if (!REPO_RE.test(value ?? '') || repos.includes(value!) || repos.length >= MAX_REPOS) return invalid();
      repos.push(value!);
      continue;
    }
    if (arg === '--next' || arg === '--limit' || arg === '--merged-limit' || arg === '--window-hours') {
      const bounds = arg === '--next' ? [1, CONFLICT_RISK_MAX_NEXT]
        : arg === '--limit' ? [1, CONFLICT_RISK_MAX_LIMIT]
        : arg === '--merged-limit' ? [1, CONFLICT_RISK_MAX_MERGED_LIMIT]
        : [1, CONFLICT_RISK_MAX_WINDOW_HOURS];
      const n = intFlag(args[++i], bounds[0]!, bounds[1]!);
      if (n === null) return invalid();
      if (arg === '--next') next = n;
      else if (arg === '--limit') limit = n;
      else if (arg === '--merged-limit') mergedLimit = n;
      else windowHours = n;
      continue;
    }
    return invalid();
  }
  const targets = repos.length ? repos : [DEFAULT_REPO];

  let ledger: string | null = null;
  try { ledger = await (deps.jobs ?? readTaskCheckJobs)(); } catch { ledger = null; }

  const reports = await Promise.all(targets.map(repo => readConflictRisk({
    repo, gh: deps.gh, ledger, states: deps.states, next, limit, mergedLimit, windowHours, now: deps.now,
  })));

  if (json) {
    console.log(JSON.stringify({
      schema: 'fleet.conflict-risk.v1', v: 1, generatedAt: (deps.now ?? (() => new Date()))().toISOString(),
      params: { next, limit, mergedLimit, windowHours }, repos: reports,
    }));
  } else {
    for (const report of reports) for (const line of humanReport(report)) console.log(line);
  }
  return reports.every(r => r.source === 'ok' && r.reads.merged === 'ok') ? 0 : 1;
}
