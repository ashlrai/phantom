import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildOutcomeMetrics } from '../core/fleet/outcome-metrics.js';
import { suggestOutcomePolicy } from '../core/fleet/policy-suggest.js';
import { renderOutcomeReport } from '../core/fleet/weekly-self-report.js';
import { readMetricsSeries } from '../core/fleet/metrics-series.js';
import { readLedgerTail } from '../core/router/outcomes.js';
import { runsRoot } from '../core/metrics/loop-collect.js';

const usage = 'Usage: phm fleet metrics [series|report|suggest|weekly] [--hours <1..2160>] [--jobs <file>] [--json]\nDefault: series (last 24h, merged PRs by repo and merges per launch, not human autonomy). Read-only; weekly defaults to 168 hours, report/suggest to 24. Missing evidence is unknown.';
/** What a ledger read may return: raw text, or the newest bounded tail plus its cut flag. */
export interface FleetMetricsLedgerRead { text: string; truncated: boolean }
const readTail: NonNullable<FleetMetricsDeps['read']> = async (path) => {
  const tail = await readLedgerTail(path);
  return tail.state === 'read' ? { text: tail.text, truncated: tail.truncated } : null;
};
const ledgerText = (raw: string | FleetMetricsLedgerRead | null): FleetMetricsLedgerRead | null =>
  raw === null ? null : typeof raw === 'string' ? { text: raw, truncated: false } : raw;
export interface FleetMetricsDeps { read?: (path: string) => Promise<string | FleetMetricsLedgerRead | null>; now?: () => number }
export async function cmdFleetMetrics(args: string[], deps: FleetMetricsDeps = {}): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { console.log(usage); return 0; }
  const [verb, ...rest] = !args.length || args[0]!.startsWith('--') ? ['series', ...args] : args;
  if (!['series', 'report', 'suggest', 'weekly'].includes(verb ?? '')) { console.error(usage); return 2; }
  let hours = verb === 'weekly' ? 168 : 24, path = join(homedir(), '.ashlr-runs', 'metrics', 'jobs.jsonl'), json = false;
  const seen = new Set<string>();
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (seen.has(arg)) { console.error(usage); return 2; }
    seen.add(arg);
    if (arg === '--json') json = true;
    else if (arg === '--hours' && rest[i + 1]) {
      hours = Number(rest[++i]);
      if (!Number.isFinite(hours) || hours < 1 || hours > 2160) { console.error(usage); return 2; }
    } else if (arg === '--jobs' && rest[i + 1] && !rest[i + 1]!.startsWith('--')) path = rest[++i]!;
    else { console.error(usage); return 2; }
  }
  if (verb === 'series') {
    if (seen.has('--hours')) { console.error('Series covers the last 24 hours.'); return 2; }
    if (!seen.has('--jobs')) path = join(runsRoot(), 'metrics', 'jobs.jsonl');
    const read = deps.read;
    const series = await readMetricsSeries(path, (deps.now ?? Date.now)(), read ? async (file, onLine) => {
      const ledger = ledgerText(await read(file));
      if (ledger === null) return false;
      for (const line of ledger.text.split(/\r?\n/)) onLine(line);
      return true;
    } : undefined);
    console.log(json ? JSON.stringify(series) : `Merged PRs: ${series.mergesLastHour ?? 'unknown'} in the last hour; ${series.mergesLast24h ?? 'unknown'} in the last 24 hours.\nHourly series: phm fleet metrics --json (merges per launch, not human autonomy).`);
    return series.known ? 0 : 1;
  }
  // The ledger is append-only: the default read keeps its newest bounded tail
  // (the same window the other jobs-ledger readers use) instead of refusing an
  // oversized file, and a cut tail marks the evidence degraded — retained rows
  // only, never a claim of complete window coverage.
  const ledger = ledgerText(await (deps.read ?? readTail)(path));
  const events = ledger === null ? null : ledger.text.split(/\r?\n/).filter(line => line.trim()).map(line => {
    try { return JSON.parse(line) as unknown; } catch { return null; }
  });
  const metrics = buildOutcomeMetrics({ events, nowMs: (deps.now ?? Date.now)(), hours,
    sourceState: ledger !== null && ledger.truncated ? 'degraded' : 'healthy' });
  const suggestions = suggestOutcomePolicy(metrics);
  const markdown = renderOutcomeReport(metrics, suggestions, verb === 'weekly' ? 'Weekly fleet self-report' : undefined);
  console.log(json ? JSON.stringify(verb === 'suggest' ? suggestions : verb === 'weekly' ? { metrics, suggestions, markdown } : metrics) : markdown);
  return metrics.sourceState === 'healthy' ? 0 : 1;
}
