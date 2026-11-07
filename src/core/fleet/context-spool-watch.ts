/**
 * Bounded retry watch over the context-reply spool. Preview performs exactly
 * one drain preview batch and exits without writing. Apply repeats
 * drainContextReplySpool batches inside one monotonic duration: the drain's
 * `nextRecord` cursor chains the batches of a sweep, the cursor resets only
 * after a complete sweep (nextRecord null), and the interval separates sweeps
 * so an empty spool keeps being watched — an empty pass is not proof that no
 * reply will arrive before the bound. A scan overflow whose cursor cannot
 * advance ends the pass early and waits the interval instead of busy-looping.
 * Retained records stay for later sweeps; nothing is deleted, spawned,
 * scheduled or republished outside the existing per-record delivery path.
 * The summary reports counts only — never envelope bodies, raw reply ids or
 * filesystem paths — and unresolved records are never reported as delivered.
 */
import { performance } from 'node:perf_hooks';
import { isAbsolute } from 'node:path';
import type { BusInboxOptions } from './bus-inbox.js';
import { drainContextReplySpool, DRAIN_MAX_LIMIT } from './context-spool-drain.js';
import type { ContextDeliveryStatus } from './context-reply-spool.js';

export const WATCH_MAX_DURATION_MS = 3_600_000;
export const WATCH_MIN_INTERVAL_MS = 100;
export const WATCH_MAX_INTERVAL_MS = 60_000;
/** Same per-batch bound the drain accepts. */
export const WATCH_MAX_LIMIT = DRAIN_MAX_LIMIT;

export interface ContextSpoolWatchOptions {
  spoolDir: string;
  /** Bounded lifetime, mandatory: 1..3600000 milliseconds on a monotonic clock. */
  durationMs: number;
  /** Delay between sweeps: 100..60000 milliseconds. */
  intervalMs: number;
  /** Per-batch selection bound (defaults to the drain maximum). */
  limit?: number;
  /** Apply republishes each selected record through the spool delivery path. */
  apply?: boolean;
}

export interface ContextSpoolWatchDeps {
  signal?: AbortSignal;
  /** Monotonic millisecond clock for the deadline (defaults to performance.now). */
  clock?: () => number;
  /** Abortable wait between sweeps (defaults to a timer resolving on abort). */
  delay?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** 'duration-expired' is normal bounded completion, reported distinctly from
 * any records still unresolved; 'cancelled' means the signal interrupted the
 * watch; 'invalid'/'unsafe' mirror the drain's own storage refusals. */
export type ContextSpoolWatchReason =
  'preview-complete' | 'duration-expired' | 'cancelled' | 'unsafe' | 'invalid';

export interface ContextSpoolWatchSummary {
  status: 'ok' | 'invalid' | 'unsafe' | 'cancelled';
  mode: 'preview' | 'apply';
  /** Bounded passes over the spool; a stalled or interrupted pass still counts. */
  sweeps: number;
  /** Drain batches run across all sweeps. */
  batches: number;
  /** Records handed to the delivery path (apply mode). */
  attempts: number;
  /** Records accepted by the bus: posted or duplicate. Never counts anything else. */
  delivered: number;
  /** Apply mode: delivery status counts merged across all batches. */
  counts: Partial<Record<ContextDeliveryStatus, number>>;
  /** Records still on disk after the last covered sweep (preview: all matched
   * records). A lower bound when the final sweep could not cover the spool —
   * unresolved is never folded into delivered. */
  unresolved: number;
  /** False when the last pass ended without a complete sweep (cursor stall or
   * a mid-sweep stop), so `unresolved` may understate what remains. */
  lastSweepComplete: boolean;
  reason: ContextSpoolWatchReason;
  /** 0 bounded completion, 1 incomplete/unresolved/cancelled, 2 invalid or refused. */
  exitCode: number;
}

/** Abortable interval wait; resolves early on abort like bus-follow-stream. */
function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal?.aborted || ms <= 0) { resolve(); return; }
    const done = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal?.addEventListener('abort', done, { once: true });
  });
}

