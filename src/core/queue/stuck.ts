import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface StuckJob { id: string; age_s?: number; age?: 'unknown' }
export interface StuckQueue { jobs: StuckJob[]; eventsAvailable: boolean }

/** Events use local wall time, as written by dispatchd. Match whole job IDs. */
export function stuckJobs(queue: string, events: string, now = Date.now()): StuckJob[] {
  const first = new Map<string, number>();
  const launched = new Set<string>();
  for (const line of events.split('\n')) {
    const match = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\s+(.*)$/.exec(line);
    if (!match) continue;
    const ms = new Date(match[1]!.replace(' ', 'T')).getTime();
    const body = match[2]!;
    const launch = /^LAUNCH\s+([A-Za-z0-9][A-Za-z0-9._-]*)(?=\s|$)/.exec(body);
    if (launch) launched.add(launch[1]!);
    if (!Number.isFinite(ms) || ms > now) continue;
    for (const id of body.match(/[A-Za-z0-9][A-Za-z0-9._-]*/g) ?? []) {
      if (!first.has(id) || ms < first.get(id)!) first.set(id, ms);
    }
  }
  const jobs: StuckJob[] = [];
  for (const line of queue.split('\n')) {
    const match = /^- READY\s+([A-Za-z0-9][A-Za-z0-9._-]*)(?=\s|$)/.exec(line);
    if (!match || launched.has(match[1]!)) continue;
    const token = /(?:^|[\s,(])enq=(\d+)(?=$|[\s,)])/.exec(line);
    const enq = token ? Number(token[1]) * 1000 : undefined;
    const start = enq !== undefined && Number.isSafeInteger(enq) && enq <= now ? enq : first.get(match[1]!);
    jobs.push(start === undefined ? { id: match[1]!, age: 'unknown' } : { id: match[1]!, age_s: Math.floor((now - start) / 1000) });
  }
  return jobs;
}

export async function readStuckQueue(root = join(homedir(), '.ashlr-runs'), now = Date.now()): Promise<StuckQueue> {
  const queue = await readFile(join(root, 'queue', 'router-queue.md'), 'utf8');
  let events: string;
  let eventsAvailable = true;
  try { events = await readFile(join(root, 'dispatch-events.log'), 'utf8'); }
  catch { events = ''; eventsAvailable = false; }
  return { jobs: stuckJobs(queue, events, now), eventsAvailable };
}
