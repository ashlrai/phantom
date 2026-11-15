import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface FleetMachine {
  schema: 'fleet.machine.v1';
  load1: number | null;
  cpus: number | null;
  loadPerCpu: number | null;
  overloaded: boolean | null;
  swapGb: number | null;
  diskFreeGb: number | null;
  worktrees: number | null;
  runningWorkers: number | null;
}

const object = (v: unknown): Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const number = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
const count = (v: unknown): number | null => { const n = number(v); return n !== null && Number.isSafeInteger(n) ? n : null; };

export function projectFleetMachine(value: unknown): FleetMachine {
  const status = object(value), admission = object(status.admission), disk = object(object(status.autopilot).disk);
  const load1 = number(admission.load1), cpuCount = count(admission.ncpu);
  const cpus = cpuCount && cpuCount > 0 ? cpuCount : null;
  const loadPerCpu = load1 !== null && cpus !== null ? load1 / cpus : null;
  return { schema: 'fleet.machine.v1', load1, cpus, loadPerCpu,
    overloaded: loadPerCpu === null ? null : loadPerCpu > 4,
    swapGb: number(admission.swap_gb) ?? number(status.swap_gb),
    diskFreeGb: number(admission.disk_free_gb) ?? number(disk.free_gb),
    worktrees: count(admission.worktrees), runningWorkers: count(admission.running) };
}

export async function readFleetMachine(path = join(homedir(), '.ashlr-runs', 'queue', 'status.json')): Promise<FleetMachine> {
  try { return projectFleetMachine(JSON.parse(await readFile(path, 'utf8'))); }
  catch { return projectFleetMachine(null); }
}
