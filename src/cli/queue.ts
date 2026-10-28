import { readFile } from 'node:fs/promises';
import { queueReportFromText } from '../core/queue-metrics.js';

const HELP = `Usage: phm queue report --events <file> [--json]
Read local JSON/JSONL station visits: {station, arrivedAt, startedAt?, completedAt?}.
Timestamps must be ISO with timezone. JSON may also be {start,end,events:[...]}.
Default window: earliest arrival to latest event. Each row is one station visit.
lambda = arrivals/window; mu = 1/mean completed service time; rho = lambda/mu.
W = mean completed arrival-to-completion time. Rates: jobs/hour; W: hours.
Single-server stations; bottleneck = highest known rho (alphabetical ties).
Unknown metrics print n/a; incomplete visits count toward arrivals only.`;

export async function cmdQueue(args: string[]): Promise<number> {
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) { console.log(HELP); return 0; }
  let file: string | undefined;
  let json = false;
  if (args[0] !== 'report') { console.error(HELP); return 2; }
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
