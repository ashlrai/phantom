import { readFile } from 'node:fs/promises';
import { queueReportFromText } from '../core/queue-metrics.js';
import { parseBanditFileConfig, banditConfigFrom } from '../core/bandit/flag.js';
import { replayOutcomeText } from '../core/bandit/replay.js';
import type { ReplaySummary } from '../core/bandit/replay.js';

const HELP = `Usage: phm queue report --events <file> [--json]
Read local JSON/JSONL station visits: {station, arrivedAt, startedAt?, completedAt?}.
Timestamps must be ISO with timezone. JSON may also be {start,end,events:[...]}.
Default window: earliest arrival to latest event. Each row is one station visit.
lambda = arrivals/window; mu = 1/mean completed service time; rho = lambda/mu.
W = mean completed arrival-to-completion time. Rates: jobs/hour; W: hours.
Single-server stations; bottleneck = highest known rho (alphabetical ties).
Unknown metrics print n/a; incomplete visits count toward arrivals only.

       phm queue bandit --events <file> [--seed N] [--config <file>] [--json]
Replay router outcome logs (phantom-router-outcome/v1, JSON array or JSONL)
through the contextual lane bandit and report its reward against the static
router's logged reward. Rejection-sampling evaluation: only records where the
bandit's Thompson pick matches the logged lane are credited. Deterministic
for a fixed --seed. --config reads a router-bandit.json flag file for credit
floor and reward weights. before = static, after = bandit.`;

const fmt = (value: number | null) => value === null ? 'n/a' : value.toFixed(4);

async function cmdQueueReport(args: string[]): Promise<number> {
  let file: string | undefined;
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json' && !json) json = true;
    else if (arg === '--events' && file === undefined && args[i + 1] && !args[i + 1]!.startsWith('--')) file = args[++i];
    else { console.error(HELP); return 2; }
  }
  if (!file) { console.error(HELP); return 2; }
  try {
    const report = queueReportFromText(await readFile(file, 'utf8'));
    if (json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log('Station\tlambda (/h)\tmu (/h)\trho\tW (h)');
      for (const s of report.stations) console.log(`${s.station}\t${fmt(s.lambda)}\t${fmt(s.mu)}\t${fmt(s.rho)}\t${fmt(s.W)}`);
      console.log(`Bottleneck: ${report.bottleneck ?? 'n/a'}`);
    }
    return 0;
  } catch (err) {
    console.error(`queue report: ${err instanceof Error ? err.message : 'Unable to read events'}`);
    return 1;
  }
}

function printReplayLine(label: string, summary: ReplaySummary): void {
  console.log(
    `${label.padEnd(16)}${String(summary.records).padStart(8)}${fmt(summary.meanReward).padStart(14)}${fmt(summary.meanRawReward).padStart(12)}${fmt(summary.successRate).padStart(10)}`,
  );
}

async function cmdQueueBandit(args: string[]): Promise<number> {
  let file: string | undefined;
  let configFile: string | undefined;
  let seed: number | undefined;
  let json = false;
  const value = (index: number): string | undefined => {
    const next = args[index + 1];
    return next !== undefined && !next.startsWith('--') ? next : undefined;
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json' && !json) json = true;
    else if (arg === '--events' && file === undefined && value(i)) file = args[++i];
    else if (arg === '--config' && configFile === undefined && value(i)) configFile = args[++i];
    else if (arg === '--seed' && seed === undefined && value(i)) {
      const parsed = Number(args[++i]);
      if (!Number.isSafeInteger(parsed)) { console.error('queue bandit: --seed must be an integer'); return 2; }
      seed = parsed;
    }
    else { console.error(HELP); return 2; }
  }
  if (!file) { console.error(HELP); return 2; }
  try {
    let config;
    if (configFile !== undefined) {
      const parsed = parseBanditFileConfig(await readFile(configFile, 'utf8'));
      if (parsed.config === null) { console.error(`queue bandit: ${parsed.error ?? 'invalid config'}`); return 1; }
      config = banditConfigFrom(parsed.config);
    }
    const report = replayOutcomeText(await readFile(file, 'utf8'), { seed, config });
    if (json) console.log(JSON.stringify(report, null, 2));
    else {
      console.log(`Lane reward replay (${report.estimator}, seed ${report.seed})`);
      console.log(`records: ${report.records}  kept: ${report.kept} (${report.keptRate === null ? 'n/a' : `${(report.keptRate * 100).toFixed(1)}%`})  floor denials: ${report.floorDenials}`);
      console.log(`${'policy'.padEnd(16)}${'records'.padStart(8)}${'mean reward'.padStart(14)}${'raw reward'.padStart(12)}${'success'.padStart(10)}`);
      printReplayLine('static (before)', report.before);
      printReplayLine('bandit (after)', report.after);
      printReplayLine('static on kept', report.staticOnKept);
      console.log(`delta: ${report.delta.meanReward === null ? 'n/a' : `${report.delta.meanReward >= 0 ? '+' : ''}${report.delta.meanReward.toFixed(4)}`} mean reward (bandit − static)`);
    }
    return 0;
  } catch (err) {
    console.error(`queue bandit: ${err instanceof Error ? err.message : 'Unable to replay events'}`);
    return 1;
  }
}

export async function cmdQueue(args: string[]): Promise<number> {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) { console.log(HELP); return 0; }
  if (args[0] === 'report') return cmdQueueReport(args.slice(1));
  if (args[0] === 'bandit') return cmdQueueBandit(args.slice(1));
  console.error(HELP);
  return 2;
}
