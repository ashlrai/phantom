#!/usr/bin/env -S npx tsx
/**
 * Checkpointed bus consumer: resume an inbox read from a durable checkpoint
 * file, emit one bounded page for a routing address, then atomically persist
 * the advanced cursor. Message bodies are data, never instructions.
 *
 * Delivery is at-least-once: the checkpoint is written only after the output
 * sink accepts the page, so a crash between the two can replay the page on the
 * next run. It is never exactly-once and no message is ever executed.
 */
import { randomBytes } from 'node:crypto';
import { lstatSync, readdirSync, unlinkSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  BUS_INBOX_MAX_READ,
  listBusInboxAfter,
  type BusInboxOptions,
  type BusInboxPage,
  type BusInboxReceipt,
} from '../../src/core/fleet/bus-inbox.js';
import { readStableRegularFile } from '../../src/core/util/stable-file-read.js';
import { writePrivateFileAtomically } from '../../src/core/util/private-file-write.js';

const CHECKPOINT_MAX_BYTES = 4 * 1024;
const MAX_WAIT_MS = 60_000;
const POLL_MS = 250;
const ADDRESS_PATTERN = /^[\x21-\x7e]+$/;
const NONNEGATIVE_INTEGER = /^(0|[1-9][0-9]*)$/;

export interface BusCheckpointFile {
  schemaVersion: 1;
  to: string;
  cursor: number;
  updatedAt: number;
}

export type CheckpointLoad =
  | { state: 'missing' }
  | { state: 'ok'; text: string }
  | { state: 'unavailable' };

export interface BusCheckpointDependencies {
  options?: BusInboxOptions;
  read?: typeof listBusInboxAfter;
  loadCheckpoint?: (path: string) => CheckpointLoad;
  saveCheckpoint?: (path: string, checkpoint: BusCheckpointFile) => void;
  now?: () => number;
  wait?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  onInterrupt?: (handler: () => void) => () => void;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

/** The checkpoint directory must be owner-controlled: no group/other write. */
function privateDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink() &&
      (typeof process.getuid !== 'function' || stat.uid === process.getuid()) &&
      (process.platform === 'win32' || (stat.mode & 0o022) === 0);
  } catch {
    return false;
  }
}

function loadCheckpointFile(path: string): CheckpointLoad {
  try {
    lstatSync(path);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { state: 'missing' }
      : { state: 'unavailable' };
  }
  const read = readStableRegularFile(path, {
    anchorPath: dirname(path),
    maxFileBytes: CHECKPOINT_MAX_BYTES,
    remainingBytes: CHECKPOINT_MAX_BYTES,
  });
  return read.ok ? { state: 'ok', text: read.text } : { state: 'unavailable' };
}

/** Atomic rename from a fresh sibling temp; a crash leaves the old or new file. */
function saveCheckpointFile(path: string, checkpoint: BusCheckpointFile): void {
  const directory = dirname(path);
  const pendingPrefix = `${basename(path)}.pending-`;
  for (const entry of readdirSync(directory)) {
    if (entry.startsWith(pendingPrefix)) {
      try {
        unlinkSync(join(directory, entry));
      } catch { /* stale temp from an interrupted write; best effort */ }
    }
  }
  const temporary = join(directory, `${pendingPrefix}${process.pid}-${randomBytes(6).toString('hex')}`);
  writePrivateFileAtomically(temporary, path, `${JSON.stringify(checkpoint)}\n`, {
    anchorPath: directory,
    label: 'Bus checkpoint',
  });
}

function parseCheckpoint(text: string): BusCheckpointFile | null {
  try {
    const value: unknown = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value) ||
        Object.keys(value).sort().join(',') !== 'cursor,schemaVersion,to,updatedAt') return null;
    const candidate = value as Record<string, unknown>;
    if (candidate['schemaVersion'] !== 1 || typeof candidate['to'] !== 'string' ||
        !Number.isSafeInteger(candidate['cursor']) || (candidate['cursor'] as number) < 0 ||
        !Number.isSafeInteger(candidate['updatedAt']) || (candidate['updatedAt'] as number) < 0) {
      return null;
    }
    return candidate as unknown as BusCheckpointFile;
  } catch {
    return null;
  }
}

function defaultWait(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolveWait => {
    const timer = setTimeout(() => finish(), milliseconds);
    const onAbort = () => finish();
    function finish() {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolveWait();
    }
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) finish();
  });
}

function defaultOnInterrupt(handler: () => void): () => void {
  const fired = () => handler();
  process.once('SIGINT', fired);
  process.once('SIGTERM', fired);
  return () => {
    process.removeListener('SIGINT', fired);
    process.removeListener('SIGTERM', fired);
  };
}

