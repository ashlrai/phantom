/** `phm metrics loop [--dry-run] [--json]`: self-awareness loop report (RQ-BETS-LANE-1). Logic lives in core/metrics/loop*.ts. */
import { collectLoop, defaultLoopReaders, writeLoop, type LoopReaders } from '../core/metrics/loop-collect.js';
import { isMissing, type Measured } from '../core/metrics/loop.js';

export const METRICS_LOOP_USAGE = `Usage: phm metrics loop [--dry-run] [--json]
Measures merges and opens per hour (1h, 6h), idea-to-merged and merged-to-installed minutes, cost per merged PR,
per-lane merged per lane-hour and capacity per node from real sources only (jobs.jsonl, queue/, gh, the installed
Info.plist, the node inventory, Dot and Instinct tasks). Unknown values are {"missing": reason}.
Writes metrics/loop-YYYYMMDD.json, metrics/selection-hints.json, metrics/bets-share.json and merges fields into
reports/morning-YYYYMMDD.json under $ASHLR_RUNS_DIR or ~/.ashlr-runs. --dry-run writes nothing.
Exit 0 ok, 1 write failure, 2 bad usage.`;

const show = (v: Measured<unknown>, fmt: (x: never) => string) => isMissing(v) ? `missing (${v.missing})` : fmt(v as never);

export async function cmdMetricsLoop(args: string[], deps: { out?: (l: string) => void; err?: (l: string) => void; readers?: LoopReaders } = {}): Promise<number> {
  const out = deps.out ?? console.log, err = deps.err ?? console.error;
  if (args.includes('--help') || args.includes('-h')) { out(METRICS_LOOP_USAGE); return 0; }
  if (args.some(a => a !== '--json' && a !== '--dry-run') || new Set(args).size !== args.length) { err(METRICS_LOOP_USAGE); return 2; }
  const readers = deps.readers ?? defaultLoopReaders();
  const collection = await collectLoop(readers);
  let writes = null;
  if (!args.includes('--dry-run')) {
    try { writes = await writeLoop(readers.runsDir, collection, new Date(readers.now())); } catch (error) {
      err(`metrics loop: write failed (${error instanceof Error ? error.message : 'unknown'})`);
      return 1;
    }
  }
  const { report, hints, share } = collection;
  if (args.includes('--json')) { out(JSON.stringify({ report, hints, share, writes }, null, 2)); return 0; }
  out([
    `Throughput: ${show(report.throughput, (t: { merges_per_hour: Record<string, number>; opens_per_hour: Record<string, number> }) => `merges/h 1h ${t.merges_per_hour['1h']} 6h ${t.merges_per_hour['6h']}; opens/h 1h ${t.opens_per_hour['1h']} 6h ${t.opens_per_hour['6h']}`)}`,
    `Idea to merged p50: ${show(report.idea_to_merged_minutes, (d: { p50: number; samples: number }) => `${d.p50} min (${d.samples} jobs)`)}`,
    `Merged to installed p50: ${show(report.merged_to_installed_minutes, (d: { distribution: { p50: number; samples: number } | null; installedTag: string }) => d.distribution ? `${d.distribution.p50} min (${d.distribution.samples} PRs in ${d.installedTag})` : `no merges timed for ${d.installedTag}`)}`,
    `Feedback loop p50: ${show(report.feedback_loop_minutes, (d: { p50: number }) => `${d.p50} min`)}`,
    `Cost per merged PR: ${show(report.cost_per_merged_pr, (c: { usd: number }) => `$${c.usd}`)}`,
    `Top constraint: ${hints.top_constraint.name} (${hints.top_constraint.evidence})`,
    `Bets share: ${share.reason}`,
    ...(writes ? [`Wrote ${writes.loop}`] : []),
  ].join('\n'));
  return 0;
}
