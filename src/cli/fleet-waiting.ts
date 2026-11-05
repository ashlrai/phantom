import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

export interface FleetWaitingRow {
  id: string;
  pool: string;
  repo: string;
  ageSeconds: number | 'unknown';
}
export interface FleetWaitingReaders {
  queue(): Promise<string>;
  jobs(): Promise<string>;
  events(): Promise<string>;
}
const USAGE = 'Usage: ashlr fleet waiting [--json]\nRead-only: list READY leader jobs without a launch or precheck skip in the last 3000 metric lines. Age is seconds since the first dispatch event, or unknown.';
const root = () => join(homedir(), '.ashlr-runs');

/** Stream the ledger with bounded retained memory. */
async function jobsTail(): Promise<string> {
  const lines = createInterface({ input: createReadStream(join(root(), 'metrics/jobs.jsonl')), crlfDelay: Infinity });
  const ring: string[] = [];
  let count = 0;
  try {
    for await (const line of lines) ring[count++ % 3000] = line;
  } finally {
    lines.close();
  }
  const start = count > 3000 ? count % 3000 : 0;
  return [...ring.slice(start), ...ring.slice(0, start)].join('\n');
}
const readers: FleetWaitingReaders = {
  queue: () => readFile(join(root(), 'queue/router-queue.md'), 'utf8'),
  jobs: jobsTail,
  events: () => readFile(join(root(), 'dispatch-events.log'), 'utf8'),
};

/** Project only queue metadata; never copy prompts or log bodies into output. */
export function explainFleetWaiting(queue: string, jobs: string, events: string, now = Date.now()): FleetWaitingRow[] {
  const started = new Set<string>();
  const metricLines = jobs.split(/\r?\n/);
  if (metricLines.at(-1) === '') metricLines.pop();
  for (const line of metricLines.slice(-3000)) {
    try {
      const row = JSON.parse(line) as { event?: string; job?: string; job_id?: string; jobId?: string };
      if (row.event === 'launch' || row.event === 'precheck_skip') {
        const id = row.job ?? row.job_id ?? row.jobId;
        if (typeof id === 'string') started.add(id);
      }
    } catch { /* Partial or malformed ledger rows provide no evidence. */ }
  }
  const first = new Map<string, number>();
  for (const line of events.split(/\r?\n/)) {
    for (const id of line.match(/\bRQ-[A-Za-z0-9_-]+\b/g) ?? []) {
      if (!first.has(id)) {
        const stamp = line.match(/^\[?(\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/)?.[1];
        first.set(id, stamp ? Date.parse(stamp) : NaN);
      }
    }
  }
  const waiting = new Map<string, FleetWaitingRow>();
  for (const line of queue.split(/\r?\n/)) {
    const id = line.match(/^- READY (RQ-[A-Za-z0-9_-]+)(?=\s|$)/)?.[1];
    if (!id || started.has(id) || !/(?:^|\s)src=leader(?=\s|[,;)]|$)/.test(line)) continue;
    const field = (key: string) => line.match(new RegExp(`(?:^|[\\s,(])${key}=([A-Za-z0-9_./-]+)(?=\\s|[,;)]|$)`))?.[1];
    const pool = field('pool');
    const repo = field('repo');
    if (!pool || !repo) continue;
    const timestamp = first.get(id);
    const ageSeconds = timestamp !== undefined && Number.isFinite(timestamp) && timestamp <= now
      ? Math.floor((now - timestamp) / 1000) : 'unknown';
    if (!waiting.has(id)) waiting.set(id, { id, pool, repo, ageSeconds });
  }
  return [...waiting.values()];
}

export async function cmdFleetWaiting(args: string[], input: FleetWaitingReaders = readers, now = Date.now()): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) {
    console.log(USAGE);
    return 0;
  }
  if (args.length > 1 || (args.length === 1 && args[0] !== '--json')) {
    console.error(USAGE);
    return 2;
  }
  try {
    const [queue, jobs, events] = await Promise.all([input.queue(), input.jobs(), input.events()]);
    const rows = explainFleetWaiting(queue, jobs, events, now);
    if (args.includes('--json')) console.log(JSON.stringify({ schema: 'fleet.waiting.v1', readOnly: true, rows }));
    else for (const row of rows) console.log(`${row.id} pool=${row.pool} repo=${row.repo} age=${row.ageSeconds === 'unknown' ? 'unknown' : `${row.ageSeconds}s`}`);
    return 0;
  } catch {
    const error = 'Waiting-job evidence is unreadable.';
    console.log(args.includes('--json') ? JSON.stringify({ schema: 'fleet.waiting.v1', readOnly: true, error }) : error);
    return 2;
  }
}
