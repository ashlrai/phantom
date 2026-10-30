import { refreshLoopReport } from '../core/fleet/loop-report.js';
import { LOOP_STAGES, type LoopReport } from '../core/fleet/loop.js';

export function formatLoopReport(report: LoopReport): string {
  const duration = (value: number | null): string => value === null ? 'unknown' : `${(value / 1000).toFixed(1)}s`;
  return [
    `Development loop (${report.schema}, last 7 days${report.complete ? '' : ', partial'})`,
    ...LOOP_STAGES.map(stage => `${stage}: p50 ${duration(report.stages[stage].p50_ms)}, p90 ${duration(report.stages[stage].p90_ms)} (n=${report.stages[stage].samples})`),
    `Bottleneck: ${report.bottleneck.stage ?? 'unknown'}${report.bottleneck.provisional ? ' (provisional)' : ''}`,
    `Merged PRs: ${report.merged_prs ?? 'unknown'}; revert rate: ${report.revert_rate.rate === null ? 'unknown' : `${(report.revert_rate.rate * 100).toFixed(1)}%`}`,
    `Merged PRs/$: ${report.cost.merged_prs_per_dollar ?? 'unknown'}; Grok Ultra points/merged PR: ${report.cost.grok_ultra_points_per_merged_pr ?? 'unknown'}`,
    `PostHog: ${report.telemetry}`,
  ].join('\n');
}
export async function cmdFleetLoop(args: string[]): Promise<number> {
  if (args.some(arg => arg !== '--json')) {
    process.stderr.write('usage: phm fleet loop [--json]\n');
    return 2;
  }
  try {
    const report = await refreshLoopReport();
    console.log(args.includes('--json') ? JSON.stringify(report, null, 2) : formatLoopReport(report));
    return report.complete && report.telemetry !== 'failed' ? 0 : 1;
  } catch {
    // Never surface raw gh, file contents, or fetch errors, which may contain credentials.
    const error = { schema: 'loop.v1', error: 'loop-refresh-failed', hint: 'Check PHANTOM_FLEET_PATH directory ownership, write access and any existing JSON state.' };
    if (args.includes('--json')) console.log(JSON.stringify(error));
    else process.stderr.write(`${error.error}: ${error.hint}\n`);
    return 1;
  }
}
