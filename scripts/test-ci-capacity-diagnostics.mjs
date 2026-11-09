import { execFileSync } from 'node:child_process';
import { availableParallelism, freemem, totalmem } from 'node:os';

const command = (file, args) => execFileSync(file, args, {
  encoding: 'utf8', timeout: 1_000, maxBuffer: 64 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
});

/** Numeric observations only; these adjacent samples never change the worker policy. */
export function darwinCapacityDiagnostics(options = {}) {
  const read = options.read ?? command;
  const finite = value => Number.isFinite(value) && value >= 0 ? value : null;
  const result = {
    schema: 'phantom-test-capacity/v1', sample: 'after-worker-policy',
    cpuCount: finite(options.cpuCount ?? availableParallelism()),
    totalBytes: finite(options.totalBytes ?? totalmem()),
    rawFreeBytes: finite(options.rawFreeBytes ?? freemem()),
    availableBytes: finite(options.availableBytes ?? process.availableMemory?.()),
    vmFreeBytes: null, inactiveBytes: null, speculativeBytes: null, purgeableBytes: null, pressureLevel: null,
  };
  try {
    const vm = read('/usr/bin/vm_stat', []);
    const page = Number(vm.match(/\(page size of (\d+) bytes\)/)?.[1]);
    for (const [name, field] of [['free', 'vmFreeBytes'], ['inactive', 'inactiveBytes'],
      ['speculative', 'speculativeBytes'], ['purgeable', 'purgeableBytes']]) {
      const values = [...vm.matchAll(new RegExp(`^Pages ${name}:\\s+(\\d+)\\.\\s*$`, 'gm'))];
      const count = values.length === 1 ? Number(values[0][1]) : NaN;
      const bytes = count * page;
      if (Number.isSafeInteger(page) && page > 0 && Number.isSafeInteger(count) && count >= 0 &&
          Number.isSafeInteger(bytes) && bytes <= result.totalBytes) result[field] = bytes;
    }
  } catch { /* No command output or error details leave this diagnostic. */ }
  try {
    const level = read('/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']).trim();
    result.pressureLevel = ['1', '2', '4'].includes(level) ? Number(level) : null;
  } catch { /* Unknown pressure stays explicit and does not alter admission. */ }
  return result;
}
