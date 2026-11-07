#!/usr/bin/env -S npx tsx
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import { readFleetQueue, type FleetQueueV1 } from '../../src/core/fleet/runs-parked-queue.js';
import { readLeaderJournal, type LeaderJournalV1 } from '../../src/core/fleet/leader-journal.js';
import { redactHomePaths, scrubPrivateText } from '../../src/core/util/scrub.js';

type Health = 'healthy' | 'missing' | 'degraded';
type Event = { source: 'precheck' | 'ingest'; at: string | null; code: string; reason: string | null };
export interface TraceDependencies {
  readQueue?: typeof readFleetQueue;
  readJournal?: typeof readLeaderJournal;
  now?: () => number;
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  write?: (text: string) => void;
  signal?: AbortSignal;
}

const JOB = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;
const clean = (value: string) => redactHomePaths(scrubPrivateText(value)).replace(/\p{Cc}/gu, ' ').slice(0, 400);
const validTime = (value: string) => Number.isFinite(Date.parse(value));

function parse(args: readonly string[]): { job: string; limit: number; waitMs: number } | null {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]; const value = args[i + 1];
    if (!key || !['--job', '--limit', '--wait-ms'].includes(key) || value === undefined || values.has(key)) return null;
    values.set(key, value);
  }
  const job = values.get('--job') ?? '';
  const limitText = values.get('--limit') ?? '50';
  const waitText = values.get('--wait-ms') ?? '0';
  if (!JOB.test(job) || !/^[0-9]{1,3}$/.test(limitText) || !/^[0-9]{1,5}$/.test(waitText)) return null;
  const limit = Number(limitText); const waitMs = Number(waitText);
  return limit >= 1 && limit <= 100 && waitMs <= 30000 ? { job, limit, waitMs } : null;
}

function matches(value: string, job: string): boolean {
  const base = value.split(/[/\\]/).at(-1);
  return base === job || base === `${job}.md`;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveWait, reject) => {
    if (signal?.aborted) { reject(new Error('aborted')); return; }
    const onAbort = () => { clearTimeout(timer); reject(new Error('aborted')); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolveWait(); }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/** Compose the existing bounded projections; no source files are modified. */
export async function runQueueRejectionTrace(args: readonly string[], deps: TraceDependencies = {}): Promise<number> {
  const emit = (value: unknown) => (deps.write ?? ((text: string) => process.stdout.write(text)))(`${JSON.stringify(value)}\n`);
  const options = parse(args);
  if (!options) { emit({ error: 'usage: --job ID [--limit 1..100] [--wait-ms 0..30000]' }); return 2; }
  const now = deps.now ?? Date.now;
  try {
    const started = now();
    if (!Number.isFinite(started) || Math.abs(started) > 8.64e15) throw new Error('invalid clock');
    let remaining = options.waitMs;
    while (true) {
      if (deps.signal?.aborted) { emit({ error: 'interrupted' }); return 130; }
      const [queueResult, journalResult] = await Promise.allSettled([
        (deps.readQueue ?? readFleetQueue)({ now, limit: 200 }),
        (deps.readJournal ?? readLeaderJournal)({ now }),
      ]);
      if (deps.signal?.aborted) { emit({ error: 'interrupted' }); return 130; }
      const queue: FleetQueueV1 | undefined = queueResult.status === 'fulfilled' ? queueResult.value : undefined;
      const journal: LeaderJournalV1 | undefined = journalResult.status === 'fulfilled' ? journalResult.value : undefined;
      const sources: Record<'precheck' | 'ingest', Health> = {
        precheck: queue?.sources.skips ?? 'degraded', ingest: journal?.sources.ingestLog ?? 'degraded',
      };
      const precheck: Event[] = (queue?.skips ?? []).filter(row => row.job === options.job).map(row => ({
        source: 'precheck', at: validTime(row.at) ? clean(row.at) : null, code: clean(row.code), reason: clean(row.reason),
      }));
      const ingest: Event[] = (journal?.ingest ?? []).filter(row => row.verb.toLowerCase() === 'reject' && matches(row.file, options.job)).map(row => ({
        source: 'ingest', at: null, code: 'reject', reason: row.reason === null ? null : clean(row.reason),
      }));
      if (precheck.length || ingest.length || remaining <= 0 || Object.values(sources).some(state => state !== 'healthy')) {
        // The readers return newest first within each source. Untimed ingest rows
        // follow timed skips because their relative chronology is unknown.
        const ordered = [...precheck.filter(row => row.at !== null), ...precheck.filter(row => row.at === null), ...ingest];
        const current = now();
        if (!Number.isFinite(current) || Math.abs(current) > 8.64e15) throw new Error('invalid clock');
        emit({ v: 1, generatedAt: new Date(current).toISOString(), job: clean(options.job), sources,
          latest: { precheck: precheck[0] ?? null, ingest: ingest[0] ?? null },
          timeline: ordered.slice(0, options.limit), truncated: ordered.length > options.limit });
        return Object.values(sources).every(state => state === 'healthy') ? 0 : 1;
      }
      const current = now();
      if (!Number.isFinite(current)) throw new Error('invalid clock');
      remaining = Math.min(remaining, Math.max(0, options.waitMs - Math.max(0, current - started)));
      if (remaining <= 0) continue;
      const interval = Math.min(1000, remaining);
      await (deps.wait ?? delay)(interval, deps.signal);
      remaining -= interval;
    }
  } catch {
    if (deps.signal?.aborted) { emit({ error: 'interrupted' }); return 130; }
    emit({ error: 'queue rejection trace unavailable' }); return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController();
  const interrupt = () => controller.abort();
  process.once('SIGINT', interrupt); process.once('SIGTERM', interrupt);
  try { process.exitCode = await runQueueRejectionTrace(process.argv.slice(2), { signal: controller.signal }); }
  finally { process.removeListener('SIGINT', interrupt); process.removeListener('SIGTERM', interrupt); }
}
