#!/usr/bin/env -S npx tsx
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { INBOX_MAX_CHARS, readInboxEntries, type InboxEntry } from '../../src/core/fleet/mason-inbox.js';
import { scrubSecrets } from '../../src/core/util/scrub.js';

const LIMIT = 20;
const POLL_MS = 250;
const MAX_TIMEOUT_MS = 300_000;
const USAGE = 'Use --once or --after-fingerprint <64 lowercase hex> --timeout-ms <1-300000>.';

export interface WaitInterjectionDependencies {
  read?: typeof readInboxEntries;
  now?: () => number;
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  write?: (text: string) => void;
  signal?: AbortSignal;
}

/** SHA-256 of a JSON array of fields, or JSON null for an empty healthy inbox. */
export function inboxFingerprint(entry: InboxEntry | undefined): string {
  const fields = entry ? [entry.at, entry.source || 'unknown', entry.priority, entry.text] : null;
  return createHash('sha256').update(JSON.stringify(fields), 'utf8').digest('hex');
}

function displayEntry(entry: InboxEntry): InboxEntry {
  const clean = (text: string, max: number): string => scrubSecrets(text).slice(0, max);
  return {
    at: clean(entry.at, 256),
    source: clean(entry.source || 'unknown', 256),
    priority: entry.priority === null ? null : clean(entry.priority, 256),
    text: clean(entry.text, INBOX_MAX_CHARS),
  };
}

/** Observe the bounded inbox without writing a checkpoint or acknowledgement. */
export async function runWaitInterjection(args: readonly string[], deps: WaitInterjectionDependencies = {}): Promise<number> {
  const write = deps.write ?? ((text: string) => process.stdout.write(text));
  const emit = (value: unknown): void => write(`${JSON.stringify(value)}\n`);
  const once = args.length === 1 && args[0] === '--once';
  const values = new Map<string, string>();
  if (!once) {
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i], value = args[i + 1];
      if (!key || !['--after-fingerprint', '--timeout-ms'].includes(key) || value === undefined || values.has(key)) {
        emit({ error: USAGE }); return 2;
      }
      values.set(key, value);
    }
    const hash = values.get('--after-fingerprint') ?? '';
    const timeout = values.get('--timeout-ms') ?? '';
    if (!/^[0-9a-f]{64}$/.test(hash) || !/^[1-9][0-9]*$/.test(timeout) || Number(timeout) > MAX_TIMEOUT_MS) {
      emit({ error: USAGE }); return 2;
    }
  }

  const now = deps.now ?? (() => performance.now());
  const wait = deps.wait ?? (async (ms, signal) => { await delay(ms, undefined, { signal }); });
  const deadline = now() + Number(values.get('--timeout-ms') ?? 0);
  try {
    while (!deps.signal?.aborted) {
      const result = await (deps.read ?? readInboxEntries)({ limit: LIMIT });
      if (deps.signal?.aborted) break;
      if (result.sourceState !== 'healthy') {
        emit({ v: 1, status: 'unavailable', sourceState: result.sourceState, entries: [] });
        return result.sourceState === 'missing' ? 3 : 4;
      }
      const fingerprint = inboxFingerprint(result.entries[0]);
      const snapshot = { v: 1, sourceState: result.sourceState, fingerprint, entries: result.entries.slice(0, LIMIT).map(displayEntry) };
      if (once || fingerprint !== values.get('--after-fingerprint')) {
        emit({ ...snapshot, status: once ? 'snapshot' : 'changed' }); return 0;
      }
      const remaining = deadline - now();
      if (remaining <= 0) { emit({ ...snapshot, status: 'timeout' }); return 5; }
      await wait(Math.min(POLL_MS, remaining), deps.signal);
    }
    emit({ error: 'Interrupted.' }); return 130;
  } catch {
    if (deps.signal?.aborted) { emit({ error: 'Interrupted.' }); return 130; }
    emit({ error: 'Unable to observe inbox.' }); return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController();
  const interrupt = (): void => controller.abort();
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try {
    process.exitCode = await runWaitInterjection(process.argv.slice(2), { signal: controller.signal });
  } finally {
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
  }
}
