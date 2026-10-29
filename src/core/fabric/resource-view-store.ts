import { randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, mkdirSync, rmdirSync, unlinkSync, type Stats } from 'node:fs';
import { open } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { privateDirectory } from '../universe/artifacts.js';
import { acquireLocalStoreLockWithOutcome, ownsLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import { buildResourceView, resourceObject, type ResourceView } from './resource-view.js';

const MAX_BYTES = 8 * 1024 * 1024;
export function resourceViewDirectory(): string { return join(homedir(), '.ashlr'); }
function parseFleet(raw: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid fleet snapshot');
  const fleet = parsed as Record<string, unknown>;
  if (fleet.resources !== undefined && (!fleet.resources || typeof fleet.resources !== 'object' || Array.isArray(fleet.resources))) {
    throw new Error('Invalid fleet resources');
  }
  return fleet;
}
function safeFile(stat: Stats): boolean {
  return stat.isFile() && stat.nlink === 1 && stat.size <= MAX_BYTES &&
    (typeof process.getuid !== 'function' || stat.uid === process.getuid()) && (Number(stat.mode) & 0o022) === 0;
}
function sameFile(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}
function readFleetSync(file: string): Record<string, unknown> {
  let fd: number;
  try { fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {}; throw error; }
  try {
    const stat = fstatSync(fd);
    if (!safeFile(stat)) throw new Error('Unsafe fleet snapshot');
    const buffer = Buffer.alloc(stat.size + 1); let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    if (offset !== stat.size || !sameFile(stat, fstatSync(fd))) throw new Error('Fleet snapshot changed during read');
    return parseFleet(buffer.subarray(0, offset).toString('utf8'));
  } finally { closeSync(fd); }
}

/** UI reads are async and bounded. Missing, unsafe or corrupt input is unknown, never zero. */
export async function readResourceView(directory = resourceViewDirectory(), nowMs = Date.now()): Promise<ResourceView> {
  try {
    const handle = await open(join(directory, 'fleet.json'), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!safeFile(stat)) return buildResourceView({}, nowMs);
      const buffer = Buffer.alloc(stat.size + 1); let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (offset !== stat.size || !sameFile(stat, await handle.stat())) return buildResourceView({}, nowMs);
      return buildResourceView(parseFleet(buffer.subarray(0, offset).toString('utf8')), nowMs);
    } finally { await handle.close(); }
  } catch { return buildResourceView({}, nowMs); }
}

/** Atomically add the view without replacing sibling readings or inventory. No provider calls. */
export function writeResourceView(directory = resourceViewDirectory(), nowMs = Date.now()): ResourceView {
  const root = privateDirectory(directory);
  const acquired = acquireLocalStoreLockWithOutcome(join(root, 'usage-writer.lock'), 0,
    { anchorPath: root, exactPrivateStorage: true });
  if (acquired.state !== 'acquired') throw new Error('Resource inputs are busy or unavailable');
  const file = join(root, 'fleet.json'), inventoryLock = join(root, 'model-inventory.lock'), machineLock = `${file}.machine.lock`;
  let inventoryIdentity: Stats | undefined, machineIdentity: Stats | undefined, machineFd: number | undefined;
  try {
    // Acquire sibling writer locks before reading. Never steal an abandoned lock.
    mkdirSync(inventoryLock, { mode: 0o700 }); inventoryIdentity = lstatSync(inventoryLock);
    machineFd = openSync(machineLock, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    machineIdentity = fstatSync(machineFd);
    const fleet = readFleetSync(file);
    const view = buildResourceView(fleet, nowMs);
    if (!ownsLocalStoreLock(acquired.lock)) throw new Error('Resource writer lost its lock');
    const serialized = JSON.stringify({ ...fleet, resources: { ...resourceObject(fleet.resources), view } }, null, 2) + '\n';
    if (Buffer.byteLength(serialized) > MAX_BYTES) throw new Error('Fleet resource view too large');
    writePrivateFileAtomically(join(root, `.resource-${randomUUID()}.tmp`), file, serialized,
      { anchorPath: root, label: 'Fleet resource view' });
    return view;
  } finally {
    try {
      if (machineFd !== undefined) closeSync(machineFd);
      if (machineIdentity && sameFile(machineIdentity, lstatSync(machineLock))) unlinkSync(machineLock);
    } finally {
      try { if (inventoryIdentity && sameFile(inventoryIdentity, lstatSync(inventoryLock))) rmdirSync(inventoryLock); }
      finally { releaseLocalStoreLock(acquired.lock); }
    }
  }
}
