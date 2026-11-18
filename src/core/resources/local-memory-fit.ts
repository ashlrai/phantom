import { closeSync, constants, fstatSync, openSync, readSync } from 'node:fs';
import { freemem, homedir, totalmem } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

const bytes = z.number().finite().nonnegative();
const modelSchema = z.object({ id: z.string().regex(/^[\w.:/-]{1,200}$/), engine: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/), residentBytes: bytes.nullable() });
const machineSchema = z.object({ sampledAtMs: bytes, ram: z.object({ totalBytes: bytes.positive(), freeBytes: bytes }),
  swap: z.object({ growthBytesPerSecond: bytes.nullable() }) });
export interface MemoryFit {
  model: string; residentBytes: number | null; contextBytes: number | null; requiredBytes: number | null;
  freeBytes: number | null; verdict: 'fits' | 'does-not-fit' | 'swap-growing' | 'unknown'; reason: string;
}
export const isLocalModel = (engine: string): boolean => /^(local(?:-.*)?|codex-local|omlx|mlx|llama-server|ollama|lmstudio)$/.test(engine);
const gb = (value: number | null): string => value === null ? 'unknown' : (value / 1024 ** 3).toFixed(1);

/** Charge the full resident estimate, even if already loaded: no unverified residency credit.
 * Reserve at least 2 GiB for KV/runtime, scaling by 256 KiB per context token.
 */
export function memoryFit(model: string, residentBytes: number | null, contextTokens: number,
  memory: { totalBytes: number; freeBytes: number; swapGrowth: number | null } | null): MemoryFit {
  const resident = bytes.positive().safeParse(residentBytes);
  const contextBytes = Number.isSafeInteger(contextTokens) && contextTokens >= 0 ? Math.max(2 * 1024 ** 3, contextTokens * 256 * 1024) : null;
  const requiredBytes = resident.success && contextBytes !== null ? resident.data + contextBytes : null;
  const valid = memory !== null && Number.isFinite(memory.totalBytes) && memory.totalBytes > 0 &&
    Number.isFinite(memory.freeBytes) && memory.freeBytes >= 0 && memory.freeBytes <= memory.totalBytes;
  const verdict = !valid ? 'unknown' : memory.swapGrowth !== null && memory.swapGrowth > 0 ? 'swap-growing'
    : requiredBytes === null || memory.swapGrowth === null || !Number.isFinite(memory.swapGrowth) || memory.swapGrowth < 0 ? 'unknown'
    : memory.freeBytes - requiredBytes < memory.totalBytes * 0.25 ? 'does-not-fit' : 'fits';
  const freeBytes = valid ? memory.freeBytes : null;
  const detail = verdict === 'fits' ? 'fits with 25% memory free' : verdict === 'swap-growing' ? 'swap is growing'
    : verdict === 'unknown' ? 'memory fit is unknown' : 'would leave less than 25% memory free';
  return { model, residentBytes: resident.success ? resident.data : null, contextBytes, requiredBytes, freeBytes, verdict,
    reason: `local model ${model} needs ${requiredBytes === null ? 'unknown' : '~' + gb(requiredBytes) + ' GB'}, ${gb(freeBytes)} GB free: ${detail}` };
}

/** Bounded metadata reads only; no model load, unload, network, or credential access. */
function resources(path: string): Record<string, unknown> {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 2 * 1024 ** 2) return {};
    const buffer = Buffer.alloc(2 * 1024 ** 2 + 1), size = readSync(fd, buffer, 0, buffer.length, 0);
    if (size >= buffer.length) return {};
    return z.object({ resources: z.record(z.string(), z.unknown()) }).parse(JSON.parse(buffer.subarray(0, size).toString())).resources;
  } catch { return {}; } finally { if (fd !== undefined) closeSync(fd); }
}

export function localMemorySnapshot(root = join(homedir(), '.ashlr-runs'), now = Date.now()) {
  const source = resources(join(root, 'fleet.json'));
  const machine = machineSchema.safeParse(source.machine);
  const fresh = machine.success && now >= machine.data.sampledAtMs && now - machine.data.sampledAtMs <= 30_000;
  const memory = fresh ? { totalBytes: Math.max(totalmem(), machine.data.ram.totalBytes),
    freeBytes: Math.min(freemem(), machine.data.ram.freeBytes), swapGrowth: machine.data.swap.growthBytesPerSecond } : null;
  const inventory = source.models ?? resources(join(root, '..', '.ashlr', 'fleet.json')).models;
  const parsed = z.object({ models: z.array(modelSchema).max(256) }).safeParse(inventory);
  return { memory, models: parsed.success ? parsed.data.models : [] };
}

export function localModelFit(model: string | null, contextTokens = 65536, snapshot = localMemorySnapshot()): MemoryFit {
  const rows = snapshot.models.filter(row => row.id === model);
  // Conflicting runtimes/quantizations use the largest measurement; unknown remains unknown.
  const size = rows.length && rows.every(row => row.residentBytes !== null)
    ? Math.max(...rows.map(row => row.residentBytes!)) : null;
  return memoryFit(model ?? 'unknown', size, contextTokens, snapshot.memory);
}

export function localModelsVitals(root?: string, now?: number) {
  const snapshot = localMemorySnapshot(root, now);
  return { loaded_models: null, last_unload_reason: null,
    models: snapshot.models.map(row => ({ engine: row.engine, loaded: null, ...localModelFit(row.id, 65536, snapshot) })) };
}
