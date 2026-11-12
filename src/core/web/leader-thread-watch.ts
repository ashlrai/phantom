/**
 * leader-thread-watch.ts — "the Leader thread changed on disk", for the SSE
 * stream. The thread is written by OTHER processes (the leader tick, the
 * Telegram and iMessage transports), so only the file system can say so.
 *
 * One fs.watch per process on the thread's DIRECTORY (an atomic rotation
 * replaces the file, which a watch on the file itself would lose), reference
 * counted across subscribers and closed with the last one. Events are
 * filtered to thread.jsonl and its rotated sibling and debounced. When
 * fs.watch is unavailable (missing directory, unsupported platform, a later
 * watcher error) a 2 s stat poll of the same files stands in. Nothing here
 * throws to the caller.
 */
import { statSync, watch as fsWatch } from 'node:fs';
import type { FSWatcher } from 'node:fs';
import { basename, dirname, join } from 'node:path';

import { leaderThreadPath } from '../vision/leader-thread.js';

export const LEADER_THREAD_DEBOUNCE_MS = 250;
export const LEADER_THREAD_POLL_MS = 2_000;

export interface WatchLeaderThreadOptions {
  /** The thread file; defaults to leaderThreadPath(). */
  path?: string;
  debounceMs?: number;
  /** fs.watch, injectable for tests. */
  watch?: typeof fsWatch;
}

interface SharedWatch {
  subscribers: Set<() => void>;
  close: () => void;
}

const shared = new Map<string, SharedWatch>();

/** thread.jsonl → thread.jsonl and thread.1.jsonl (the rotated archive). */
function threadNames(path: string): string[] {
  const name = basename(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? [name, `${name.slice(0, dot)}.1${name.slice(dot)}`] : [name, `${name}.1`];
}

function startShared(path: string, debounceMs: number, watch: typeof fsWatch): SharedWatch {
  const subscribers = new Set<() => void>();
  const dir = dirname(path);
  const names = new Set(threadNames(path));
  let watcher: FSWatcher | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let poll: ReturnType<typeof setInterval> | null = null;

  const fire = (): void => {
    for (const fn of [...subscribers]) {
      try { fn(); } catch { /* one bad subscriber must not starve the rest */ }
    }
  };
  const schedule = (): void => {
    if (timer) return;
    timer = setTimeout(() => { timer = null; fire(); }, debounceMs);
  };

  const signature = (): string => [...names].map((n) => {
    try {
      const st = statSync(join(dir, n));
      return `${st.mtimeMs}:${st.size}`;
    } catch { return '-'; }
  }).join('|');

  const startPoll = (): void => {
    if (poll) return;
    let last = signature();
    poll = setInterval(() => {
      const next = signature();
      if (next === last) return;
      last = next;
      schedule();
    }, LEADER_THREAD_POLL_MS);
    poll.unref?.();
  };

  try {
    watcher = watch(dir, { persistent: false }, (_event, filename) => {
      // A null filename (some platforms) cannot be ruled out: treat it as a change.
      if (filename == null || names.has(String(filename))) schedule();
    });
    watcher.on('error', () => {
      try { watcher?.close(); } catch { /* already closed */ }
      watcher = null;
      startPoll();
    });
  } catch {
    watcher = null;
    startPoll();
  }

  return {
    subscribers,
    close: () => {
      if (timer) clearTimeout(timer);
      if (poll) clearInterval(poll);
      timer = null;
      poll = null;
      try { watcher?.close(); } catch { /* already closed */ }
      watcher = null;
    },
  };
}

/** Call `onChange` (debounced) whenever the Leader thread file changes. Returns an unsubscribe. */
export function watchLeaderThread(onChange: () => void, opts: WatchLeaderThreadOptions = {}): () => void {
  let path: string;
  try { path = opts.path ?? leaderThreadPath(); } catch { return () => {}; }
  let entry = shared.get(path);
  if (!entry) {
    entry = startShared(path, opts.debounceMs ?? LEADER_THREAD_DEBOUNCE_MS, opts.watch ?? fsWatch);
    shared.set(path, entry);
  }
  const active = entry;
  const subscriber = (): void => onChange();
  active.subscribers.add(subscriber);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    active.subscribers.delete(subscriber);
    if (active.subscribers.size === 0) {
      active.close();
      if (shared.get(path) === active) shared.delete(path);
    }
  };
}
