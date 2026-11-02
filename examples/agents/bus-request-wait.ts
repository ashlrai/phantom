#!/usr/bin/env -S npx tsx
/** Post one request and wait for a correlated, untrusted bus message. */
import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { MAX_BUS_ENVELOPE_BYTES, parseBusEnvelope } from '../../src/core/fleet/bus-envelope.js';
import {
  appendBusInbox, BUS_INBOX_MAX_MESSAGES, BUS_INBOX_MAX_READ, listBusInboxAfter,
  type BusInboxOptions,
} from '../../src/core/fleet/bus-inbox.js';

interface Dependencies {
  readFile?: (path: string) => string;
  read?: typeof listBusInboxAfter;
  post?: typeof appendBusInbox;
  options?: BusInboxOptions;
  now?: () => number;
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  write?: (text: string) => void;
}

// Bound allocation and reject special files before reading input from disk.
function readEnvelopeFile(path: string): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    if (!fstatSync(fd).isFile()) throw new Error('Not a regular file');
    const buffer = Buffer.alloc(MAX_BUS_ENVELOPE_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = readSync(fd, buffer, size, buffer.length - size, null);
      if (count === 0) break;
      size += count;
    }
    if (size > MAX_BUS_ENVELOPE_BYTES) throw new Error('File too large');
    return buffer.subarray(0, size).toString('utf8');
  } finally { closeSync(fd); }
}

/** Returns an exit code and emits one JSON object. All IO can be injected. */
export async function runBusRequestWait(args: string[], deps: Dependencies = {}): Promise<number> {
  const write = deps.write ?? (text => process.stdout.write(text));
  const output = (value: unknown, code: number): number => { write(`${JSON.stringify(value)}\n`); return code; };
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!, value = args[i + 1];
    if (!['--file', '--timeout-ms'].includes(key) || value === undefined || value.startsWith('--') || values.has(key)) {
      return output({ status: 'invalid-arguments' }, 2);
    }
    values.set(key, value);
  }
  const file = values.get('--file'), timeoutText = values.get('--timeout-ms');
  const timeout = Number(timeoutText);
  if (!file || !timeoutText || !/^[1-9][0-9]*$/.test(timeoutText) || !Number.isSafeInteger(timeout) || timeout > 300_000) {
    return output({ status: 'invalid-arguments' }, 2);
  }
  let input: string;
  try { input = (deps.readFile ?? readEnvelopeFile)(file); }
  catch { return output({ status: 'file-unavailable' }, 2); }
  const checked = parseBusEnvelope(input);
  if (!checked.ok) return output({ status: 'invalid-envelope', issues: checked.issues }, 2);

  const read = deps.read ?? listBusInboxAfter, post = deps.post ?? appendBusInbox;
  const now = deps.now ?? (() => performance.now());
  const wait = deps.wait ?? (async (ms, signal) => { await delay(ms, undefined, { signal }); });
  let cursor = 0;
  // The store holds at most 1024 rows. One additional page confirms the tail.
  const maxPages = Math.ceil(BUS_INBOX_MAX_MESSAGES / BUS_INBOX_MAX_READ) + 1;
  try {
    for (let i = 0; i < maxPages; i++) {
      if (deps.signal?.aborted) return output({ status: 'interrupted', acceptance: 'not-attempted' }, 130);
      const page = read(cursor, BUS_INBOX_MAX_READ, deps.options);
      if (page.status !== 'ok') return output({ status: 'read-failed', phase: 'cursor', reason: page.status }, 4);
      if (page.nextCursor === cursor) break;
      if (page.nextCursor < cursor || i === maxPages - 1) return output({ status: 'read-failed', phase: 'cursor', reason: 'cursor-invalid' }, 4);
      cursor = page.nextCursor;
    }
  } catch { return output({ status: 'read-failed', phase: 'cursor', reason: 'unavailable' }, 4); }
  if (deps.signal?.aborted) return output({ status: 'interrupted', acceptance: 'not-attempted' }, 130);
  let accepted: ReturnType<typeof appendBusInbox>;
  try { accepted = post(checked.value, deps.options); }
  catch { return output({ status: 'post-failed', reason: 'unavailable', acceptance: 'unknown' }, 3); }
  if (accepted.status !== 'posted' && accepted.status !== 'duplicate') {
    return output({ status: 'post-failed', reason: accepted.status, acceptance: accepted.status === 'unavailable' ? 'unknown' : 'rejected' }, 3);
  }
  try {
    const start = now();
    if (!Number.isFinite(start)) throw new Error('Invalid clock');
    while (true) {
      if (deps.signal?.aborted) return output({ status: 'interrupted', post: accepted }, 130);
      for (let i = 0; i < maxPages; i++) {
        const page = read(cursor, BUS_INBOX_MAX_READ, deps.options);
        if (page.status !== 'ok') return output({ status: 'read-failed', phase: 'wait', reason: page.status, post: accepted }, 4);
        const match = page.messages.find(({ envelope }) => {
          const body = envelope.body;
          return envelope.to === checked.value.from && body !== null && typeof body === 'object' &&
            !Array.isArray(body) && body.replyTo === checked.value.id;
        });
        if (match) return output({ status: 'reply', post: accepted, reply: match }, 0);
        if (page.nextCursor === cursor) break;
        if (page.nextCursor < cursor || i === maxPages - 1) return output({ status: 'read-failed', phase: 'wait', reason: 'cursor-invalid', post: accepted }, 4);
        cursor = page.nextCursor;
      }
      const elapsed = now() - start;
      if (!Number.isFinite(elapsed) || elapsed < 0) throw new Error('Invalid clock');
      if (elapsed >= timeout) return output({ status: 'timeout', post: accepted }, 5);
      await wait(Math.min(250, timeout - elapsed), deps.signal);
    }
  } catch {
    return deps.signal?.aborted
      ? output({ status: 'interrupted', post: accepted }, 130)
      : output({ status: 'wait-failed', post: accepted }, 4);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try { process.exitCode = await runBusRequestWait(process.argv.slice(2), { signal: controller.signal }); }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
