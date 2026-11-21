/**
 * `phm fleet router-weights [--runs-dir <absolute dir>] [--json]` — advisory per-work-class router-weight
 * proposals from recorded outcomes (metrics/jobs.jsonl). Read-only: never writes weights.json and never
 * changes routing. Logic lives in src/core/router/weight-proposals.ts; this file parses argv and renders.
 * Exit: 0 for a bounded read (proposals or an insufficient-evidence refusal); 1 when the ledger is missing,
 * unreadable, not a file or oversized (reported as unavailable, never as an empty success); 2 for usage.
 */
import { isAbsolute } from 'node:path';

import { readRouterOutcomes, type RouterOutcomeRead } from '../core/router/outcomes.js';
import { buildRouterWeightProposalReport, type RouterWeightEvidence, type RouterWeightProposalReport } from '../core/router/weight-proposals.js';

export const FLEET_ROUTER_WEIGHTS_USAGE =
  'Usage: phm fleet router-weights [--runs-dir <absolute dir>] [--json]\n' +
  'Advisory only. Reads <runs-dir>/metrics/jobs.jsonl (default ASHLR_RUNS_DIR, then ~/.ashlr-runs). ' +
  'Proposes bounded weight shifts per work_class/lane from held-merge outcomes (20 known outcomes required, ' +
  'shifts capped at 0.1; merges recorded as reverted never count as held). Writes nothing and changes no ' +
  'live routing. Exit 0 for a read, 1 for an unavailable ledger, 2 for usage.';

function parseArgs(args: string[]): { runsDir?: string; json: boolean } | null {
  const parsed: { runsDir?: string; json: boolean } = { json: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !parsed.json) parsed.json = true;
    else if (arg === '--runs-dir' && parsed.runsDir === undefined) {
      const value = args[++i];
      if (value === undefined || !isAbsolute(value)) return null;
      parsed.runsDir = value;
    } else return null;
  }
  return parsed;
}

/** Compact `name=value(known)` evidence suffix; only signals with recorded coverage appear. */
function evidenceSuffix(e: RouterWeightEvidence): string {
  const parts: string[] = [];
  if (e.ci_first_pass_rate !== null) parts.push(`ci_first_pass=${e.ci_first_pass_rate}(${e.ci_first_pass_known})`);
  if (e.review_findings !== null) {
    const f = e.review_findings;
    parts.push(`review_findings=${f.fixed + f.rejected + f.ignored}(${e.review_findings_known})`);
  }
  if (e.cost_usd_mean !== null) parts.push(`cost_usd=${e.cost_usd_mean}(${e.cost_known})`);
  if (e.wall_s_mean !== null) parts.push(`wall_s=${e.wall_s_mean}(${e.wall_known})`);
  if (e.ttm_s_mean !== null) parts.push(`ttm_s=${e.ttm_s_mean}(${e.ttm_known})`);
  if (e.passk_mean !== null) parts.push(`passk=${e.passk_mean}(${e.passk_known})`);
  return parts.length === 0 ? '' : ` evidence ${parts.join(' ')}`;
}

function proposalLines(report: RouterWeightProposalReport): string[] {
  const header = `router weight proposals status=${report.status} ledger=${report.ledger.state} market=${report.market_state} truncated=${report.truncated} as_of=${report.as_of} ` +
    'advisory-only: not applied to routing or weights.json';
  if (report.status === 'unavailable') {
    return [header, `unavailable: ledger state=${report.ledger.state}; no proposals were computed`, `ledger ${report.ledger.path}`];
  }
  const counts = `known=${report.known_outcomes} unknown=${report.unknown_outcomes} unclassified=${report.unclassified_outcomes} ` +
    `min_samples=${report.bounds.min_samples} max_shift=${report.bounds.max_shift}`;
  const resolution = report.unknown_unresolved === null ? [] : [
    `unknown resolution: empty=${report.unknown_empty} nonzero_exit=${report.unknown_nonzero_exit} unresolved=${report.unknown_unresolved}` +
      (report.unknown_failure_classes !== null && report.unknown_failure_classes.length > 0
        ? ` failure_classes=${report.unknown_failure_classes.map(c => `${c.failure_class}:${c.jobs}`).join(',')}`
        : '') +
      (report.unknown_empty_classes !== null && report.unknown_empty_classes.length > 0
        ? ` empty_classes=${report.unknown_empty_classes.map(c => `${c.empty_class}:${c.jobs}`).join(',')}`
        : ''),
  ];
  const rows = report.proposals.map(p => {
    const reverted = p.reverted_n > 0 ? ` reverted=${p.reverted_n}` : '';
    const evidence = evidenceSuffix(p.evidence);
    return p.status === 'proposed'
      ? `${p.work_class}/${p.lane}: proposed ${p.baseline_weight} -> ${p.proposed_weight} (known=${p.known_n}${reverted})${evidence}`
      : `${p.work_class}/${p.lane}: insufficient evidence known=${p.known_n}${reverted} need=${report.bounds.min_samples}; baseline ${p.baseline_weight} unchanged${evidence}`;
  });
  const none = report.proposals.length === 0 ? ['insufficient evidence: no classified known outcomes'] : [];
  const coverage = [
    ...(report.truncated ? ['coverage: retained tail only; older ledger rows were not read'] : []),
    ...(report.market_state !== 'read'
      ? [`market coverage: work-market.jsonl ${report.market_state}; work_class groups reflect jobs-ledger fields only`]
      : report.market_truncated
        ? ['market coverage: retained tail only; work_class joins cover the newest bytes']
        : []),
  ];
  return [header, counts, ...resolution, `ledger ${report.ledger.path}`, ...coverage, ...rows, ...none];
}

export async function cmdFleetRouterWeights(
  args: string[],
  read: (opts: { runsDir?: string }) => Promise<RouterOutcomeRead> = readRouterOutcomes,
  now: () => string = () => new Date().toISOString(),
): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(FLEET_ROUTER_WEIGHTS_USAGE);
    return 0;
  }
  const parsed = parseArgs(args);
  if (!parsed) {
    console.error(FLEET_ROUTER_WEIGHTS_USAGE);
    return 2;
  }
  let result: RouterOutcomeRead;
  try {
    result = await read(parsed.runsDir === undefined ? {} : { runsDir: parsed.runsDir });
  } catch {
    console.error('Router weight proposals unavailable.');
    return 1;
  }
  const report = buildRouterWeightProposalReport(result, now());
  console.log(parsed.json ? JSON.stringify(report) : proposalLines(report).join('\n'));
  return result.state === 'read' ? 0 : 1;
}
