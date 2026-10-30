/** Local, append-only-in-meaning station evidence. Never grants lifecycle authority. */
import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

import { acquireLocalStoreLock, ownsLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { assurePrivateStoragePath } from '../util/private-storage.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import { readStableRegularFile } from '../util/stable-file-read.js';
import { parseStationEvent, validateStationLineage, type StationEvent } from './router-queue.js';

export const MAX_STATION_JOURNAL_BYTES = 16 * 1024 * 1024;

function unavailable(): never { throw new Error('Station journal is unavailable or unsafe'); }

/** The explicitly selected journal directory is the private-storage anchor. */
function inspectDirectory(directory: string): boolean {
  try {
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || (typeof process.getuid === 'function' && stat.uid !== process.getuid())
      || (process.platform !== 'win32' && (stat.mode & 0o7777) !== 0o700)) unavailable();
    if (!assurePrivateStoragePath(directory, 'directory', 'inspect-existing', { anchorPath: directory }).ok) unavailable();
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    return unavailable();
  }
}

/** Missing is empty; unreadable, oversized, truncated or malformed is an error. */
export function readStationEvents(journalPath: string): StationEvent[] {
  const path = resolve(journalPath);
  const directory = dirname(path);
  if (!inspectDirectory(directory)) return [];
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || (process.platform !== 'win32' && (stat.mode & 0o7777) !== 0o600)) unavailable();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    return unavailable();
  }
  const read = readStableRegularFile(path, {
    anchorPath: directory, maxFileBytes: MAX_STATION_JOURNAL_BYTES, remainingBytes: MAX_STATION_JOURNAL_BYTES,
  });
  if (!read.ok) unavailable();
  try {
    const value: unknown = JSON.parse(read.text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) unavailable();
    const row = value as Record<string, unknown>;
    if (Object.keys(row).sort().join(',') !== 'events,schemaVersion'
      || row['schemaVersion'] !== 1 || !Array.isArray(row['events'])) unavailable();
    const events = row['events'].map(parseStationEvent);
    if (new Set(events.map(event => event.eventId)).size !== events.length) unavailable();
    validateStationLineage(events);
    return events;
  } catch { return unavailable(); }
}

/** Serialize read/dedupe/fsync/replace across box processes; never prune receipts. */
export function appendStationEvents(
  journalPath: string, input: StationEvent[],
): { added: StationEvent[]; events: StationEvent[] } {
  let incoming: StationEvent[];
  try { incoming = input.map(parseStationEvent); } catch { throw new Error('Invalid station journal events'); }
  if (incoming.length === 0) return { added: [], events: readStationEvents(journalPath) };
  const path = resolve(journalPath);
  const directory = dirname(path);
  try {
    if (!inspectDirectory(directory)) {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (!inspectDirectory(directory)) unavailable();
    }
  } catch { return unavailable(); }
  const lock = acquireLocalStoreLock(`${path}.lock`, 2_000, { anchorPath: directory, exactPrivateStorage: true });
  if (!lock) throw new Error('Station journal is busy or unavailable');
  try {
    const events = readStationEvents(path);
    const seen = new Set(events.map(event => event.eventId));
    const added: StationEvent[] = [];
    for (const event of incoming) {
      if (!seen.has(event.eventId)) { seen.add(event.eventId); added.push(event); }
    }
    if (added.length === 0) return { added, events };
    const combined = [...events, ...added];
    validateStationLineage(combined);
    const serialized = `${JSON.stringify({ schemaVersion: 1, events: combined })}\n`;
    if (Buffer.byteLength(serialized, 'utf8') > MAX_STATION_JOURNAL_BYTES) {
      throw new Error('Station journal is full; archive evidence before retrying');
    }
    if (!ownsLocalStoreLock(lock)) unavailable();
    try {
      writePrivateFileAtomically(`${path}.${randomUUID()}.tmp`, path, serialized, {
        anchorPath: directory, label: 'Station journal',
      });
    } catch { return unavailable(); }
    return { added, events: combined };
  } finally {
    if (!releaseLocalStoreLock(lock)) unavailable();
  }
}