export function validContextSpoolWatchOptions(opts: ContextSpoolWatchOptions): boolean {
  return isAbsolute(opts.spoolDir) && !opts.spoolDir.includes('\0') &&
    Number.isSafeInteger(opts.durationMs) && opts.durationMs >= 1 && opts.durationMs <= WATCH_MAX_DURATION_MS &&
    Number.isSafeInteger(opts.intervalMs) && opts.intervalMs >= WATCH_MIN_INTERVAL_MS && opts.intervalMs <= WATCH_MAX_INTERVAL_MS &&
    (opts.limit === undefined || (Number.isSafeInteger(opts.limit) && opts.limit >= 1 && opts.limit <= WATCH_MAX_LIMIT));
}

export async function watchContextReplySpool(
  opts: ContextSpoolWatchOptions,
  bus: BusInboxOptions = {},
  deps: ContextSpoolWatchDeps = {},
): Promise<ContextSpoolWatchSummary> {
  const mode = opts.apply ? 'apply' : 'preview';
  const counts: Partial<Record<ContextDeliveryStatus, number>> = {};
  const summary = (status: ContextSpoolWatchSummary['status'], reason: ContextSpoolWatchReason,
    fields: Partial<ContextSpoolWatchSummary> = {}): ContextSpoolWatchSummary => ({
    status, mode, sweeps: 0, batches: 0, attempts: 0, delivered: 0, counts,
    unresolved: 0, lastSweepComplete: true, reason,
    exitCode: status === 'ok' ? 0 : status === 'cancelled' ? 1 : 2,
    ...fields,
  });
  if (!validContextSpoolWatchOptions(opts)) return summary('invalid', 'invalid');
  const limit = opts.limit ?? WATCH_MAX_LIMIT;

  if (!opts.apply) {
    const report = drainContextReplySpool({ spoolDir: opts.spoolDir, limit }, bus);
    if (report.status !== 'ok') return summary(report.status, report.status);
    return summary('ok', 'preview-complete', { sweeps: 1, batches: 1, unresolved: report.matched });
  }

  const clock = deps.clock ?? (() => performance.now());
  const delay = deps.delay ?? wait;
  const deadline = clock() + opts.durationMs;
  const aborted = (): boolean => deps.signal?.aborted === true;
  // The cursor is session state: it advances within a sweep and resets only
  // after a complete sweep, so a pass that stopped early resumes where it had
  // certainly covered instead of restarting records it already attempted.
  let cursor: string | undefined;
  let sweeps = 0, batches = 0, attempts = 0, delivered = 0;
  let retained = new Set<string>();
  let lastSweepComplete = true;
  const finish = (reason: 'duration-expired' | 'cancelled'): ContextSpoolWatchSummary => {
    const unresolved = retained.size;
    return summary(reason === 'cancelled' ? 'cancelled' : 'ok', reason,
      { sweeps, batches, attempts, delivered, unresolved, lastSweepComplete,
        exitCode: reason === 'cancelled' ? 1 : unresolved > 0 || !lastSweepComplete ? 1 : 0 });
  };
  for (;;) {
    if (aborted()) return finish('cancelled');
    if (clock() >= deadline) return finish('duration-expired');
    sweeps += 1;
    retained = new Set<string>();
    let sweepComplete = false;
    for (;;) {
      const report = drainContextReplySpool({
        spoolDir: opts.spoolDir, apply: true, limit,
        ...(cursor === undefined ? {} : { afterRecord: cursor }),
      }, bus);
      batches += 1;
      if (report.status !== 'ok') {
        return summary(report.status, report.status, { sweeps, batches, attempts, delivered, unresolved: retained.size, lastSweepComplete: false });
      }
      attempts += report.selected;
      for (const name of report.retained) retained.add(name);
      for (const [status, count] of Object.entries(report.counts)) {
        counts[status as ContextDeliveryStatus] = (counts[status as ContextDeliveryStatus] ?? 0) + count;
        if (status === 'posted' || status === 'duplicate') delivered += count;
      }
      if (report.nextRecord === null) { sweepComplete = true; cursor = undefined; break; }
      // Overflow leaves the cursor at its incoming value: end this pass and
      // retry after the interval rather than rescanning in a tight loop.
      if (report.nextRecord === cursor) break;
      cursor = report.nextRecord;
      lastSweepComplete = false;
      if (aborted()) return finish('cancelled');
      if (clock() >= deadline) return finish('duration-expired');
    }
    lastSweepComplete = sweepComplete;
    const remaining = deadline - clock();
    if (remaining <= 0) return finish('duration-expired');
    await delay(Math.min(opts.intervalMs, remaining), deps.signal);
  }
}
