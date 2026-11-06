/** Read-only projection of Phantom's own engine launch gate (host-headroom
 *  admission). It reports the verdict a fresh launch would get right now; it
 *  never samples through the held latch, so it cannot resume or extend a hold. */
import { assessHostHeadroom, readMacHostHeadroom, type HostHeadroom } from '../run/host-headroom.js';

/** Mirrors assessHostHeadroom; tests pin these to the gate's real boundaries. */
export const ENGINE_ADMISSION_THRESHOLDS = {
  hold_below_free_pct: 30,
  hold_above_swap_gb: 8,
  resume_free_pct: 35,
  resume_swap_gb: 6,
} as const;

export interface EngineAdmissionView {
  /** false off macOS: the engine gate only runs there. */
  gated: boolean;
  /** The launch verdict; null where the gate does not run. */
  allowed: boolean | null;
  free_pct: number | null;
  swap_gb: number | null;
  /** Why a launch is held or a verdict is unavailable; null when allowed. */
  reason: string | null;
  thresholds: typeof ENGINE_ADMISSION_THRESHOLDS;
}

/** Pure verdict for one reading: held=false, since a report has no prior hold. */
export function engineAdmissionView(reading: HostHeadroom | null, platform: string): EngineAdmissionView {
  const thresholds = ENGINE_ADMISSION_THRESHOLDS;
  if (platform !== 'darwin') {
    return { gated: false, allowed: null, free_pct: null, swap_gb: null,
      reason: 'Engine memory gate runs on macOS only.', thresholds };
  }
  const decision = assessHostHeadroom(reading, false);
  return { gated: true, allowed: decision.allowed,
    free_pct: decision.reading?.freePercent ?? null,
    swap_gb: decision.reading?.swapGb ?? null,
    reason: decision.reason, thresholds };
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
