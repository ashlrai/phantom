import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readEmailOutbox, type EmailOutboxListing, type EmailOutboxStuckReason } from './email-outbox.js';

export interface BatchRow {
  name: string;
  state: 'missing' | 'queued' | 'drafted' | 'sent' | 'stuck';
  reason?: EmailOutboxStuckReason;
}
export interface BatchResult {
  rows: BatchRow[];
  timedOut: boolean;
  cancelled: boolean;
  sourceFailure: boolean;
}
export interface BatchOptions {
  dir: string;
  names: string[];
  timeoutMs: number;
  pollMs: number;
  signal: AbortSignal;
  now?: () => number;
  read?: (dir: string) => EmailOutboxListing;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

function readSource(dir: string): EmailOutboxListing {
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

export async function awaitEmailOutboxBatch(options: BatchOptions): Promise<BatchResult> {
  const now = options.now ?? Date.now;
  const deadline = now() + options.timeoutMs;
  let rows: BatchRow[] = options.names.map((name) => ({ name, state: 'missing' }));
  const result = (extra: Partial<BatchResult> = {}): BatchResult => ({ rows, timedOut: false, cancelled: false, sourceFailure: false, ...extra });
  while (true) {
    if (options.signal.aborted) return result({ cancelled: true });
    try {
      const entries = (options.read ?? readSource)(options.dir).entries;
      rows = rows.map((row) => {
        const matches = entries.filter((entry) => entry.name === row.name);
        const stuck = matches.find((entry) => entry.state === 'stuck');
        if (stuck) return { name: row.name, state: 'stuck', reason: stuck.reason };
        if (matches.length > 1) return { name: row.name, state: 'stuck', reason: 'malformed' };
        const entry = matches[0];
        return entry ? { name: row.name, state: entry.state, reason: entry.reason } : { name: row.name, state: 'missing' };
      });
    } catch {
      rows = options.names.map((name) => ({ name, state: 'missing' }));
      return result({ sourceFailure: true });
    }
    if (rows.every((row) => row.state === 'sent' || row.state === 'drafted' || row.state === 'stuck')) return result();
    const remaining = deadline - now();
    if (remaining <= 0) return result({ timedOut: true });
    await (options.sleep ?? sleep)(Math.min(options.pollMs, remaining), options.signal);
  }
}
