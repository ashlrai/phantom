/**
 * Watches the local Verse activity feed for new operator work and completed
 * turns. The first successful read is a baseline, never a notification. Push
 * activity delivery remains content-free; fleet summaries are bounded and scrubbed.
 */
import { NEEDS_YOU_SOURCES, type NeedsYouSource, type VerseActivityResponse } from '../verse/workbench-types.js';
import { diffFleetForPush, validPushFleet, type PushFleetSnapshot } from './remote-push-fleet.js';
import type { RemotePushDetail, RemotePushKind } from './remote-push.js';

type Activity = Pick<VerseActivityResponse, 'cursor' | 'needsYou' | 'completions' | 'sources'>;
export interface RemotePushWatcherOptions {
  read: (since: string | null) => Promise<unknown>;
  readFleet?: () => Promise<unknown>;
  send: (kind: RemotePushKind, detail?: RemotePushDetail) => Promise<unknown>;
  intervalMs?: number;
  /** Deadline for each callback, in milliseconds. Defaults to 10 seconds. */
  timeoutMs?: number;
}

function validActivity(value: unknown): value is Activity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (typeof row.cursor !== 'string' || row.cursor.length < 1 || row.cursor.length > 256
    || !Array.isArray(row.needsYou) || !Array.isArray(row.completions)
    || !row.sources || typeof row.sources !== 'object' || Array.isArray(row.sources)) return false;
  const sources = row.sources as Record<string, unknown>;
  if (!NEEDS_YOU_SOURCES.every((source) => ['ok', 'error', 'unavailable'].includes(String(sources[source])))) return false;
  if (row.needsYou.length > 1_000 || row.completions.length > 1_000) return false;
  return row.needsYou.every((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const entry = item as Record<string, unknown>;
    return typeof entry.id === 'string' && entry.id.length > 0 && entry.id.length <= 512
      && NEEDS_YOU_SOURCES.includes(entry.source as NeedsYouSource);
  }) && row.completions.every((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const entry = item as Record<string, unknown>;
    return typeof entry.sessionId === 'string' && entry.sessionId.length > 0
      && typeof entry.at === 'string' && Number.isFinite(Date.parse(entry.at))
      && ['ok', 'failed', 'cancelled'].includes(String(entry.outcome));
  });
}

export function createRemotePushWatcher(options: RemotePushWatcherOptions) {
  const intervalMs = options.intervalMs ?? 15_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 5_000 || intervalMs > 300_000) {
    throw new Error('Invalid remote push poll interval');
  }
  const timeoutMs = options.timeoutMs ?? 10_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) {
    throw new Error('Invalid remote push operation timeout');
  }
  let fleet: PushFleetSnapshot | null = null;
  let cursor: string | null = null;
  let initialized = false;
  let polling = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const known = new Map<NeedsYouSource, Set<string>>();
  const healthy = new Set<NeedsYouSource>();
  const deadlines = new Set<() => void>();
  let generation = 0;

  // A deadline cannot cancel the callback. Keep its slot occupied until it
  // settles, so a permanently hung dependency cannot accumulate more calls.
  // Results arriving after the deadline (or stop) are discarded.
  function bounded<Args extends unknown[]>(callback: (...args: Args) => Promise<unknown>) {
    let pending = false;
    return (...args: Args): Promise<unknown> => {
      if (pending) return Promise.resolve(undefined);
      pending = true;
      return new Promise((resolve) => {
        let done = false;
        const finish = (value?: unknown) => {
          if (done) return;
          done = true;
          clearTimeout(deadline);
          deadlines.delete(cancel);
          resolve(value);
        };
        const cancel = () => finish();
        const deadline = setTimeout(cancel, timeoutMs);
        deadline.unref?.();
        deadlines.add(cancel);
        try {
          Promise.resolve(callback(...args)).then(
            (value) => { pending = false; finish(value); },
            () => { pending = false; finish(); },
          );
        } catch { pending = false; finish(); }
      });
    };
  }

  const read = bounded(options.read);
  const readFleet = options.readFleet ? bounded(options.readFleet) : null;
  const send = bounded(options.send);
  let sendTail: Promise<unknown> = Promise.resolve();
  function sendBestEffort(requested: number, kind: RemotePushKind, detail?: RemotePushDetail): Promise<unknown> {
    const next = sendTail.then(() => {
      if (requested !== generation) return undefined;
      return detail === undefined ? send(kind) : send(kind, detail);
    });
    sendTail = next;
    return next;
  }

  async function pollActivity(requested: number): Promise<boolean> {
    try {
      const result = await read(cursor);
      if (requested !== generation || !validActivity(result)) return false;
      let newNeed = false;
      for (const source of NEEDS_YOU_SOURCES) {
        if (result.sources[source] !== 'ok') { healthy.delete(source); continue; }
        const next = new Set(result.needsYou.filter((item) => item.source === source).map((item) => item.id));
        if (initialized && healthy.has(source)) {
          for (const id of next) if (!known.get(source)?.has(id)) { newNeed = true; break; }
        }
        known.set(source, next);
        healthy.add(source);
      }
      const newCompletion = initialized && result.sources.chats === 'ok' && result.completions.length > 0;
      // Advance before the network calls: a failed push must not replay old work.
      cursor = result.cursor;
      initialized = true;
      if (newNeed) await sendBestEffort(requested, 'needs-you');
      if (newCompletion) await sendBestEffort(requested, 'completed');
      return true;
    } catch { return false; }
  }

  async function pollFleet(requested: number): Promise<void> {
    if (!readFleet) return;
    try {
      const current = await readFleet();
      if (requested !== generation || !validPushFleet(current)) return;
      const intents = diffFleetForPush(fleet, current);
      fleet = current;
      for (const { kind, ...detail } of intents) await sendBestEffort(requested, kind, detail);
    } catch { /* Preserve the last successful baseline. */ }
  }

  async function pollOnce(): Promise<boolean> {
    if (polling) return false;
    polling = true;
    try {
      const [activity] = await Promise.all([pollActivity(generation), pollFleet(generation)]);
      return activity;
    } finally { polling = false; }
  }

  return {
    pollOnce,
    start(): void {
      if (timer) return;
      void pollOnce();
      timer = setInterval(() => { void pollOnce(); }, intervalMs);
      timer.unref?.();
    },
    stop(): void {
      if (timer) clearInterval(timer);
      timer = null;
      generation++;
      for (const cancel of deadlines) cancel();
    },
  };
}
