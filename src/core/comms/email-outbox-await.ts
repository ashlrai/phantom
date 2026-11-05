import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readEmailOutbox, type EmailOutboxListing, type EmailOutboxStuckReason } from './email-outbox.js';

export interface AwaitResult {
  name: string;
  state?: 'queued' | 'drafted' | 'sent' | 'stuck';
  reason?: EmailOutboxStuckReason | 'source-failure';
  timedOut: boolean;
  cancelled: boolean;
}

export interface AwaitOptions {
  dir: string;
  name: string;
  timeoutMs: number;
  pollMs: number;
  signal: AbortSignal;
  now?: () => number;
  read?: (dir: string) => EmailOutboxListing;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

function readSource(dir: string): EmailOutboxListing {
  // readEmailOutbox intentionally hides directory read errors. Check each
  // directory first so an inaccessible source cannot look like an empty one.
  readdirSync(dir);
  for (const sub of ['sending', 'sent', 'drafted']) {
    try { readdirSync(join(dir, sub)); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return readEmailOutbox(dir);
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) { resolve(); return; }
    const done = (): void => { clearTimeout(timer); signal.removeEventListener('abort', done); resolve(); };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

export async function awaitEmailOutbox(options: AwaitOptions): Promise<AwaitResult> {
  const { name, signal } = options;
  const now = options.now ?? Date.now;
  const deadline = now() + options.timeoutMs;
  const result = (extra: Partial<AwaitResult>): AwaitResult => ({ name, timedOut: false, cancelled: false, ...extra });
  let state: AwaitResult['state'];
  while (true) {
    if (signal.aborted) return result({ state, cancelled: true });
    try {
      const entries = (options.read ?? readSource)(options.dir).entries.filter((entry) => entry.name === name);
      // Ambiguous duplicate artifacts must never be reported as delivered.
      const entry = entries.find((item) => item.state === 'stuck') ??
        (entries.length === 1 ? entries[0] : undefined);
      if (entries.length > 1 && !entry) return result({ state: 'stuck', reason: 'malformed' });
      state = entry?.state;
      if (entry && entry.state !== 'queued') return result({ state, reason: entry.reason });
    } catch {
      return result({ state, reason: 'source-failure' });
    }
    const remaining = deadline - now();
    if (remaining <= 0) return result({ state, timedOut: true });
    await (options.sleep ?? sleep)(Math.min(options.pollMs, remaining), signal);
  }
}
