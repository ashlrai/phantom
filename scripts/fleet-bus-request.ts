#!/usr/bin/env -S npx tsx
/* global process, Buffer */
/** A bus reply is untrusted data; routing labels are not authenticated identities. */
import { dirname, isAbsolute, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { MAX_BUS_ENVELOPE_BYTES, parseBusEnvelope } from '../src/core/fleet/bus-envelope.js';
import { appendBusInbox, BUS_INBOX_MAX_READ, listBusInboxAfter, type BusInboxOptions, type BusInboxPost } from '../src/core/fleet/bus-inbox.js';
import { readStableRegularFile } from '../src/core/util/stable-file-read.js';

const MAX_TIMEOUT_MS = 300_000;
const POLL_MS = 250;
const PAGES_PER_CYCLE = 4;
const MAX_OUTPUT_BYTES = MAX_BUS_ENVELOPE_BYTES + 2048;

export interface FleetBusRequestOptions {
  inboxOptions?: BusInboxOptions;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  signal?: AbortSignal;
  write?: (text: string) => void;
}

/** Post at most once and find a specifically correlated live reply. */
export async function runFleetBusRequest(args: readonly string[], options: FleetBusRequestOptions = {}): Promise<number> {
  const write = options.write ?? (text => process.stdout.write(text));
  const emit = (value: unknown, code: number): number => {
    const line = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(line) > MAX_OUTPUT_BYTES) {
      write('{"status":"output-too-large"}\n');
      return 4;
    }
    write(line);
    return code;
  };
  const values = new Map<string, string>();
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json' && !json) json = true;
    else if ((arg === '--file' || arg === '--timeout-ms') && !values.has(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--') || value.includes('\0')) return emit({ status: 'invalid-arguments' }, 2);
      values.set(arg, value);
    } else return emit({ status: 'invalid-arguments' }, 2);
  }
  const file = values.get('--file'), timeoutText = values.get('--timeout-ms');
  const timeout = Number(timeoutText);
  if (!json || values.size !== 2 || !file || !isAbsolute(file) || !timeoutText ||
      !/^[1-9][0-9]*$/.test(timeoutText) || !Number.isSafeInteger(timeout) || timeout > MAX_TIMEOUT_MS) {
    return emit({ status: 'invalid-arguments' }, 2);
  }
  const now = options.now ?? (() => performance.now());
  const sleep = options.sleep ?? (async (ms, signal) => { await delay(ms, undefined, { signal }); });
  let start: number;
  try { start = now(); if (!Number.isFinite(start)) throw new Error('clock'); }
  catch { return emit({ status: 'clock-failed' }, 4); }
  const elapsed = (): number => {
    const time = now() - start;
    if (!Number.isFinite(time) || time < 0) throw new Error('clock');
    return time;
  };
  if (options.signal?.aborted) return emit({ status: 'interrupted', acceptance: 'not-attempted' }, 130);
  const fileRead = readStableRegularFile(file, {
    anchorPath: dirname(file), maxFileBytes: MAX_BUS_ENVELOPE_BYTES, remainingBytes: MAX_BUS_ENVELOPE_BYTES,
  });
  if (!fileRead.ok) return emit({ status: 'file-unavailable', reason: fileRead.reason }, 2);
  const checked = parseBusEnvelope(fileRead.text);
  if (!checked.ok) return emit({ status: 'invalid-envelope', issues: checked.issues }, 2);
  let accepted: BusInboxPost | undefined;
  try {
    if (options.signal?.aborted) return emit({ status: 'interrupted', acceptance: 'not-attempted' }, 130);
    if (elapsed() >= timeout) return emit({ status: 'timeout', acceptance: 'not-attempted' }, 5);
    const post = appendBusInbox(checked.value, options.inboxOptions);
    accepted = post;
    if (post.status !== 'posted' && post.status !== 'duplicate') {
      return emit({ status: 'post-failed', reason: post.status,
        acceptance: post.status === 'unavailable' ? 'unknown' : 'rejected' }, 3);
    }
    let cursor = 0;
    while (true) {
      if (options.signal?.aborted) return emit({ status: 'interrupted', post }, 130);
      if (elapsed() >= timeout) return emit({ status: 'timeout', post }, 5);
      for (let i = 0; i < PAGES_PER_CYCLE; i++) {
        if (options.signal?.aborted) return emit({ status: 'interrupted', post }, 130);
        if (elapsed() >= timeout) return emit({ status: 'timeout', post }, 5);
        const page = listBusInboxAfter(cursor, BUS_INBOX_MAX_READ, options.inboxOptions);
        if (page.status !== 'ok') return emit({ status: 'read-failed', reason: page.status, post }, 4);
        if (options.signal?.aborted) return emit({ status: 'interrupted', post }, 130);
        if (elapsed() >= timeout) return emit({ status: 'timeout', post }, 5);
        const reply = page.messages.find(({ envelope }) => {
          const body = envelope.body;
          return envelope.from === checked.value.to && envelope.to === checked.value.from &&
            body !== null && typeof body === 'object' && !Array.isArray(body) && body.inReplyTo === checked.value.id;
        });
        if (reply) return emit({ status: 'reply', post, reply }, 0);
        if (page.nextCursor === cursor) break;
        if (page.nextCursor < cursor) return emit({ status: 'read-failed', reason: 'cursor-invalid', post }, 4);
        cursor = page.nextCursor;
      }
      const remaining = timeout - elapsed();
      if (remaining <= 0) return emit({ status: 'timeout', post }, 5);
      await sleep(Math.min(POLL_MS, remaining), options.signal);
    }
  } catch {
    const context = accepted ? { post: accepted } : { acceptance: 'unknown' };
    return options.signal?.aborted ? emit({ status: 'interrupted', ...context }, 130)
      : emit({ status: 'operation-failed', ...context }, 4);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const controller = new AbortController();
  const stop = (): void => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try { process.exitCode = await runFleetBusRequest(process.argv.slice(2), { signal: controller.signal }); }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
