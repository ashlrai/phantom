import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { controlQueue } from '../core/queue/controller.js';
import { writeQueueDecision } from '../core/queue/store.js';
import { readPrivateFileCapped } from '../core/verse/preferences.js';
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

const MAX_INPUT_BYTES = 1024 * 1024;
const CONTROL_HELP = [
  'Usage: phm queue control --input FILE --out DIR [--dry-run] [--json]',
  '  --input FILE   Explicit queue snapshot JSON (at most 1 MiB).',
  '  --out DIR      Private local decision store; required unless --dry-run.',
  '  --dry-run      Compute the control overlay without writing files.',
  '  --json         Emit {decision,persistence}; persistence is null for dry runs.',
  'This command writes local controller, bandit and LP inputs. It does not launch',
  'workers, change production limits, skip required tests, or merge anything.',
].join('\n');

interface Options { input: string; out?: string; dryRun: boolean; json: boolean }

function parseOptions(args: string[]): Options | null {
  if (args[0] !== 'control') return null;
  const options: Options = { input: '', dryRun: false, json: false };
  const seen = new Set<string>();
  for (let i = 1; i < args.length; i++) {
    const flag = args[i]!;
    if (seen.has(flag)) return null;
    seen.add(flag);
    if (flag === '--dry-run') options.dryRun = true;
    else if (flag === '--json') options.json = true;
    else if (flag === '--input' || flag === '--out') {
      const value = args[++i];
      if (!value || value.startsWith('-')) return null;
      if (flag === '--input') options.input = resolve(value);
      else options.out = resolve(value);
    } else return null;
  }
  return options.input && (options.dryRun || options.out) ? options : null;
}

async function cmdQueueControl(args: string[]): Promise<number> {
  if (args.length === 2 && ['help', '--help', '-h'].includes(args[1]!)) {
    process.stdout.write(`${CONTROL_HELP}\n`);
    return 0;
  }
  const options = parseOptions(args);
  if (!options) {
    process.stderr.write(`Invalid queue arguments.\n${CONTROL_HELP}\n`);
    return 2;
  }
  const input = readPrivateFileCapped(options.input, MAX_INPUT_BYTES);
  if (!input || input.truncated || input.bytes !== Buffer.byteLength(input.text, 'utf8')) {
    process.stderr.write('Queue input must be a readable regular JSON file of at most 1 MiB.\n');
    return 1;
  }
  let decision: ReturnType<typeof controlQueue>;
  try {
    decision = controlQueue(JSON.parse(input.text) as unknown);
  } catch {
    // Parser errors may contain the caller's raw file contents; do not echo them.
    process.stderr.write('Invalid queue snapshot. See docs/QUEUE-CONTROL.md for the input contract.\n');
    return 1;
  }
  try {
    const persistence = options.dryRun ? null : await writeQueueDecision(options.out!, decision);
    if (options.json) process.stdout.write(`${JSON.stringify({ decision, persistence })}\n`);
    else {
      const bottleneck = decision.bottleneck;
      process.stdout.write([
        bottleneck ? `Bottleneck: ${bottleneck.stage} (${bottleneck.reason}).` : 'Bottleneck: none.',
        `Planner: ${decision.planner.mode}; rate ${decision.planner.rate}. ${decision.planner.reason}`,
        `Control actions: ${decision.actions.length}.`,
        ...decision.actions.map((action) => `  ${action.stage}: ${action.control} ${String(action.from)} -> ${String(action.to)} (${action.reason}).`),
        persistence ? `Decision ${persistence.replayed ? 'already recorded' : 'recorded'}: ${persistence.path}` : 'Dry run: no files written.',
      ].join('\n') + '\n');
    }
    return 0;
  } catch {
    process.stderr.write('Queue decision could not be persisted. No production changes were attempted.\n');
    return 1;
  }
}

export async function cmdQueue(args: string[]): Promise<number> {
  if (args[0] === 'control') return cmdQueueControl(args);
  if (args.length === 0 || (args.length === 1 && ['help', '--help', '-h'].includes(args[0]!))) { console.log(`${HELP}\n${CONTROL_HELP}`); return 0; }
  if (args.includes('--help') || args.includes('-h')) { console.log(HELP); return 0; }
  if (args[0] === 'stats') return cmdQueueStats(args);
  if (args[0] === 'report') return cmdQueueReport(args);
  console.error(`Invalid queue arguments.\n${HELP}\n${CONTROL_HELP}`);
  return 2;
}
