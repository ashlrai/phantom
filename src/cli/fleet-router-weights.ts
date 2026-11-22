/**
 * `phm fleet router-weights [--runs-dir <absolute dir>] [--json]` — advisory per-work-class router-weight
 * proposals from recorded outcomes (metrics/jobs.jsonl joined with the bounded side ledgers
 * api-spend/work-market/empty-tags/merge-events). Read-only: never writes weights.json and never
 * changes routing. Logic lives in src/core/router/weight-proposals.ts; this file parses argv and renders.
 * Exit: 0 for a bounded read (proposals or an insufficient-evidence refusal); 1 when the ledger is missing,
 * unreadable, not a file or oversized (reported as unavailable, never as an empty success); 2 for usage.
 */
import { isAbsolute } from 'node:path';

import { readControllerQuality, type ControllerQualityRead, type ControllerQualityReceipt } from '../core/router/controller-quality.js';
import { readRouterOutcomes, type RouterOutcomeRead } from '../core/router/outcomes.js';
import { buildRouterWeightProposalReport, type RouterWeightEvidence, type RouterWeightProposalReport } from '../core/router/weight-proposals.js';

export const FLEET_ROUTER_WEIGHTS_USAGE =
  'Usage: phm fleet router-weights [--runs-dir <absolute dir>] [--json]\n' +
  'Advisory only. Reads <runs-dir>/metrics/jobs.jsonl (default ASHLR_RUNS_DIR, then ~/.ashlr-runs) plus the bounded ' +
  'side ledgers (api-spend/work-market/empty-tags/merge-events) and the fleet controller\'s recorded lane-quality ' +
  'verdicts in <runs-dir>/queue/fleet-controller.json. ' +
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
  if (e.acus_mean !== null) parts.push(`acus=${e.acus_mean}(${e.acus_known})`);
  if (e.wall_s_mean !== null) parts.push(`wall_s=${e.wall_s_mean}(${e.wall_known})`);
  if (e.ttm_s_mean !== null) parts.push(`ttm_s=${e.ttm_s_mean}(${e.ttm_known})`);
  if (e.queue_wait_s_mean !== null) parts.push(`queue_wait_s=${e.queue_wait_s_mean}(${e.queue_wait_known})`);
  if (e.ci_wall_s_mean !== null) parts.push(`ci_wall_s=${e.ci_wall_s_mean}(${e.ci_wall_known})`);
  if (e.publish_wait_s_mean !== null) parts.push(`publish_wait_s=${e.publish_wait_s_mean}(${e.publish_wait_known})`);
  if (e.lane_blocked_known > 0 && e.lane_blocked_reasons !== null) {
    parts.push(`lane_blocked=${e.lane_blocked_known}(${e.lane_blocked_reasons.map(r => `${r.reason}:${r.jobs}`).join(',')})`);
  }
  if (e.tokens_total_mean !== null) parts.push(`tokens_total=${e.tokens_total_mean}(${e.tokens_known})`);
  if (e.diff_files_mean !== null) parts.push(`diff_files=${e.diff_files_mean}(${e.diff_files_known})`);
  if (e.diff_lines_mean !== null) parts.push(`diff_lines=${e.diff_lines_mean}(${e.diff_lines_known})`);
  if (e.passk_mean !== null) parts.push(`passk=${e.passk_mean}(${e.passk_known})`);
  if (e.lane_overrides_known > 0 && e.lane_override_reasons !== null) {
    parts.push(`lane_overrides=${e.lane_overrides_known}(${e.lane_override_reasons.map(r => `${r.reason}:${r.jobs}`).join(',')})`);
  }
  if (e.market_rejected_known > 0) {
    parts.push(`market_rejected=${e.market_rejected_known}` +
      (e.market_rejected_reasons !== null && e.market_rejected_reasons.length > 0
        ? `(${e.market_rejected_reasons.map(r => `${r.reason}:${r.jobs}`).join(',')})` : ''));
  }
  if (e.handoff_known > 0) {
    parts.push(`handoff=${e.handoff_known}` +
      (e.handoff_triggers !== null && e.handoff_triggers.length > 0
        ? `(${e.handoff_triggers.map(r => `${r.trigger}:${r.jobs}`).join(',')})` : ''));
  }
  if (e.provider_wall_known > 0) {
    parts.push(`provider_wall=${e.provider_wall_known}` +
      (e.provider_wall_triggers !== null && e.provider_wall_triggers.length > 0
        ? `(${e.provider_wall_triggers.map(r => `${r.trigger}:${r.jobs}`).join(',')})` : ''));
  }
  if (e.merge_queue_known > 0) {
    parts.push(`merge_queue=${e.merge_queue_known}` +
      (e.merge_queue_blocked_reasons !== null && e.merge_queue_blocked_reasons.length > 0
        ? `(blocked:${e.merge_queue_blocked_known}[${e.merge_queue_blocked_reasons.map(r => `${r.reason}:${r.jobs}`).join(',')}],` +
          `check_failures:${e.merge_queue_check_failures_known},conflicts:${e.merge_queue_conflicts_known},` +
          `retries:${e.merge_queue_retries_known},recuts:${e.merge_queue_recuts_known})`
        : `(check_failures:${e.merge_queue_check_failures_known},conflicts:${e.merge_queue_conflicts_known},` +
          `retries:${e.merge_queue_retries_known},recuts:${e.merge_queue_recuts_known})`));
  }
  return parts.length === 0 ? '' : ` evidence ${parts.join(' ')}`;
}

