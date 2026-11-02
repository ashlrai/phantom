/** Namespaced extension to fleet.json; other fleet writers must share its lock. */
import { randomUUID } from 'node:crypto';
import { constants, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { open, lstat, realpath } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { acquireLocalStoreLock, ownsLocalStoreLock, releaseLocalStoreLock } from './local-store-lock.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { buildGrokUltraRunway, GROK_ULTRA_MAX_READINGS, validGrokUltraReading } from './grok-ultra-runway.js';
import type { GrokUltraReading, GrokUltraRunway } from './grok-ultra-types.js';

const MAX_BYTES = 2 * 1024 * 1024;
export function grokUltraFleetPath(): string {
  return process.env['PHANTOM_FLEET_FILE'] ?? '/workspace/phantom-work/fleet.json';
}
function checkedPath(file: string): string {
  if (!isAbsolute(file) || basename(file) !== 'fleet.json') throw new Error('Expected an absolute fleet.json path');
  return resolve(file);
}
function parsed(text: string): { document: Record<string, unknown>; readings: GrokUltraReading[] } {
  const doc: unknown = JSON.parse(text);
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('Invalid fleet document');
  const document = doc as Record<string, unknown>;
  if (!Object.hasOwn(document, 'grokUltra')) return { document, readings: [] };
  const extension = document.grokUltra as { v?: unknown; readings?: unknown } | null;
  if (!extension || typeof extension !== 'object' || extension.v !== 1 || !Array.isArray(extension.readings) ||
    extension.readings.length > GROK_ULTRA_MAX_READINGS || !extension.readings.every(validGrokUltraReading)) {
    throw new Error('Invalid Grok usage history');
  }
  return { document, readings: extension.readings };
}
function unavailable(now: number): GrokUltraRunway {
  return { ...buildGrokUltraRunway([], now), state: 'unavailable' };
}

/** Async, bounded, no-follow read for HTTP callers. Never serializes the fleet document. */
export async function readGrokUltraRunway(file = grokUltraFleetPath(), now = Date.now()): Promise<GrokUltraRunway> {
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    file = checkedPath(file);
    const parent = dirname(file);
    const parentStat = await lstat(parent);
    if (!parentStat.isDirectory() || parentStat.isSymbolicLink() || await realpath(parent) !== parent ||
      typeof process.getuid === 'function' && parentStat.uid !== process.getuid() ||
      process.platform !== 'win32' && (parentStat.mode & 0o022) !== 0) return unavailable(now);
    const namedBefore = await lstat(file);
    if (!namedBefore.isFile() || namedBefore.isSymbolicLink()) return unavailable(now);
    // A raced replacement by a FIFO must not park a libuv worker indefinitely.
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== namedBefore.dev || before.ino !== namedBefore.ino || before.nlink !== 1 || before.size > MAX_BYTES ||
      typeof process.getuid === 'function' && before.uid !== process.getuid() ||
      process.platform !== 'win32' && (before.mode & 0o022) !== 0) return unavailable(now);
    const bytes = Buffer.alloc(before.size + 1);
    let count = 0;
    while (count < bytes.length) {
      const read = await handle.read(bytes, count, bytes.length - count, count);
      if (!read.bytesRead) break;
      count += read.bytesRead;
    }
    const after = await handle.stat();
    const named = await lstat(file);
    const parentAfter = await lstat(parent);
    if (count !== before.size || before.size !== after.size || before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs || named.isSymbolicLink() || before.dev !== named.dev || before.ino !== named.ino ||
      parentStat.dev !== parentAfter.dev || parentStat.ino !== parentAfter.ino || await realpath(parent) !== parent) return unavailable(now);
    return buildGrokUltraRunway(parsed(bytes.subarray(0, count).toString('utf8')).readings, now);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? buildGrokUltraRunway([], now) : unavailable(now);
  } finally { await handle?.close().catch(() => undefined); }
}

/** The fallback accepts manual points only. No claimed app-local adapter exists. */
export function recordManualGrokUltraReading(
  input: Omit<GrokUltraReading, 'source'>,
  file = grokUltraFleetPath(),
  now = Date.now(),
): GrokUltraRunway {
  const reading: GrokUltraReading = { source: 'manual', timestamp: input.timestamp,
    remainingPoints: input.remainingPoints, totalPoints: input.totalPoints };
  if (!validGrokUltraReading(reading) || Date.parse(reading.timestamp) > now) throw new Error('Invalid manual usage reading');
  file = checkedPath(file);
  const parent = dirname(file);
  let existing = parent;
  for (;;) {
    try {
      const stat = lstatSync(existing);
      if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(existing) !== existing) throw new Error('Unsafe fleet directory');
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      existing = dirname(existing);
    }
  }
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const parentStat = lstatSync(parent);
  if (realpathSync(parent) !== parent || parentStat.isSymbolicLink() ||
    typeof process.getuid === 'function' && parentStat.uid !== process.getuid() ||
    process.platform !== 'win32' && (parentStat.mode & 0o022) !== 0) throw new Error('Unsafe fleet directory');
  const lock = acquireLocalStoreLock(join(parent, '.fleet-locks', 'fleet.json.lock'), 250, { anchorPath: parent });
  if (!lock) throw new Error('Fleet store is busy or unavailable');
  try {
    let document: Record<string, unknown> = {};
    let readings: GrokUltraReading[] = [];
    try {
      lstatSync(file);
      const read = readStableRegularFile(file, { anchorPath: parent, maxFileBytes: MAX_BYTES, remainingBytes: MAX_BYTES });
      if (!read.ok) throw new Error('Unsafe fleet document');
      ({ document, readings } = parsed(read.text));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Fleet document is unreadable or invalid');
    }
    if (buildGrokUltraRunway(readings, now).state === 'unavailable') throw new Error('Invalid usage history');
    const latest = readings.at(-1);
    if (latest && reading.timestamp === latest.timestamp && reading.source === latest.source &&
      reading.remainingPoints === latest.remainingPoints && reading.totalPoints === latest.totalPoints) {
      return buildGrokUltraRunway(readings, now); // Idempotent retry; never extend freshness.
    }
    if (latest && Date.parse(reading.timestamp) <= Date.parse(latest.timestamp)) throw new Error('Reading must be newer than history');
    if (readings.length >= GROK_ULTRA_MAX_READINGS) throw new Error('Usage history limit reached');
    const next = [...readings, reading];
    const text = JSON.stringify({ ...document, grokUltra: { v: 1, readings: next } }, null, 2) + '\n';
    if (Buffer.byteLength(text) > MAX_BYTES || !ownsLocalStoreLock(lock)) throw new Error('Fleet store cannot be updated');
    writePrivateFileAtomically(join(parent, `.fleet-${randomUUID()}.tmp`), file, text,
      { anchorPath: parent, label: 'Fleet usage' });
    return buildGrokUltraRunway(next, now);
  } finally { releaseLocalStoreLock(lock); }
}
