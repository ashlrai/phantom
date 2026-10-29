import { readFile } from 'node:fs/promises';
import { queueReportFromText } from '../core/queue-metrics.js';
import { readQueueVisits } from '../core/queue/journal.js';
import { estimateQueueStats } from '../core/queue/stats.js';

const HELP = `Usage: phm queue stats [--json] [--window <seconds>]
       phm queue report --events <file> [--json]

stats: sliding windows over the local visit journal (~/.ashlr/queue/visits.jsonl).
  Windows default to 1h, 24h and 7d. Rates per second; wait in seconds.

report: read local JSON/JSONL station visits: {station, arrivedAt, startedAt?, completedAt?}.
  Timestamps must be ISO with timezone. JSON may also be {start,end,events:[...]}.
  Default window: earliest arrival to latest event. Each row is one station visit.
  lambda = arrivals/window; mu = 1/mean completed service time; rho = lambda/mu.
  W = mean completed arrival-to-completion time. Rates: jobs/hour; W: hours.
  Single-server stations; bottleneck = highest known rho (alphabetical ties).
  Unknown metrics print n/a; incomplete visits count toward arrivals only.`;

async function cmdQueueStats(args: string[]): Promise<number> {
  let windows: number[] | undefined;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--json') continue;
    if (args[i] === '--window') {
      const seconds = Number(args[++i]);
      if (Number.isFinite(seconds) && seconds > 0 && Number.isFinite(seconds * 1000)) { windows = [seconds * 1000]; continue; }
    }
    console.error(HELP); return 2;
  }
  try {
    const stats = estimateQueueStats(await readQueueVisits(), Date.now(), windows);
    if (args.includes('--json')) console.log(JSON.stringify(stats));
    else {
      for (const [scope, rows] of [['station', stats.stations], ['pool', stats.pools]] as const) {
        for (const row of rows) for (const w of row.windows) {
          console.log(`${scope}=${row[scope]} window=${w.windowMs / 1000}s lambda=${w.lambda} mu=${w.mu ?? 'unknown'} rho=${w.rho ?? 'unknown'} queue=${w.queueLength} wait=${w.wait ?? 'unknown'} wip=${w.wip} littleLaw=${w.littleLaw.flagged ?? 'unknown'}`);
        }
      }
      if (!stats.stations.length) console.log('No recorded queue visits.');
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Queue statistics unavailable';
    if (args.includes('--json')) console.log(JSON.stringify({ error: message }));
    else console.error(message);
    return 1;
  }
}

async function cmdQueueReport(args: string[]): Promise<number> {
  let file: string | undefined;
  let json = false;
  for (let i = 1; i < args.length; i++) {
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
      const fmt = (value: number | null) => value === null ? 'n/a' : value.toFixed(4);
      for (const s of report.stations) console.log(`${s.station}\t${fmt(s.lambda)}\t${fmt(s.mu)}\t${fmt(s.rho)}\t${fmt(s.W)}`);
      console.log(`Bottleneck: ${report.bottleneck ?? 'n/a'}`);
    }
    return 0;
  } catch (err) {
    console.error(`queue report: ${err instanceof Error ? err.message : 'Unable to read events'}`);
    return 1;
  }
}

export async function cmdQueue(args: string[]): Promise<number> {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) { console.log(HELP); return 0; }
  if (args[0] === 'stats') return cmdQueueStats(args);
  if (args[0] === 'report') return cmdQueueReport(args);
  console.error(HELP);
  return 2;
}
