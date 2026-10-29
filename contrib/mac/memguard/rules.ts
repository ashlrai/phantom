/** Mac memguard policy. The existing bridge owns free-memory and disk sampling. */
export interface MemguardConfig {
  pressureRuleEnabled?: boolean;
}

export const DEFAULT_CONFIG = Object.freeze({ pressureRuleEnabled: false });
export const SWAP_WINDOW_MS = 10 * 60 * 1000;
// GB means decimal bytes. Do not silently substitute GiB.
export const SWAP_GROWTH_BYTES = 2_000_000_000;

export interface Sample {
  /** Monotonic milliseconds, from the same clock for this evaluator's lifetime. */
  nowMs: number;
  freePercent: number;
  /** Required result of the bridge's unchanged disk rule. */
  diskPause: boolean;
  /** Raw kern.memorystatus_vm_pressure_level, not XNU's internal enum. */
  pressureLevel?: number | null;
  swapUsedBytes?: number | null;
}

export type PauseReason = 'free-hard' | 'disk' | 'free-interim' |
  'pressure' | 'swap-growth' | 'telemetry-unavailable';

export interface Decision {
  pause: boolean;
  reasons: PauseReason[];
  swapGrowthBytes: number;
}

function nonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** One instance per monitor lifetime. No disk writes, signals, or resume actions. */
export class MemguardRules {
  readonly pressureRuleEnabled: boolean;
  private history: { nowMs: number; bytes: number }[] = [];
  private lastTime: number | undefined;

  constructor(config: MemguardConfig = DEFAULT_CONFIG) {
    if (config.pressureRuleEnabled !== undefined && typeof config.pressureRuleEnabled !== 'boolean') {
      throw new TypeError('pressureRuleEnabled must be a boolean');
    }
    this.pressureRuleEnabled = config.pressureRuleEnabled ?? DEFAULT_CONFIG.pressureRuleEnabled;
  }

  evaluate(sample: Sample): Decision {
    const reasons: PauseReason[] = [];
    const freeValid = nonnegative(sample.freePercent) && sample.freePercent <= 100;
    if (freeValid && sample.freePercent < 25) reasons.push('free-hard');
    if (sample.diskPause === true) reasons.push('disk');
    if (!freeValid || typeof sample.diskPause !== 'boolean') reasons.push('telemetry-unavailable');

    let swapGrowthBytes = 0;
    if (!this.pressureRuleEnabled) {
      if (freeValid && sample.freePercent < 35) reasons.push('free-interim');
    } else {
      const pressureValid = nonnegative(sample.pressureLevel) && Number.isSafeInteger(sample.pressureLevel);
      if (pressureValid && sample.pressureLevel! >= 2) reasons.push('pressure');
      const swapValid = nonnegative(sample.swapUsedBytes) && Number.isSafeInteger(sample.swapUsedBytes);
      const timeValid = nonnegative(sample.nowMs);
      if (!pressureValid || !swapValid || !timeValid) {
        if (!reasons.includes('telemetry-unavailable')) reasons.push('telemetry-unavailable');
      }
      // Never compare readings across a clock reset or an unreadable sample.
      if (!swapValid || !timeValid || (this.lastTime !== undefined && sample.nowMs < this.lastTime)) {
        this.history = [];
      }
      if (timeValid) this.lastTime = sample.nowMs;
      if (swapValid && timeValid) {
        this.history = this.history.filter(point => sample.nowMs - point.nowMs <= SWAP_WINDOW_MS);
        const minimum = this.history[0];
        if (minimum) swapGrowthBytes = Math.max(0, sample.swapUsedBytes! - minimum.bytes);
        if (swapGrowthBytes > SWAP_GROWTH_BYTES) reasons.push('swap-growth');
        // Keep only minima that can matter to a later comparison. This also
        // coalesces unchanged swap readings while retaining their latest time.
        while (this.history.length && this.history[this.history.length - 1]!.bytes >= sample.swapUsedBytes!) {
          this.history.pop();
        }
        this.history.push({ nowMs: sample.nowMs, bytes: sample.swapUsedBytes! });
      }
    }
    return { pause: reasons.length > 0, reasons, swapGrowthBytes };
  }
}
