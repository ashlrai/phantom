import { readTaskCheckJobs } from './fleet-task-check.js';
import { mergeGraph } from '../core/fleet/merge-graph.js';
import { MERGE_CLASSES, readLeverageReport } from '../core/metrics/leverage-class.js';
import { readLeverageMix } from '../core/metrics/leverage-mix.js';
export { runMetricsCli } from './metrics-impact.js';
import { cmdMetricsIdle } from './metrics-idle.js';
import { cmdMetricsProd } from './metrics-prod.js';
/** `phm metrics [summary|dashboard|record|recommend|ingest]` — local telemetry + value metrics. */
import { join } from 'node:path';
import { rejectUnknownOptions } from './args.js';
import { ashlrHome } from '../core/cloud/store.js';
import { readTelemetry, recordEvent, type TelemetryInput } from '../core/metrics/telemetry.js';
import { recommend, rollup } from '../core/metrics/scoring.js';
import { renderDashboard } from '../core/metrics/dashboard.js';
import { ensurePrivateDirectory, writePrivateFileAtomic } from '../core/verse/preferences.js';
import { defaultStewardPolicy, runSteward } from '../core/steward/disk.js';
import { ingestMetrics, MetricsInputError } from '../core/fleet/metrics-ingest.js';
import { metricsText, readMetrics, type MetricsReader } from '../core/fleet/metrics-glance.js';
import { THROUGHPUT_MAX_HOURS, throughputOptions } from '../core/fleet/throughput.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const USAGE = `Usage: phm metrics [--hours N] [--json]
How well the self-improving loop is running, in one glance: PRs merged per hour (last 1, 6 and 24 hours), median publish-to-merge time,
empty rate, per-lane jobs, merged, empty rate and merge rate, merge rate by tier, and spend-down per pool (used, hours to reset,
projected unused, waste risk). --hours (1 to 168, default 24) sets the period for merge time and empty rate. --json prints schema
metrics.glance.v1. Reads ~/.ashlr-runs/queue/status.json and metrics/jobs.jsonl; missing or stale values print as unknown (null in JSON),
never zero. Read-only. Exit 1 only when neither file gives a reading. The desktop Metrics view shows the same report.

