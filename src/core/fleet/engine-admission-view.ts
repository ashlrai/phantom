/** Read-only projection of Phantom's own engine launch gate. */
import { assessHostHeadroom, readMacHostHeadroom, type HostHeadroom } from '../run/host-headroom.js';

/** Kernel pressure levels controlling a fresh CLI-engine launch on macOS. */
export const ENGINE_ADMISSION_POLICY = {
  source: 'kern.memorystatus_vm_pressure_level',
  allow_level: 1,
  hold_levels: [2, 4],
} as const;

export interface EngineAdmissionView {
  /** false off macOS: the engine gate only runs there. */
  gated: boolean;
  /** The launch verdict; null where the gate does not run. */
  allowed: boolean | null;
  /** Raw unallocated and speculative pages, not freely allocatable RAM. */
  free_pct: number | null;
  swap_gb: number | null;
  pressure_level: 1 | 2 | 4 | null;
  reason: string | null;
  policy: typeof ENGINE_ADMISSION_POLICY;
}

export function engineAdmissionView(reading: HostHeadroom | null, platform: string): EngineAdmissionView {
  const policy = ENGINE_ADMISSION_POLICY;
  if (platform !== 'darwin') {
    return { gated: false, allowed: null, free_pct: null, swap_gb: null, pressure_level: null,
      reason: 'Engine memory gate runs on macOS only.', policy };
  }
  const decision = assessHostHeadroom(reading);
  return { gated: true, allowed: decision.allowed,
    free_pct: decision.reading?.freePercent ?? null,
    swap_gb: decision.reading?.swapGb ?? null,
    pressure_level: decision.reading?.pressureLevel ?? null,
    reason: decision.reason, policy };
}

/** Samples the host and projects the verdict; reader errors degrade to held. */
export function readEngineAdmission(
  read: () => HostHeadroom | null = readMacHostHeadroom,
  platform: string = process.platform,
): EngineAdmissionView {
  let reading: HostHeadroom | null = null;
  if (platform === 'darwin') {
    try { reading = read(); } catch { reading = null; }
  }
  return engineAdmissionView(reading, platform);
}
