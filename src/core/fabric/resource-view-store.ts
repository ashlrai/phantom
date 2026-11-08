import { randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, mkdirSync, rmdirSync, unlinkSync, type Stats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { privateDirectory } from '../universe/artifacts.js';
import { acquireLocalStoreLockWithOutcome, ownsLocalStoreLock, releaseLocalStoreLock } from '../fleet/local-store-lock.js';
import { writePrivateFileAtomically } from '../util/private-file-write.js';
import { buildResourceView, MACHINE_MAX_AGE_MS, resourceObject, type ResourceView } from './resource-view.js';
import { withDevinUsage, type DevinUsageResult } from './readers/devin-usage.js';

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

/** Live Devin reads join the same custody reader the usage panel uses; a slow first read never stalls the view. */
export const DEVIN_READ_BOUND_MS = 4_000;

async function mergeDevin(fleet: Record<string, unknown>, read: () => Promise<DevinUsageResult>): Promise<Record<string, unknown>> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([withDevinUsage(fleet, read),
      new Promise<Record<string, unknown>>(resolve => { timer = setTimeout(() => resolve(fleet), DEVIN_READ_BOUND_MS); timer.unref?.(); })]);
  } finally { clearTimeout(timer); }
}

/** UI reads are async and bounded. Missing, unsafe or corrupt input is unknown, never zero. */
async function readFleetView(directory: string, nowMs: number, devinRead?: () => Promise<DevinUsageResult>): Promise<ResourceView> {
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
      const fleet = parseFleet(buffer.subarray(0, offset).toString('utf8'));
      return buildResourceView(devinRead === undefined ? fleet : await mergeDevin(fleet, devinRead), nowMs);
    } finally { await handle.close(); }
  } catch { return buildResourceView({}, nowMs); }
}

function safeDirectory(stat: Stats): boolean {
  return stat.isDirectory() && !stat.isSymbolicLink() &&
    (typeof process.getuid !== 'function' || stat.uid === process.getuid()) && (Number(stat.mode) & 0o022) === 0;
}
function sameDirectory(a: Stats, b: Stats): boolean {
  return safeDirectory(a) && safeDirectory(b) && a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode;
}
function controllerInstant(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:Z|[+-](?:[01]\d|2[0-3]):?[0-5]\d)$/.test(value)) return null;
  const [year, month, day] = value.slice(0, 10).split('-').map(Number) as [number, number, number];
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}
/** Controller data is advisory only; it never enters Performance admission or pacing. */
async function readControllerMemory(root: string, nowMs: number): Promise<ResourceView['controllerMemory']> {
  try {
    const queue = join(root, 'queue'), path = join(queue, 'status.json');
    const parents = await Promise.all([lstat(root), lstat(queue)]);
    if (!parents.every(safeDirectory) || await realpath(root) !== resolve(root) || await realpath(queue) !== resolve(queue)) return undefined;
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = await handle.stat();
      if (!safeFile(before) || before.mtimeMs > nowMs || nowMs - before.mtimeMs >= MACHINE_MAX_AGE_MS) return undefined;
      const buffer = Buffer.alloc(before.size + 1); let offset = 0;
      while (offset < buffer.length) {
        const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      const after = await handle.stat(), current = await lstat(path), afterParents = await Promise.all([lstat(root), lstat(queue)]);
      if (offset !== before.size || !sameFile(before, after) || !safeFile(current) || !sameFile(before, current) ||
          !parents.every((parent, index) => sameDirectory(parent, afterParents[index]!)) ||
          await realpath(root) !== resolve(root) || await realpath(queue) !== resolve(queue)) return undefined;
      const status = resourceObject(JSON.parse(buffer.subarray(0, offset).toString('utf8'))), sample = resourceObject(status.machine_sample);
      const tick = controllerInstant(status.last_tick), started = sample.startedAtMs, free = sample.memoryPressureFreePct, swap = sample.swapUsedGiB;
      if (status.schema !== 'dispatchd.status.v1' || sample.schema !== 'dispatchd.machine-sample.v1' ||
          Object.keys(sample).sort().join(',') !== 'memoryPressureFreePct,schema,startedAtMs,swapUsedGiB' ||
          !Number.isSafeInteger(started) || Number(started) < 0 || Number(started) > nowMs || nowMs - Number(started) >= MACHINE_MAX_AGE_MS ||
          tick === null || tick > nowMs || nowMs - tick >= MACHINE_MAX_AGE_MS || tick + 1000 <= Number(started) ||
          typeof free !== 'number' || !Number.isFinite(free) || free < 0 || free > 100 ||
          !(swap === null || typeof swap === 'number' && Number.isFinite(swap) && swap >= 0)) return undefined;
      return { pressureFreePct: free, observedAt: new Date(Number(started)).toISOString() };
    } finally { await handle.close(); }
  } catch { return undefined; }
}

export async function readResourceView(directory = resourceViewDirectory(), nowMs = Date.now(),
  runsDir = process.env.ASHLR_RUNS_DIR ?? join(homedir(), '.ashlr-runs'),
  devinRead?: () => Promise<DevinUsageResult>): Promise<ResourceView> {
  const [view, controllerMemory] = await Promise.all([readFleetView(directory, nowMs, devinRead), readControllerMemory(runsDir, nowMs)]);
  return controllerMemory ? { ...view, controllerMemory } : view;
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