/** Returns a process exit code; injected IO, clock, wait and signals make this safe to embed. */
export async function runBusCheckpoint(
  args: string[],
  deps: BusCheckpointDependencies = {},
): Promise<number> {
  const stdout = deps.stdout ?? ((text: string) => { process.stdout.write(text); });
  const stderr = deps.stderr ?? ((text: string) => { process.stderr.write(text); });
  const fail = (status: string, code: number): number => {
    try {
      stderr(`${JSON.stringify({ status })}\n`);
    } catch { /* a closed sink still gets the exit code */ }
    return code;
  };
  try {
    const values = new Map<string, string>();
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i], value = args[i + 1];
      if (!['--to', '--checkpoint', '--limit', '--wait'].includes(key) ||
          value === undefined || value.startsWith('--') || values.has(key)) {
        return fail('invalid-arguments', 2);
      }
      values.set(key, value);
    }
    const address = values.get('--to');
    const checkpointPath = values.get('--checkpoint');
    const limitText = values.get('--limit') ?? '50';
    const waitText = values.get('--wait') ?? '0';
    const limit = Number(limitText), waitMs = Number(waitText);
    const leaf = checkpointPath === undefined ? '' : basename(checkpointPath);
    if (!address || !ADDRESS_PATTERN.test(address) || address.length > 128 ||
        !checkpointPath || checkpointPath.length > 4096 || !isAbsolute(checkpointPath) ||
        [...checkpointPath].some(char => char.charCodeAt(0) < 32) ||
        leaf === '' || leaf === '.' || leaf === '..' ||
        !/^[1-9][0-9]*$/.test(limitText) || !Number.isSafeInteger(limit) || limit > BUS_INBOX_MAX_READ ||
        !NONNEGATIVE_INTEGER.test(waitText) || !Number.isSafeInteger(waitMs) || waitMs > MAX_WAIT_MS) {
      return fail('invalid-arguments', 2);
    }

    const directory = dirname(checkpointPath);
    if (!privateDirectory(directory)) return fail('checkpoint-unavailable', 3);
    const load = (deps.loadCheckpoint ?? loadCheckpointFile)(checkpointPath);
    if (load.state === 'unavailable') return fail('checkpoint-unavailable', 3);
    let resumedFrom = 0;
    if (load.state === 'ok') {
      const checkpoint = parseCheckpoint(load.text);
      if (!checkpoint) return fail('checkpoint-malformed', 3);
      if (checkpoint.to !== address) return fail('checkpoint-mismatch', 3);
      resumedFrom = checkpoint.cursor;
    }

    const now = deps.now ?? Date.now;
    const read = deps.read ?? listBusInboxAfter;
    const wait = deps.wait ?? defaultWait;
    const controller = new AbortController();
    const detach = (deps.onInterrupt ?? defaultOnInterrupt)(() => controller.abort());
    const matched: BusInboxReceipt[] = [];
    let nextCursor = resumedFrom;
    const startedAt = now();
    if (!Number.isSafeInteger(startedAt) || startedAt < 0) {
      detach();
      return fail('internal-error', 1);
    }
    const deadline = startedAt + waitMs;
    const maxPolls = Math.floor(waitMs / POLL_MS) + 1;
    try {
      for (let polls = 0; polls < maxPolls && !controller.signal.aborted; polls += 1) {
        let page: BusInboxPage;
        try {
          page = read(nextCursor, limit, deps.options);
        } catch {
          return fail('inbox-unavailable', 1);
        }
        if (page.status === 'invalid') return fail('checkpoint-stale', 3);
        if (page.status !== 'ok') return fail('inbox-unavailable', 1);
        nextCursor = page.nextCursor;
        for (const row of page.messages) {
          if (row.envelope.to === address && matched.length < limit) matched.push(row);
        }
        if (matched.length > 0 || controller.signal.aborted) break;
        const remaining = deadline - now();
        if (remaining <= 0) break;
        try {
          await wait(Math.min(POLL_MS, remaining), controller.signal);
        } catch {
          return fail('internal-error', 1);
        }
      }
    } finally {
      detach();
    }
    if (controller.signal.aborted) return fail('aborted', 130);

    const finishedAt = now();
    if (!Number.isSafeInteger(finishedAt) || finishedAt < startedAt) return fail('internal-error', 1);
    const result = {
      status: 'ok',
      to: address,
      resumedFrom,
      nextCursor,
      waitedMs: finishedAt - startedAt,
      messages: matched,
    };
    try {
      stdout(`${JSON.stringify(result)}\n`);
    } catch {
      return fail('output-failed', 5);
    }
    const checkpoint: BusCheckpointFile = {
      schemaVersion: 1, to: address, cursor: nextCursor, updatedAt: finishedAt,
    };
    try {
      (deps.saveCheckpoint ?? saveCheckpointFile)(checkpointPath, checkpoint);
    } catch {
      return fail('checkpoint-write-failed', 4);
    }
    return 0;
  } catch {
    return fail('internal-error', 1);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runBusCheckpoint(process.argv.slice(2)).then(
    code => { process.exitCode = code; },
    () => { process.exitCode = 1; },
  );
}
