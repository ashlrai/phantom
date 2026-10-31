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
  let fleet: PushFleetSnapshot | null = null;
  let cursor: string | null = null;
  let initialized = false;
  let polling = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const known = new Map<NeedsYouSource, Set<string>>();
  const healthy = new Set<NeedsYouSource>();

  async function pollActivity(): Promise<boolean> {
    try {
      const result = await options.read(cursor);
      if (!validActivity(result)) return false;
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
      if (newNeed) await options.send('needs-you').catch(() => undefined);
      if (newCompletion) await options.send('completed').catch(() => undefined);
      return true;
    } catch { return false; }
  }

  async function pollFleet(): Promise<void> {
    if (!options.readFleet) return;
    try {
      const current = await options.readFleet();
      if (!validPushFleet(current)) return;
      const intents = diffFleetForPush(fleet, current);
      fleet = current;
      for (const { kind, ...detail } of intents) await options.send(kind, detail).catch(() => undefined);
    } catch { /* Preserve the last successful baseline. */ }
  }

  async function pollOnce(): Promise<boolean> {
    if (polling) return false;
    polling = true;
    try {
      const [activity] = await Promise.all([pollActivity(), pollFleet()]);
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
    stop(): void { if (timer) clearInterval(timer); timer = null; },
  };
}
