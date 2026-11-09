import { execFileSync } from 'node:child_process';
import { checkHostHeadroom, type HostHeadroomDecision } from '../run/host-headroom.js';
import type { DrivePressureLevel } from './supervisor.js';

/** Only a known normal kernel reading and allowed host headroom admit launches. */
export function classifyDrivePressure(kernel: string | null, headroom: HostHeadroomDecision): DrivePressureLevel {
  if (kernel === '4') return 'critical';
  if (kernel !== '1' || !headroom.allowed || !headroom.reading) return 'warning';
  return 'normal';
}

/** Dependencies are explicit for bounded-reader tests without global platform mutation. */
export interface DrivePressureReader {
  platform?: NodeJS.Platform;
  exec?: typeof execFileSync;
  headroom?: typeof checkHostHeadroom;
}

/** Keep non-Darwin admission unchanged; unknown macOS telemetry holds. */
export async function readDrivePressure(deps: DrivePressureReader = {}): Promise<DrivePressureLevel> {
  if ((deps.platform ?? process.platform) !== 'darwin') return 'normal';
  try {
    const kernel = (deps.exec ?? execFileSync)('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level'],
      { encoding: 'utf8', timeout: 1_000, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
    return classifyDrivePressure(kernel, (deps.headroom ?? checkHostHeadroom)());
  } catch { return 'warning'; }
}
