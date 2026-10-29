import { execFileSync } from 'node:child_process';
import { platform } from 'node:os';
import { performance } from 'node:perf_hooks';
import { MemguardRules, type MemguardConfig, type Decision } from './rules.js';

/** sysctl vm.swapusage reports used storage in binary K/M/G/T units. */
export function parseSwapUsedBytes(output: string): number | null {
  const match = /\bused\s*=\s*(\d+(?:\.\d+)?)\s*([KMGT])\b/.exec(output);
  if (!match) return null;
  const bytes = Number(match[1]) * 1024 ** ('KMGT'.indexOf(match[2]!) + 1);
  return Number.isSafeInteger(bytes) ? bytes : Number.isFinite(bytes) && bytes >= 0
    && bytes <= Number.MAX_SAFE_INTEGER ? Math.round(bytes) : null;
}

export function parsePressureLevel(output: string): number | null {
  const value = output.trim();
  if (!/^\d+$/.test(value)) return null;
  const level = Number(value);
  return Number.isSafeInteger(level) ? level : null;
}

function readSysctl(key: string): string {
  return execFileSync('/usr/sbin/sysctl', ['-n', key], {
    encoding: 'utf8', timeout: 2000, maxBuffer: 4096, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Call once per existing bridge tick, supplying its unchanged free% and disk
 * decision. Keep the instance between ticks. This does not install a service.
 */
export function createMacMemguard(config: MemguardConfig = {}, dependencies = {
  platform: platform(), readSysctl, now: () => performance.now(),
}): (freePercent: number, diskPause: boolean) => Decision {
  if (dependencies.platform !== 'darwin') throw new Error('memguard is Mac-only');
  const rules = new MemguardRules(config);
  return (freePercent, diskPause) => {
    let pressureLevel: number | null = null;
    let swapUsedBytes: number | null = null;
    if (rules.pressureRuleEnabled) {
      // Independent reads preserve a pressure trigger if swap sampling fails.
      try { pressureLevel = parsePressureLevel(dependencies.readSysctl('kern.memorystatus_vm_pressure_level')); }
      catch { /* Missing telemetry holds dispatch below. */ }
      try { swapUsedBytes = parseSwapUsedBytes(dependencies.readSysctl('vm.swapusage')); }
      catch { /* Never treat a failed read as zero swap. */ }
    }
    return rules.evaluate({ nowMs: dependencies.now(), freePercent, diskPause, pressureLevel, swapUsedBytes });
  };
}
