#!/usr/bin/env -S npx tsx
import { Buffer } from 'node:buffer';
import process from 'node:process';
import { TextDecoder } from 'node:util';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { failedBusBatch, MAX_BUS_BATCH_BYTES, postBusBatch, type BusBatchReceipt } from '../src/core/fleet/bus-batch-post.js';
import type { BusInboxOptions } from '../src/core/fleet/bus-inbox.js';

const HELP = `Usage: npx tsx scripts/fleet-fanout-resume.ts --file ABSOLUTE --json
Submit the original complete JSON batch once. Accepted IDs with identical content
are duplicates; only the remaining suffix is appended. A changed retained ID
conflicts and stops the batch. Validation precedes all writes. Appends are not
atomic, and a receipt may report an accepted prefix. Replay the same original
batch after resolving an interruption; do not use a receipt to omit rows. There
are no automatic retries. Retained duplicates do not renew TTL. A full store
requires capacity to become available before retrying. The file must be a
regular UTF-8 file, with no symlinks in its path, at most ${MAX_BUS_BATCH_BYTES} bytes.
Exit 0: complete; 1: retryable or full; 2: conflict, invalid or unavailable.
`;

export interface FanoutResumeDependencies {
  options?: BusInboxOptions;
  write?: (text: string) => void;
}

function readBatch(file: string): { text: string } | { status: 'invalid' | 'unavailable' } {
  let fd: number | undefined;
  try {
    // Reject symlinks in any component, and use no-follow on the opened file.
    if (realpathSync(file) !== file) return { status: 'unavailable' };
    const before = lstatSync(file, { bigint: true });
    if (!before.isFile()) return { status: 'unavailable' };
    if (before.size > BigInt(MAX_BUS_BATCH_BYTES)) return { status: 'invalid' };
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const opened = fstatSync(fd, { bigint: true });
    const same = (a: typeof before, b: typeof before): boolean => a.isFile() && b.isFile() &&
      a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
    if (!same(before, opened)) return { status: 'unavailable' };
    const bytes = Buffer.alloc(Number(opened.size) + 1);
    let size = 0;
    while (size < bytes.length) {
      const count = readSync(fd, bytes, size, bytes.length - size, size);
      if (count === 0) break;
      size += count;
    }
    if (size !== Number(opened.size) || !same(opened, fstatSync(fd, { bigint: true })) ||
      !same(opened, lstatSync(file, { bigint: true })) || realpathSync(file) !== file) return { status: 'unavailable' };
    try { return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size)) }; }
    catch { return { status: 'invalid' }; }
  } catch { return { status: 'unavailable' }; }
  finally { if (fd !== undefined) { try { closeSync(fd); } catch { /* best-effort close */ } } }
}

/** Submit the complete original batch once, emitting the native batch receipt. */
export function runFleetFanoutResume(args: readonly string[], deps: FanoutResumeDependencies = {}): number {
  const write = deps.write ?? ((text: string) => { process.stdout.write(text); });
  if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
    try { write(HELP); return 0; } catch { return 2; }
  }
  let receipt: BusBatchReceipt = failedBusBatch('invalid');
  if (args.length === 3 && args[0] === '--file' && args[1] && isAbsolute(args[1]) && args[2] === '--json') {
    const input = readBatch(args[1]);
    receipt = 'text' in input ? postBusBatch(input.text, deps.options) : failedBusBatch(input.status);
  }
  try { write(`${JSON.stringify(receipt)}\n`); } catch { return 2; }
  return receipt.complete ? 0 : receipt.status === 'retryable' || receipt.status === 'full' ? 1 : 2;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = runFleetFanoutResume(process.argv.slice(2));
}