/** One compact text rendering of a validated route.quality.v1 receipt; nulls print as unknown. */
function qualityReceiptLine(r: ControllerQualityReceipt): string {
  const num = (v: number | null): string => v === null ? 'unknown' : String(v);
  const parts = [
    `weight ${num(r.from)}->${num(r.to)}`,
    `score=${num(r.score)}`,
    `resolved=${num(r.resolved)}`,
  ];
  if (r.ci_adverse_delta !== null) parts.push(`ci_adverse=${r.ci_adverse_delta}`);
  parts.push(`reason=${r.reason ?? 'unknown'}`, `mode=${r.mode ?? 'unknown'}`);
  if (r.decided_at !== null) parts.push(`decided_at=${r.decided_at}`);
  if (r.target_from !== null || r.target_to !== null) parts.push(`target ${num(r.target_from)}->${num(r.target_to)}`);
  return `  ${r.lane}: ${parts.join(' ')}`;
}

function proposalLines(report: RouterWeightProposalReport): string[] {
  const header = `router weight proposals status=${report.status} ledger=${report.ledger.state} market=${report.market_state} empty_tags=${report.empty_tag_state} merge_events=${report.merge_events_state} controller_quality=${report.controller_quality_state} truncated=${report.truncated} as_of=${report.as_of} ` +
    'advisory-only: not applied to routing or weights.json';
  if (report.status === 'unavailable') {
    return [header, `unavailable: ledger state=${report.ledger.state}; no proposals were computed`, `ledger ${report.ledger.path}`];
  }
  const counts = `known=${report.known_outcomes} unknown=${report.unknown_outcomes} unclassified=${report.unclassified_outcomes} ` +
    `min_samples=${report.bounds.min_samples} max_shift=${report.bounds.max_shift}`;
  const resolution = report.unknown_unresolved === null ? [] : [
    `unknown resolution: empty=${report.unknown_empty} nonzero_exit=${report.unknown_nonzero_exit} skipped=${report.unknown_skipped} deferred=${report.unknown_deferred} noop=${report.unknown_noop} handoffs=${report.unknown_handoffs} provider_walls=${report.unknown_provider_walls} unresolved=${report.unknown_unresolved}` +
      (report.unknown_failure_classes !== null && report.unknown_failure_classes.length > 0
        ? ` failure_classes=${report.unknown_failure_classes.map(c => `${c.failure_class}:${c.jobs}`).join(',')}`
        : '') +
      (report.unknown_empty_classes !== null && report.unknown_empty_classes.length > 0
        ? ` empty_classes=${report.unknown_empty_classes.map(c => `${c.empty_class}:${c.jobs}`).join(',')}`
        : '') +
      (report.unknown_task_outcomes !== null && report.unknown_task_outcomes.length > 0
        ? ` task_outcomes=${report.unknown_task_outcomes.map(c => `${c.task_outcome}:${c.jobs}`).join(',')}`
        : '') +
      (report.unknown_skip_reasons !== null && report.unknown_skip_reasons.length > 0
        ? ` skip_reasons=${report.unknown_skip_reasons.map(c => `${c.reason}:${c.jobs}`).join(',')}`
        : '') +
      (report.unknown_defer_reasons !== null && report.unknown_defer_reasons.length > 0
        ? ` defer_reasons=${report.unknown_defer_reasons.map(c => `${c.reason}:${c.jobs}`).join(',')}`
        : '') +
      (report.unknown_noop_reasons !== null && report.unknown_noop_reasons.length > 0
        ? ` noop_reasons=${report.unknown_noop_reasons.map(c => `${c.reason}:${c.jobs}`).join(',')}`
        : '') +
      (report.unknown_empty_tags !== null && report.unknown_empty_tags.length > 0
        ? ` empty_tags=${report.unknown_empty_tags.map(c => `${c.tag}:${c.jobs}`).join(',')}`
        : '') +
      (report.unknown_market_reasons !== null && report.unknown_market_reasons.length > 0
        ? ` market_reasons=${report.unknown_market_reasons.map(c => `${c.reason}:${c.jobs}`).join(',')}`
        : '') +
      (report.unknown_market_rejected !== null && report.unknown_market_rejected > 0
        ? ` market_rejected=${report.unknown_market_rejected}` +
          (report.unknown_market_rejected_reasons !== null && report.unknown_market_rejected_reasons.length > 0
            ? `(${report.unknown_market_rejected_reasons.map(c => `${c.reason}:${c.jobs}`).join(',')})` : '')
        : '') +
      (report.unknown_handoff_triggers !== null && report.unknown_handoff_triggers.length > 0
        ? ` handoff_triggers=${report.unknown_handoff_triggers.map(c => `${c.trigger}:${c.jobs}`).join(',')}`
        : '') +
      (report.unknown_provider_wall_triggers !== null && report.unknown_provider_wall_triggers.length > 0
        ? ` provider_wall_triggers=${report.unknown_provider_wall_triggers.map(c => `${c.trigger}:${c.jobs}`).join(',')}`
        : '') +
      (report.unknown_merge_queue !== null && report.unknown_merge_queue > 0
        ? ` merge_queue=${report.unknown_merge_queue}` +
          (report.unknown_merge_queue_blocked !== null && report.unknown_merge_queue_blocked > 0
            ? `(blocked:${report.unknown_merge_queue_blocked}` +
              (report.unknown_merge_queue_blocked_reasons !== null && report.unknown_merge_queue_blocked_reasons.length > 0
                ? `[${report.unknown_merge_queue_blocked_reasons.map(c => `${c.reason}:${c.jobs}`).join(',')}]` : '') +
              `,check_failures:${report.unknown_merge_queue_check_failures},conflicts:${report.unknown_merge_queue_conflicts},` +
              `retries:${report.unknown_merge_queue_retries},recuts:${report.unknown_merge_queue_recuts})`
            : `(check_failures:${report.unknown_merge_queue_check_failures},conflicts:${report.unknown_merge_queue_conflicts},` +
              `retries:${report.unknown_merge_queue_retries},recuts:${report.unknown_merge_queue_recuts})`)
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
  const usage = report.usage_missing !== null && report.usage_sources !== null &&
    (report.usage_missing.length > 0 || report.usage_sources.length > 0)
    ? [`usage coverage:` +
        (report.usage_missing.length > 0 ? ` missing=${report.usage_missing.map(c => `${c.usage_missing}:${c.jobs}`).join(',')}` : '') +
        (report.usage_sources.length > 0 ? ` sources=${report.usage_sources.map(c => `${c.usage_source}:${c.jobs}`).join(',')}` : '')]
    : [];
  const coverage = [
    ...(report.truncated ? ['coverage: retained tail only; older ledger rows were not read'] : []),
    ...(report.market_state !== 'read'
      ? [`market coverage: work-market.jsonl ${report.market_state}; work_class groups reflect jobs-ledger fields only`]
      : report.market_truncated
        ? ['market coverage: retained tail only; work_class joins cover the newest bytes']
        : []),
    ...(report.empty_tag_state !== 'read'
      ? [`empty-tag coverage: empty-tags.jsonl ${report.empty_tag_state}; no empty finish causes joined`]
      : report.empty_tag_truncated
        ? ['empty-tag coverage: retained tail only; empty_tag joins cover the newest bytes']
        : []),
    ...(report.merge_events_state !== 'read'
      ? [`merge-event coverage: merge-events.jsonl ${report.merge_events_state}; no merge-queue evidence joined`]
      : report.merge_events_truncated
        ? ['merge-event coverage: retained tail only; merge_queue joins cover the newest bytes']
        : []),
    ...(report.controller_quality_state !== 'read' && report.controller_quality_state !== 'unreported'
      ? [`controller-quality coverage: fleet-controller.json ${report.controller_quality_state}; no lane-quality verdicts joined`]
      : []),
  ];
  const quality = report.controller_quality_state === 'read'
    ? [
        ...(report.controller_quality !== null && report.controller_quality.length === 0
          ? ['controller quality: no lane-quality verdicts recorded']
          : []),
        ...(report.controller_quality !== null && report.controller_quality.length > 0
          ? ['controller quality verdicts (route.quality.v1, newest per lane, advisory context):',
             ...report.controller_quality.map(qualityReceiptLine)]
          : []),
        ...(report.controller_quality_invalid_rows !== null && report.controller_quality_invalid_rows > 0
          ? [`controller quality: ${report.controller_quality_invalid_rows} receipt rows failed validation and were not joined`]
          : []),
      ]
    : [];
  return [header, counts, ...resolution, `ledger ${report.ledger.path}`, ...usage, ...coverage, ...quality, ...rows, ...none];
}

export async function cmdFleetRouterWeights(
  args: string[],
  read: (opts: { runsDir?: string }) => Promise<RouterOutcomeRead> = readRouterOutcomes,
  now: () => string = () => new Date().toISOString(),
  readController: (opts: { runsDir?: string }) => Promise<ControllerQualityRead> = readControllerQuality,
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
  const runsOpts = parsed.runsDir === undefined ? {} : { runsDir: parsed.runsDir };
  try {
    result = await read(runsOpts);
  } catch {
    console.error('Router weight proposals unavailable.');
    return 1;
  }
  // The controller read is advisory context: a failure degrades to an
  // 'unreadable' state on the report, never to a command failure.
  const controller = await readController(runsOpts).catch(
    (): ControllerQualityRead => ({ state: 'unreadable', path: '', receipts: [], invalid_rows: null }));
  const report = buildRouterWeightProposalReport(result, now(), { controllerQuality: controller });
  console.log(parsed.json ? JSON.stringify(report) : proposalLines(report).join('\n'));
  return result.state === 'read' ? 0 : 1;
}