More reports: phm metrics <impact [--jobs file] [--queue file] [--overrides file]|loop [--since 24h] [--dry-run]|merges|summary|dashboard [--out file] [--prs file]|record <json>|recommend <taskType> <arm...>|idle --status <snapshot.json> --jobs <jobs.jsonl>|ingest --jobs <jobs.jsonl> --status <status.json>|levers [--window <7d|30d>]|leverage [--hours N] [--prs <file>]|leverage-mix [--prs <file>]|prod [--repo OWNER/REPO ...] [--lane NAME] [--bridge-label LABEL]> [--json]
phm metrics loop [--json] [--since 24h] shows where the loop waits (p50 and p90 per stage, slowest stage in words), then throughput, loop times, cost per merged PR and capacity per node; see phm metrics loop --help.
phm metrics merges [--json] reads the last 24 hourly buckets from the local jobs ledger.
phm metrics ingest reads two explicit local files and prints deterministic lane and tier metrics as JSON.
phm metrics levers ranks opportunity proxies from local activity and fleet rollups.
phm metrics leverage counts merges per class (fleet, product, docs, filler, unknown) per hour; --json is metrics.leverage.v1.
phm metrics leverage-mix reports the 24-hour fleet merge mix; --prs enriches it with GitHub PR file paths.
phm metrics prod reads bridge PR merge, release ancestry and exact npm or crates.io publication evidence. See docs/PRODUCTION-METRICS.md.
Every subcommand except prod stays local: no network, writes, provider calls or operational routing changes. See docs/METRICS-ROUTER-FEED.md for schemas.
Exit 0: report or help. Exit 2: invalid arguments or refused input.`;

interface CliIo {
  out: (line: string) => void;
  err: (line: string) => void;
  /** Injected sources and clock for the bare `phm metrics` report. */
  reader?: MetricsReader;
  now?: () => number;
}

/** Bare `phm metrics [--hours N] [--json]`: the one-glance loop report built in core/fleet/metrics-glance.ts. */
async function cmdGlance(argv: string[], io: CliIo): Promise<number> {
  const at = argv.indexOf('--hours');
  const options = throughputOptions(at < 0 ? null : argv[at + 1] ?? '');
  if (!options) { io.err(`phm metrics: --hours takes 1 to ${THROUGHPUT_MAX_HOURS}\n${USAGE}`); return 2; }
  const report = await readMetrics({ hours: options.hours, reader: io.reader, now: io.now?.() });
  io.out(argv.includes('--json') ? JSON.stringify(sanitizePublicJson(report), null, 2) : metricsText(report).map(line => sanitizePublicJson(line)).join('\n'));
  return report.sources.jobs === 'ok' || report.sources.status !== 'missing' ? 0 : 1;
}

function cmdIngest(args: string[], io: CliIo): number {
  const usage = (): number => { io.err(USAGE); return 2; };
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i++) {
    const option = args[i];
    if (!['--jobs', '--status'].includes(option) || options.has(option)) return usage();
    const value = args[++i];
    if (!value || value.startsWith('-')) return usage();
    options.set(option, value);
  }
  const jobs = options.get('--jobs'), status = options.get('--status');
  if (!jobs || !status) return usage();
  try {
    io.out(JSON.stringify(ingestMetrics(jobs, status), null, 2));
    return 0;
  } catch (error) {
    io.err(error instanceof MetricsInputError ? error.message : 'Metrics input could not be read.');
    return 2;
  }
}

export function cmdMetrics(argv: string[], io?: CliIo): number | Promise<number> {
  if (argv[0] === 'impact') return import('./metrics-impact.js').then(({ runMetricsCli }) => runMetricsCli(argv, io));
  if (argv[0] === 'prod') return cmdMetricsProd(argv, {}, io);
  if (argv[0] === 'idle') return cmdMetricsIdle(argv);
  if (argv[0] === 'loop') return import('./metrics-loop.js').then(({ cmdMetricsLoop }) => cmdMetricsLoop(argv.slice(1), io));
  if (argv[0] === 'levers' || (argv[0] === '--json' && argv[1] === 'levers')) {
    const args = argv[0] === 'levers' ? argv : ['levers', '--json', ...argv.slice(2)];
    return import('./metrics-levers.js').then(({ cmdMetricsLevers }) => cmdMetricsLevers(args, io));
  }
  io ??= { out: console.log, err: console.error };
  if (argv.includes('--help') || argv.includes('-h')) { io.out(USAGE); return 0; }
  if (argv.every((arg, i) => arg === '--json' || arg === '--hours' || argv[i - 1] === '--hours')) return cmdGlance(argv, io);
  const json = argv.includes('--json');
  const [sub, ...rest] = argv.filter((a) => a !== '--json');
  if (sub === 'help') { io.out(USAGE); return 0; }
  if (sub === 'ingest') return cmdIngest(rest, io);
  if (sub === 'merges') {
    if (rest.length) { io.err(USAGE); return 2; }
    return readTaskCheckJobs().then(raw => {
      const report = mergeGraph(raw);
      io.out(json ? JSON.stringify(report, null, 2) : !report.known ? 'Merge metrics: unknown' : report.lanes!.length ? report.lanes!.map(lane => `${lane.lane}: ${lane.buckets.reduce((sum, bucket) => sum + bucket.merges, 0)} merges`).join('\n') : 'No merges in the last 24 hours');
      return 0;
    });
  }
  if (sub === 'leverage') {
    let hours = 24, prs: string | undefined;
    for (let i = 0; i < rest.length; i += 2) {
      const value = rest[i + 1];
      if (!value || value.startsWith('-') || (rest[i] !== '--hours' && rest[i] !== '--prs')) { io.err(USAGE); return 2; }
      if (rest[i] === '--prs') prs = value;
      else if (/^\d{1,3}$/.test(value) && +value >= 1 && +value <= 168) hours = +value;
      else { io.err('phm metrics leverage: --hours takes a whole number from 1 to 168.'); return 2; }
    }
    const report = readLeverageReport({ hours, prsPath: prs });
    if (json) io.out(JSON.stringify(report, null, 2));
    else if (!report.known) io.out('Merge leverage: unknown (job metrics file unreadable)');
    else {
      io.out(`Fleet and product share: ${report.leverageShare === null ? 'no merges' : `${(report.leverageShare * 100).toFixed(1)}%`} of ${report.total} merges in the last ${hours} hours.`);
      io.out(MERGE_CLASSES.map(name => `${name} ${report.totals![name]}`).join(' · '));
    }
    return 0;
  }
  if (sub === 'leverage-mix') {
    if (rest.length && (rest.length !== 2 || rest[0] !== '--prs' || !rest[1] || rest[1].startsWith('-'))) { io.err(USAGE); return 2; }
    const report = readLeverageMix(rest[1]);
    io.out(json ? JSON.stringify(report, null, 2) : `Product or fleet improvements: ${report.improvedShare === null ? 'unknown' : `${(report.improvedShare * 100).toFixed(1)}%`} of merges in the last 24 hours (known classifications; unknowns included in total).`);
    return 0;
  }
  if (rejectUnknownOptions(rest, sub === 'dashboard' ? { values: ['--out', '--prs'] } : {})) { io.err(USAGE); return 2; }
  try {
    switch (sub) {
      case 'summary': {
        if (rest.length) { io.err(USAGE); return 2; }
        const r = rollup(readTelemetry());
        if (json) return import('../core/fleet/metrics-panel.js').then(async ({ readMetricsPanel }) => { io.out(JSON.stringify({ ...r, fleetMetrics: await readMetricsPanel() }, null, 2)); return 0; });
        else io.out(`${r.totals.prsShipped} PRs shipped · ${r.totals.valuePerMTok} value/1M tok · ${r.totals.valuePerHour} value/hr · ${r.totals.valuePerUsd ?? '—'} value/$`);
        return 0;
      }
      case 'dashboard': {
        const options = new Map<string, string>();
        for (let i = 0; i < rest.length; i += 2) {
          const key = rest[i], value = rest[i + 1];
          if (!key || !['--out', '--prs'].includes(key) || options.has(key) || !value || value.startsWith('-')) { io.err(USAGE); return 2; }
          options.set(key, value);
        }
        const out = options.get('--out') ?? join(ashlrHome(), 'metrics', 'dashboard.html');
        const html = renderDashboard(rollup(readTelemetry()), runSteward(defaultStewardPolicy()), undefined, readLeverageMix(options.get('--prs')));
        if (!options.has('--out')) { ensurePrivateDirectory(ashlrHome()); ensurePrivateDirectory(join(ashlrHome(), 'metrics')); }
        writePrivateFileAtomic(out, html);
        io.out(out); return 0;
      }
      case 'record': { if (rest.length !== 1) { io.err(USAGE); return 2; } let input: TelemetryInput; try { input = JSON.parse(rest[0]!) as TelemetryInput; } catch { io.err('phm metrics: invalid JSON event.'); return 2; } const ev = recordEvent(input); io.out(json ? JSON.stringify(ev) : ev.id); return 0; }
      case 'recommend': { const [taskType, ...arms] = rest; if (!taskType || !arms.length) { io.err(USAGE); return 2; } io.out(JSON.stringify(recommend(readTelemetry(), taskType, arms), null, 2)); return 0; }
      default: io.err(USAGE); return 2;
    }
  } catch { io.err('phm metrics: unable to process metrics; check the event schema and local file permissions.'); return 1; }
}
