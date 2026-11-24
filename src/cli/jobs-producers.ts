/** `phm jobs producers`: who queued the jobs that started, per hour. Read-only. */
import { join, resolve } from 'node:path';
import { readFile } from 'node:fs/promises';
import { jobProducerLines, jobProducers, PRODUCER_WINDOW_HOURS, queueProducers, unknownJobProducers } from '../core/fleet/job-producers.js';
import { readLedgerLines, type YieldLineReader } from '../core/fleet/ledger-lines.js';
import { runsRoot } from '../core/metrics/loop-collect.js';
import { sanitizePublicJson } from '../core/util/public-json.js';

const usage = 'Usage: phm jobs producers [--since 6h] [--metrics <jobs.jsonl>] [--queue <router-queue.md>] [--json]';
const MAX_QUEUE_BYTES = 8 * 1024 * 1024;

export async function cmdJobsProducers(args: string[], read: YieldLineReader = readLedgerLines, now = Date.now()): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(`${usage}
Who queued the jobs that started: launches per producer and per hour over the last --since hours (default ${PRODUCER_WINDOW_HOURS}).
A producer is the src= tag on the job's router queue line; a job with no tag, or no queue line, is unknown.
Reads <fleet runs dir>/metrics/jobs.jsonl and <fleet runs dir>/queue/router-queue.md. An unreadable queue file
leaves producers unknown; an unreadable metrics file exits 1.
JSON is jobs.producers.v1 with version 1; hourly[0] is the most recent hour.`);
    return 0;
  }
  let hours = PRODUCER_WINDOW_HOURS, json = false, seenSince = false, metrics: string | null = null, queue: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--json' && !json) json = true;
    else if (arg === '--metrics' && metrics === null) {
      metrics = args[++i] ?? '';
      if (!metrics || metrics.startsWith('-')) { console.error(usage); return 2; }
    } else if (arg === '--queue' && queue === null) {
      queue = args[++i] ?? '';
      if (!queue || queue.startsWith('-')) { console.error(usage); return 2; }
    } else if (arg === '--since' && !seenSince) {
      seenSince = true;
      const match = /^(\d+(?:\.\d+)?)([hd])$/.exec(args[++i] ?? '');
      if (!match) { console.error(usage); return 2; }
      hours = Number(match[1]) * (match[2] === 'd' ? 24 : 1);
    } else { console.error(usage); return 2; }
  }
  if (!Number.isFinite(hours) || hours <= 0 || hours > 8760) { console.error(usage); return 2; }

  const root = runsRoot();
  const ledger: string[] = [];
  let report = unknownJobProducers(hours);
  try {
    if (await read(resolve(metrics ?? join(root, 'metrics', 'jobs.jsonl')), line => ledger.push(line))) {
      let queueMap: Map<string, string> | null = null;
      try {
        const text = await readFile(resolve(queue ?? join(root, 'queue', 'router-queue.md')), 'utf8');
        if (text.length <= MAX_QUEUE_BYTES) queueMap = queueProducers(text);
      } catch { /* queue unknown: producers fall back to launch rows */ }
      report = jobProducers(ledger, queueMap, now, hours);
    }
  } catch { /* unknown report above */ }

  if (json) console.log(JSON.stringify(sanitizePublicJson(report)));
  else if (!report.known) { console.error(report.summary); return 1; }
  else console.log(jobProducerLines(report).join('\n'));
  return report.known ? 0 : 1;
}
