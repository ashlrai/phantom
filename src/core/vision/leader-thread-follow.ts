import type { LeaderThreadMessage } from './leader-thread-types.js';

/** Follow the oldest-first thread without owning its storage or output. */
export async function followThread(opts: {
  list: (o: { limit: number }) => LeaderThreadMessage[];
  backlog?: number;
  sinceId?: string;
  intervalMs?: number;
  signal: AbortSignal;
  onMessage: (m: LeaderThreadMessage) => void;
  onError?: (e: unknown) => void;
  sleep?: (ms: number) => Promise<void>;
}): Promise<void> {
  const seen = new Set<string>();
  const errors = new Set<string>();
  let initial = true;
  let awaitingSince = opts.sinceId !== undefined;
  while (!opts.signal.aborted) {
    let messages: LeaderThreadMessage[] | undefined;
    try {
      messages = opts.list({ limit: 200 });
    } catch (error) {
      const key = error instanceof Error ? error.message : String(error);
      if (!errors.has(key)) {
        errors.add(key);
        opts.onError?.(error);
      }
    }
    if (messages) {
      let start = 0;
      if (awaitingSince) {
        const index = messages.findIndex(m => m.id === opts.sinceId);
        if (index < 0) start = messages.length;
        else { start = index + 1; awaitingSince = false; }
      } else if (initial) {
        start = Math.max(0, messages.length - Math.max(0, Math.floor(opts.backlog ?? 10)));
      }
      for (const [index, message] of messages.entries()) {
        if (awaitingSince) break;
        const isNew = !seen.has(message.id);
        if (isNew) {
          seen.add(message.id);
          if (seen.size > 2000) seen.delete(seen.values().next().value!);
          if (index >= start && !opts.signal.aborted) opts.onMessage(message);
        }
      }
      if (!awaitingSince) initial = false;
    }
    if (opts.signal.aborted) break;
    await new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const aborted = () => { if (timer) clearTimeout(timer); cleanup(); resolve(); };
      const cleanup = () => opts.signal.removeEventListener('abort', aborted);
      opts.signal.addEventListener('abort', aborted, { once: true });
      if (opts.signal.aborted) { aborted(); return; }
      if (opts.sleep) {
        opts.sleep(opts.intervalMs ?? 2000).then(() => { cleanup(); resolve(); }, error => { cleanup(); reject(error); });
      } else {
        timer = setTimeout(() => { cleanup(); resolve(); }, opts.intervalMs ?? 2000);
      }
    });
  }
}
