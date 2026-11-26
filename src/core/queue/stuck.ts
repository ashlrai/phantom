import { createReadStream } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { parseReadyLineEnq } from './schema.js';

export interface StuckJob { id: string; age_s?: number; age?: 'unknown' }
export interface StuckQueue { jobs: StuckJob[]; eventsAvailable: boolean }

const EVENT_LINE = /^(\d{4}-\d\d-\d\d \d\d:\d\d:\d\d)\s+(.*)$/;
const LAUNCH_LINE = /^LAUNCH\s+([A-Za-z0-9][A-Za-z0-9._-]*)(?=\s|$)/;

/**
 * Incremental fold of dispatch-events.log lines: the earliest timestamped
 * mention and the latest LAUNCH per id. The log is append-only and never
 * compacted, so readers fold it line by line instead of holding the whole
 * file — memory stays flat at the number of distinct tokens seen, however
 * large the ledger grows. Events use local wall time, as written by
 * dispatchd; ids match whole job ids.
 */
export function stuckEventTally(now: number): {
  add(line: string): void;
  first: Map<string, number>;
  launched: Map<string, number>;
} {
  const first = new Map<string, number>();
  const launched = new Map<string, number>();
  return {
    first,
    launched,
    add(line: string) {
      const match = EVENT_LINE.exec(line);
      if (!match) return;
      const ms = new Date(match[1]!.replace(' ', 'T')).getTime();
      const body = match[2]!;
      const launch = LAUNCH_LINE.exec(body);
      if (!Number.isFinite(ms) || ms > now) return;
      if (launch) launched.set(launch[1]!, Math.max(ms, launched.get(launch[1]!) ?? 0));
      for (const id of body.match(/[A-Za-z0-9][A-Za-z0-9._-]*/g) ?? []) {
        if (!first.has(id) || ms < first.get(id)!) first.set(id, ms);
      }
    },
  };
}

function waitingJobs(queue: string, first: ReadonlyMap<string, number>, launched: ReadonlyMap<string, number>, now: number): StuckJob[] {
  const jobs: StuckJob[] = [];
  for (const line of queue.split('\n')) {
    const parsed = parseReadyLineEnq(line);
    if (!parsed) continue;
    const start = parsed.enqMs !== null && Number.isSafeInteger(parsed.enqMs) && parsed.enqMs <= now ? parsed.enqMs : first.get(parsed.id);
    const launchAt = launched.get(parsed.id);
    if (launchAt !== undefined && (start === undefined || launchAt >= start)) continue;
    jobs.push(start === undefined ? { id: parsed.id, age: 'unknown' } : { id: parsed.id, age_s: Math.floor((now - start) / 1000) });
  }
  return jobs;
}

/** READY router jobs without a recorded launch, given the events text. */
export function stuckJobs(queue: string, events: string, now = Date.now()): StuckJob[] {
  const tally = stuckEventTally(now);
  for (const line of events.split('\n')) tally.add(line);
  return waitingJobs(queue, tally.first, tally.launched, now);
}

/** Fold dispatch-events.log line by line; a missing or failed read rejects like readFile did. */
async function scanEvents(path: string, tally: ReturnType<typeof stuckEventTally>): Promise<void> {
  const lines = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity });
  for await (const line of lines) tally.add(line);
}

export async function readStuckQueue(root = join(homedir(), '.ashlr-runs'), now = Date.now()): Promise<StuckQueue> {
  const queue = await readFile(join(root, 'queue', 'router-queue.md'), 'utf8');
  const tally = stuckEventTally(now);
  let eventsAvailable = true;
  try { await scanEvents(join(root, 'dispatch-events.log'), tally); }
  catch { eventsAvailable = false; }
  return { jobs: waitingJobs(queue, tally.first, tally.launched, now), eventsAvailable };
}
