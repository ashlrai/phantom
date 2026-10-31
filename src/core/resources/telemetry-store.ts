/** Dispatch-tick adapter. The external queue can call the same adapter through the sample CLI. */
import { constants } from 'node:fs';
import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { acquireLocalStoreLock, releaseLocalStoreLock, type LocalStoreLock } from '../fleet/local-store-lock.js';
import { readTelemetryFile, sampleMachine, type MachineTelemetry, type SampleMachineOptions } from './telemetry.js';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function machineTelemetryEnabled(cfg: unknown): boolean {
  return object(cfg) && object(cfg['telemetry']) && object(cfg['telemetry']['machine']) && cfg['telemetry']['machine']['enabled'] === true;
}

/** Read only the numeric baseline we need. Never propagate arbitrary persisted fields into a sample. */
function previousSample(value: unknown): MachineTelemetry | null {
  if (!object(value) || value['schemaVersion'] !== 1 || !Number.isFinite(value['sampledAtMs']) ||
      typeof value['platform'] !== 'string' || !object(value['swap']) || !object(value['cpu']) ||
      !Array.isArray(value['cpu']['perCore'])) return null;
  const usedBytes = value['swap']['usedBytes'];
  if (!(usedBytes === null || typeof usedBytes === 'number' && Number.isFinite(usedBytes) && usedBytes >= 0)) return null;
  const cores = value['cpu']['perCore'];
  if (cores.length > 4096 || cores.some(core => !object(core) || !Number.isSafeInteger(core['totalMs']) ||
      !Number.isSafeInteger(core['idleMs']) || Number(core['idleMs']) < 0 || Number(core['totalMs']) < Number(core['idleMs']))) return null;
  // Only this detached subset is consulted by sampleMachine.
  return { sampledAtMs: value['sampledAtMs'], platform: value['platform'], swap: { usedBytes },
    cpu: { perCore: cores.map(core => ({ totalMs: core['totalMs'], idleMs: core['idleMs'] })) } } as MachineTelemetry;
}

export interface DispatchTelemetryOptions extends Omit<SampleMachineOptions, 'previous'> { fleetPath?: string }

/** Disabled means no I/O. Contention or invalid state means no replacement, never an empty fleet. */
export async function sampleMachineForDispatch(cfg: unknown, options: DispatchTelemetryOptions = {}): Promise<MachineTelemetry | null> {
  if (!machineTelemetryEnabled(cfg)) return null;
  const fleetPath = options.fleetPath ?? join(homedir(), '.ashlr-runs', 'fleet.json');
  const parent = dirname(fleetPath), lockPath = `${fleetPath}.machine.lock`;
  const temporaryPath = `${fleetPath}.${randomUUID()}.tmp`;
  let lock: LocalStoreLock | null = null;
  let temporaryCreated = false;
  try {
    await mkdir(parent, { recursive: true, mode: 0o700 });
    const directory = await lstat(parent);
    if (!directory.isDirectory() || directory.isSymbolicLink() ||
        typeof process.getuid === 'function' && directory.uid !== process.getuid() || (directory.mode & 0o022) !== 0) return null;
    // Reuse the owner- and identity-checked lock, with no waiting in the dispatch hot path.
    lock = acquireLocalStoreLock(lockPath, 0, { anchorPath: parent });
    if (!lock) return null;
    async function readFleet(): Promise<{ fleet: Record<string, unknown>; raw: string | null }> {
      try {
        const stat = await lstat(fleetPath);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o022) !== 0 ||
            typeof process.getuid === 'function' && stat.uid !== process.getuid()) throw new Error('Unsafe fleet');
        const raw = await readTelemetryFile(fleetPath);
        if (raw === null) throw new Error('Unreadable fleet');
        const parsed: unknown = JSON.parse(raw);
        if (!object(parsed) || parsed['resources'] !== undefined && !object(parsed['resources'])) throw new Error('Invalid fleet');
        return { fleet: parsed, raw };
      } catch (error) {
        if (object(error) && error['code'] === 'ENOENT') return { fleet: {}, raw: null };
        throw error;
      }
    }
    const initial = await readFleet();
    const initialResources = object(initial.fleet['resources']) ? initial.fleet['resources'] : {};
    const machineConfig = (cfg as { telemetry: { machine: { estimatedJobRssBytes?: number } } }).telemetry.machine;
    const sample = await sampleMachine({ ...options, previous: previousSample(initialResources['machine']),
      estimatedJobRssBytes: options.estimatedJobRssBytes ?? machineConfig.estimatedJobRssBytes });
    // Probes may take 100 ms. Merge into the latest fleet, never the pre-probe snapshot.
    // All fleet writers must share this lock for atomic read/modify/write across processes.
    const latest = await readFleet(), fleet = latest.fleet;
    const resources = object(fleet['resources']) ? fleet['resources'] : {};
    const temporary = await open(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    temporaryCreated = true;
    try {
      await temporary.writeFile(JSON.stringify({ ...fleet, resources: { ...resources, machine: sample } }, null, 2) + '\n');
    } finally { await temporary.close(); }
    // Refuse visible races with a legacy writer that does not yet use the shared lock.
    if ((await readFleet()).raw !== latest.raw) return null;
    await rename(temporaryPath, fleetPath);
    return sample;
  } catch { return null; }
  finally {
    if (temporaryCreated) await unlink(temporaryPath).catch(() => {});
    if (lock) releaseLocalStoreLock(lock);
  }
}
