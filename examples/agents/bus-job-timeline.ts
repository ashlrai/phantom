#!/usr/bin/env -S npx tsx
/* global process, AbortController, AbortSignal, setTimeout, clearTimeout */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { listBusInboxAfter, type BusInboxReceipt } from '../../src/core/fleet/bus-inbox.js';
import { getFleetJobDetail, isFleetJobId } from '../../src/core/fleet/runs-job-detail.js';

const PAGE_SIZE = 50;
const MAX_PAGES = 10;

export interface TimelineDependencies {
  readBus?: typeof listBusInboxAfter;
  readJob?: typeof getFleetJobDetail;
  now?: () => number;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  write?: (text: string) => void;
}

function waitForPoll(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolveWait => {
    if (signal.aborted) { resolveWait(); return; }
    const done = (): void => { clearTimeout(timer); signal.removeEventListener('abort', done); resolveWait(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

/** Compose existing read-only projections; message bodies remain untrusted data. */
export async function runBusJobTimeline(args: readonly string[], deps: TimelineDependencies = {}): Promise<number> {
  const emit = (value: unknown): void => (deps.write ?? (text => process.stdout.write(text)))(`${JSON.stringify(value)}\n`);
  const invalid = (): number => { emit({ error: 'usage: --job ID [--after CURSOR] [--pages 1-10] [--wait-ms 0-60000]' }); return 2; };
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!key || !['--job', '--after', '--pages', '--wait-ms'].includes(key) || value === undefined || values.has(key)) return invalid();
    values.set(key, value);
  }
  const job = values.get('--job') ?? '';
  const afterText = values.get('--after') ?? '0', pagesText = values.get('--pages') ?? '1', waitText = values.get('--wait-ms') ?? '0';
  if (!isFleetJobId(job) || ![afterText, pagesText, waitText].every(value => /^(0|[1-9][0-9]*)$/.test(value) && Number.isSafeInteger(Number(value)))) return invalid();
  const after = Number(afterText), maxPages = Number(pagesText), waitMs = Number(waitText);
  if (maxPages < 1 || maxPages > MAX_PAGES || waitMs > 60000) return invalid();

  const now = deps.now ?? Date.now;
  let detail: Awaited<ReturnType<typeof getFleetJobDetail>> | null = null;
  try { detail = await (deps.readJob ?? getFleetJobDetail)(job, { now: () => new Date(now()) }); } catch { /* preserve bus evidence */ }

  const messages: BusInboxReceipt[] = [];
  let nextCursor = after, pagesRead = 0;
  let busStatus: 'ok' | 'invalid' | 'unavailable' | 'retryable' | 'full' | 'conflict' = 'ok';
  let stopReason: 'caught-up' | 'page-limit' | 'interrupted' | 'bus-error' = 'caught-up';
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  if (waitMs > 0) {
    deps.signal?.addEventListener('abort', stop, { once: true });
    process.on('SIGINT', stop); process.on('SIGTERM', stop);
    if (deps.signal?.aborted) stop();
  }
  try {
    while (pagesRead < maxPages) {
      if (controller.signal.aborted) { stopReason = 'interrupted'; break; }
      let page: ReturnType<typeof listBusInboxAfter>;
      try { page = (deps.readBus ?? listBusInboxAfter)(nextCursor, PAGE_SIZE, { now }); }
      catch { busStatus = 'unavailable'; stopReason = 'bus-error'; break; }
      if (page.status !== 'ok') { busStatus = page.status; stopReason = 'bus-error'; break; }
      pagesRead++;
      nextCursor = page.nextCursor;
      messages.push(...page.messages.filter(({ envelope }) => {
        const body = envelope.body;
        return body !== null && typeof body === 'object' && !Array.isArray(body) &&
          Object.hasOwn(body, 'jobId') && body.jobId === job;
      }));
      const caughtUp = page.messages.length < PAGE_SIZE;
      if (caughtUp && waitMs === 0) { stopReason = 'caught-up'; break; }
      if (pagesRead === maxPages) { stopReason = caughtUp && waitMs === 0 ? 'caught-up' : 'page-limit'; break; }
      if (caughtUp) await (deps.wait ?? waitForPoll)(waitMs, controller.signal);
    }
  } catch {
    busStatus = 'unavailable'; stopReason = 'bus-error';
  } finally {
    if (waitMs > 0) {
      deps.signal?.removeEventListener('abort', stop);
      process.off('SIGINT', stop); process.off('SIGTERM', stop);
    }
  }
  emit({ job, detail, bus: { status: busStatus, messages, after, nextCursor, pagesRead, pageLimitReached: stopReason === 'page-limit', stopReason } });
  if (stopReason === 'interrupted') return 130;
  if (busStatus === 'invalid') return 2;
  if (busStatus !== 'ok' || !detail) return 1;
  const sources = Object.values(detail.sources);
  if (sources.includes('degraded')) return 4;
  if (sources.every(source => source === 'missing') && detail.promptBytes === null && !detail.notes.hasNotes && !detail.notes.hasBody) return 3;
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await runBusJobTimeline(process.argv.slice(2));
}
