#!/usr/bin/env -S npx tsx
/**
 * Publish a JSON array of 1..20 complete bus envelopes to the local inbox:
 *   npx tsx examples/agents/bus-fanout.ts --file ./manifest.json
 * Example manifest:
 *   [{"id":"fake-1","from":"fake-lead","to":"fake-worker","priority":"P2","ttl":60000,"body":{"task":"fake work"}}]
 *
 * The file and its parent must be owner-controlled and not group/other writable;
 * the file must be a regular, singly linked file no larger than 1 MiB. Bodies
 * remain opaque data and are never executed. Validation precedes all posts.
 * Posts are sequential, not atomic: earlier posts remain after a failure.
 * Replaying the same envelopes uses the inbox's retained-ID deduplication.
 *
 * One stdout JSON object has schema "bus-fanout.v1". Valid manifests report
 * status "ok" or "partial", ordered receipts (id, status, and cursor on
 * success; acceptance on failure), and unattemptedIds. A failed/throwing
 * append with unavailable status has unknown acceptance. Input errors use
 * status "error" and error: invalid-arguments, file-unavailable,
 * invalid-json, invalid-manifest, invalid-envelope, or duplicate-id. Errors
 * never include raw exception text or message bodies. Exit codes: 0 success,
 * 2 input error, 1 partial failure or output failure. If stdout fails, stderr
 * receives a stable output-failed error when possible.
 */
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { validateBusEnvelope, type BusEnvelope } from '../../src/core/fleet/bus-envelope.js';
import { appendBusInbox, type BusInboxOptions } from '../../src/core/fleet/bus-inbox.js';
import { readStableRegularFile } from '../../src/core/util/stable-file-read.js';

const MAX_FILE_BYTES = 1024 * 1024;
const SCHEMA = 'bus-fanout.v1';

export interface BusFanoutDependencies {
  append?: typeof appendBusInbox;
  options?: BusInboxOptions;
  write?: (text: string) => void;
  writeError?: (text: string) => void;
}

/** Validate a whole manifest before attempting a single transport append. */
export function runBusFanout(args: readonly string[], deps: BusFanoutDependencies = {}): number {
  const write = deps.write ?? (text => { process.stdout.write(text); });
  const writeError = deps.writeError ?? (text => { process.stderr.write(text); });
  const emit = (result: object, code: number): number => {
    try { write(`${JSON.stringify({ schema: SCHEMA, ...result })}\n`); return code; }
    catch {
      try { writeError(`${JSON.stringify({ schema: SCHEMA, status: 'error', error: 'output-failed' })}\n`); } catch { /* closed sink */ }
      return 1;
    }
  };
  const fail = (error: string): number => emit({ status: 'error', error }, 2);
  if (args.length !== 2 || args[0] !== '--file' || !args[1] || args[1].startsWith('--')) return fail('invalid-arguments');

  const path = resolve(args[1]);
  const file = readStableRegularFile(path, { anchorPath: dirname(path), maxFileBytes: MAX_FILE_BYTES, remainingBytes: MAX_FILE_BYTES });
  if (!file.ok) return fail('file-unavailable');
  let input: unknown;
  try { input = JSON.parse(file.text); } catch { return fail('invalid-json'); }
  if (!Array.isArray(input) || input.length < 1 || input.length > 20) return fail('invalid-manifest');

  const envelopes: BusEnvelope[] = [];
  const ids = new Set<string>();
  for (const item of input) {
    const checked = validateBusEnvelope(item);
    if (!checked.ok) return fail('invalid-envelope');
    if (ids.has(checked.value.id)) return fail('duplicate-id');
    ids.add(checked.value.id);
    envelopes.push(checked.value);
  }

  const receipts: object[] = [];
  for (const [index, envelope] of envelopes.entries()) {
    let result: ReturnType<typeof appendBusInbox>;
    try { result = (deps.append ?? appendBusInbox)(envelope, deps.options); }
    catch { result = { status: 'unavailable' }; }
    if (result.status === 'posted' || result.status === 'duplicate') {
      receipts.push({ id: envelope.id, status: result.status, cursor: result.cursor });
      continue;
    }
    receipts.push({ id: envelope.id, status: result.status, acceptance: result.status === 'unavailable' ? 'unknown' : 'rejected' });
    return emit({ status: 'partial', receipts, unattemptedIds: envelopes.slice(index + 1).map(item => item.id) }, 1);
  }
  return emit({ status: 'ok', receipts, unattemptedIds: [] }, 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = runBusFanout(process.argv.slice(2));
}
