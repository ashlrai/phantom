#!/usr/bin/env -S npx tsx
/**
 * Drain the currently retained bus backlog for one address in a single bounded
 * pass. Nothing is marked read, mutated, executed or checkpointed; bodies are
 * untrusted data and addresses are routing labels, not authenticated identity.
 *
 *   npx tsx examples/agents/bus-backlog-drain.ts --to ADDRESS [--after CURSOR]
 *
 * Pages the shared inbox through listBusInboxAfter in BUS_INBOX_MAX_READ-sized
 * reads, keeps every live receipt whose envelope.to matches --to exactly
 * (case-sensitive), and advances nextCursor across pages that yield no
 * matches; expired records advance the cursor but are never returned by the
 * store. The scan ends when the cursor stops advancing (the backlog tail is
 * reached) or once BUS_INBOX_MAX_MESSAGES retained rows have been scanned.
 *
 * Emits exactly one JSON object on stdout and returns the exit code:
 *   complete (0):          {status,to,messages,scanned,nextCursor,scanCapReached}
 *   missing (3):           same shape with empty messages — a missing store is
 *                          never reported as a successful empty drain
 *   read-failed (4):       adds reason: unavailable|retryable|invalid|full|
 *                          conflict|cursor-invalid; partial progress preserved
 *   invalid-arguments (2): {status:'invalid-arguments'} only
 */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateBusEnvelope } from '../../src/core/fleet/bus-envelope.js';
import {
  BUS_INBOX_MAX_MESSAGES,
  BUS_INBOX_MAX_READ,
  inspectBusInbox,
  listBusInboxAfter,
  type BusInboxOptions,
  type BusInboxPage,
  type BusInboxReceipt,
} from '../../src/core/fleet/bus-inbox.js';

export interface BusBacklogDrainDependencies {
  options?: BusInboxOptions;
  inspect?: typeof inspectBusInbox;
  read?: typeof listBusInboxAfter;
  write?: (text: string) => void;
}

/** Reuses the envelope field contract: 1-128 printable-ASCII token. */
function validAddress(label: string): boolean {
  return validateBusEnvelope({ id: label, from: label, to: label, priority: 'P3', ttl: 1, body: null }).ok;
}

/** One bounded read pass; injected store access and output make this safe to embed. */
export function runBusBacklogDrain(args: string[], deps: BusBacklogDrainDependencies = {}): number {
  const write = deps.write ?? (text => process.stdout.write(text));
  const output = (value: unknown, code: number): number => { write(`${JSON.stringify(value)}\n`); return code; };
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i], value = args[i + 1];
    if (!['--to', '--after'].includes(key) || value === undefined || value.startsWith('--') || values.has(key)) {
      return output({ status: 'invalid-arguments' }, 2);
    }
    values.set(key, value);
  }
  const address = values.get('--to'), afterText = values.get('--after') ?? '0';
  const after = Number(afterText);
  if (!address || !validAddress(address) ||
      !/^(0|[1-9][0-9]*)$/.test(afterText) || !Number.isSafeInteger(after)) {
    return output({ status: 'invalid-arguments' }, 2);
  }

  const messages: BusInboxReceipt[] = [];
  let scanned = 0, nextCursor = after;
  const report = (status: string, code: number, reason?: string): number => output({
    status, ...(reason === undefined ? {} : { reason }), to: address,
    messages, scanned, nextCursor, scanCapReached: scanned >= BUS_INBOX_MAX_MESSAGES,
  }, code);

  let source: 'missing' | 'available' | 'unavailable';
  try { source = (deps.inspect ?? inspectBusInbox)(deps.options).source; }
  catch { source = 'unavailable'; }
  if (source === 'missing') return report('missing', 3);
  if (source !== 'available') return report('read-failed', 4, 'unavailable');

  const read = deps.read ?? listBusInboxAfter;
  while (scanned < BUS_INBOX_MAX_MESSAGES) {
    let page: BusInboxPage;
    try { page = read(nextCursor, BUS_INBOX_MAX_READ, deps.options); }
    catch { return report('read-failed', 4, 'unavailable'); }
    if (page.status !== 'ok') return report('read-failed', 4, page.status);
    if (!Number.isSafeInteger(page.nextCursor) || page.nextCursor < nextCursor) {
      return report('read-failed', 4, 'cursor-invalid');
    }
    for (const row of page.messages) {
      if (row.envelope.to === address) messages.push(row);
    }
    scanned += page.nextCursor - nextCursor;
    const advanced = page.nextCursor > nextCursor;
    nextCursor = page.nextCursor;
    if (!advanced) break;
  }
  return report('complete', 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = runBusBacklogDrain(process.argv.slice(2));
}
