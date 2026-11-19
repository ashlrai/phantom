import { readFile } from 'node:fs/promises';
import { queueReportFromText } from '../core/queue-metrics.js';
import { readQueueVisits } from '../core/queue/journal.js';
import { estimateQueueStats } from '../core/queue/stats.js';

const HELP = `Usage: phm queue [--json]
       phm queue top <id> | lane <id> <lane> | drop <id> [--dry-run] [--json]
       phm queue stuck [--json]
       phm queue autofill --lane <lane> [--min <n>] [--apply] [--json]
       phm queue wait [--events <file>] [--json]
       phm queue batches [--runs <directory>] [--json]
       phm queue stats [--json] [--window <seconds>]
       phm queue visits-sync [--jobs <path>] [--queue <path>] [--journal <path>] [--apply] [--json]
       phm queue yield [--since 24h] [--json]
       phm queue report --events <file> [--json]
       phm queue dedupe [--file <router-queue.md>] [--apply] [--json]
       phm queue coalesce [<file>] [--apply --out <directory>] [--json]
       phm queue supersede [--json] [--apply]
       phm queue add|claim|done|block|replay|list|import|export|spawn|promote|serve [options]

stats: sliding windows over the local visit journal (~/.ashlr/queue/visits.jsonl).
  Windows default to 1h, 24h and 7d. Rates per second; wait in seconds.

visits-sync: fold metrics/jobs.jsonl and router-queue.md into that journal
  (dry run unless --apply). See docs/QUEUE-STATS.md for the station mapping.

report: read local JSON/JSONL station visits: {station, arrivedAt, startedAt?, completedAt?}.
  Timestamps must be ISO with timezone. JSON may also be {start,end,events:[...]}.
  Default window: earliest arrival to latest event. Each row is one station visit.
  lambda = arrivals/window; mu = 1/mean completed service time; rho = lambda/mu.
  W = mean completed arrival-to-completion time. Rates: jobs/hour; W: hours.
  Single-server stations; bottleneck = highest known rho (alphabetical ties).
  Unknown metrics print n/a; incomplete visits count toward arrivals only.

phm queue lists the queued jobs in launch order; --json adds them as the launch field of the batch report.
autofill: when a lane has fewer than --min ready jobs (default: its slot target), draft the gap from phm bets propose,
  skip anything already shipped or queued, and with --apply add the rest as READY jobs. Dry run by default.
top, lane and drop steer one queued job; see phm queue top --help.

Job queue: use phm queue <command> --help for options; see docs/QUEUE.md.`;

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
  if (args.length === 1 && args[0] === '--json') {
    // The batch report, plus the queue in launch order (schema queue.order.v1); null when there is no queue file.
    const { readQueueOrder } = await import('../core/queue/order.js');
    return (await import('./queue-batches.js')).cmdQueueBatches(args, async () => ({ launch: await readQueueOrder().catch(() => null) }));
  }
  if (args.length === 0) {
    // With a queue on this machine the bare command shows it; without one it shows the usage.
    const { readQueueOrder, queueOrderText } = await import('../core/queue/order.js');
    const order = await readQueueOrder().catch(() => null);
    if (order) { console.log([...queueOrderText(order), 'Steer a job with phm queue top|lane|drop <id>. All commands: phm queue --help'].join('\n')); return 0; }
  }
  let command: string | undefined;
  let commandIndex = -1;
  const valueOptions = new Set(['--since', '--query', '--mode', '--dir', '--priority', '--pool', '--tier', '--repo', '--scope', '--acceptance', '--deps', '--owner', '--pr-url', '--reason', '--window', '--events', '--preferred-lane', '--needs', '--min-tier', '--max-tier', '--max-cost-class', '--data-class', '--work-class', '--impact', '--port', '--token-file', '--runs', '--lane', '--min']);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') { command = args[i + 1]; commandIndex = i + 1; break; }
    if (valueOptions.has(arg)) { i++; continue; }
    if (!arg.startsWith('-')) { command = arg; commandIndex = i; break; }
  }
  if (command === 'top' || command === 'lane' || command === 'drop') return (await import('./queue-order.js')).cmdQueueOrder([command, ...args.filter((_, i) => i !== commandIndex)]);
  if (command === 'autofill') return (await import('./queue-autofill.js')).cmdQueueAutofill(args.filter((_, i) => i !== commandIndex));
  if (command === 'yield') return (await import('./queue-yield.js')).cmdQueueYield(args.slice(args.indexOf('yield') + 1));
  if (command === 'wait') return (await import('./queue-wait.js')).cmdQueueWait(args.filter((_, i) => i !== commandIndex));
  if (command === 'batches') return (await import('./queue-batches.js')).cmdQueueBatches(args.filter((_, i) => i !== commandIndex));
  if (command === 'coalesce') return (await import('./queue-coalesce.js')).cmdQueueCoalesce(args.slice(args.indexOf('coalesce') + 1));
  if (command === 'supersede') return (await import('./queue-supersede.js')).cmdQueueSupersede(args.slice(args.indexOf('supersede') + 1));
  if (command === 'dedupe') return (await import('./queue-dedupe.js')).cmdQueueDedupe(args.slice(args.indexOf('dedupe') + 1));
  if (['add', 'claim', 'done', 'block', 'replay', 'list', 'import', 'export', 'spawn', 'promote', 'serve'].includes(command ?? '') ||
      args.some(arg => arg === '--dir' || arg.startsWith('--dir='))) {
    return (await import('./job-queue.js')).cmdJobQueue(args);
  }
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) { console.log(HELP); return 0; }
  if (args[0] === 'stuck') {
    if (args.slice(1).some(arg => arg !== '--json')) { console.error(HELP); return 2; }
    try {
      const report = await (await import('../core/queue/stuck.js')).readStuckQueue();
      if (args.includes('--json')) console.log(JSON.stringify(report));
      else {
        if (!report.eventsAvailable) console.log('Dispatch events unavailable; launches may be missing.');
        if (!report.jobs.length) console.log('No waiting jobs found.');
        for (const job of report.jobs) console.log(`${job.id} · ${job.age_s === undefined ? 'age unknown' : `${job.age_s} seconds`}`);
      }
      return 0;
    } catch { console.error('Queue unavailable.'); return 1; }
  }
  if (args[0] === 'stats') return cmdQueueStats(args);
  if (args[0] === 'report') return cmdQueueReport(args);
  if (args[0] === 'visits-sync') return (await import('./queue-visits-sync.js')).cmdQueueVisitsSync(args.slice(1));
  console.error(HELP);
  return 2;
}
