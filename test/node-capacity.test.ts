import { describe, expect, it } from 'vitest';
import { assessNodeCapacity, nodeRamSlots } from '../src/core/drive/nodes/capacity.js';
import { readMacHostHeadroom, type HostHeadroom } from '../src/core/run/host-headroom.js';
const GIB = 1024 ** 3;
const normal: HostHeadroom = { freePercent: 26, swapGb: 5.8, pressureLevel: 1 };
describe('conservative node RAM and disk admission', () => {
  it('budgets the 8GB Pro and 16GB Air independently', () => {
    expect(nodeRamSlots(8 * GIB)).toBe(1);
    expect(nodeRamSlots(16 * GIB)).toBe(2);
    for (const invalid of [NaN, Infinity, -1, 0, 3 * GIB]) expect(nodeRamSlots(invalid)).toBe(0);
    expect(nodeRamSlots(1024 * GIB)).toBe(64);
  });
  it('admits normal pressure despite low raw free memory and historical swap', () => {
    expect(assessNodeCapacity(16 * GIB, normal, 20e9)).toEqual({ ramBytes: 16 * GIB, slots: 2, held: null });
    expect(assessNodeCapacity(3 * GIB, normal, 20e9).held).toBe('memory-pressure');
  });
  it.each([2, 4] as const)('holds pressure level %s regardless of free memory', (pressureLevel) => {
    for (const freePercent of [26, 100]) {
      expect(assessNodeCapacity(16 * GIB, { freePercent, swapGb: 0, pressureLevel }, 100e9).held).toBe('memory-pressure');
    }
  });
  it('retains the 20GB disk floor and fails closed for unknown disk', () => {
    for (const disk of [null, NaN, Infinity, -1]) expect(assessNodeCapacity(8 * GIB, normal, disk).held).toBe('disk-unmeasured');
    expect(assessNodeCapacity(8 * GIB, normal, 20e9 - 1).held).toBe('disk-pressure');
    expect(assessNodeCapacity(8 * GIB, normal, 20e9).slots).toBe(1);
  });
  it('fails closed for missing, malformed, or failed memory telemetry', () => {
    expect(assessNodeCapacity(8 * GIB, null, 100e9).held).toBe('memory-unmeasured');
    for (const freePercent of [NaN, -1, 101]) expect(assessNodeCapacity(8 * GIB, { ...normal, freePercent }, 100e9).held).toBe('memory-unmeasured');
    for (const swapGb of [NaN, -1]) expect(assessNodeCapacity(8 * GIB, { ...normal, swapGb }, 100e9).held).toBe('memory-unmeasured');
    for (const pressureLevel of [undefined, 0, 3]) {
      expect(assessNodeCapacity(8 * GIB, { ...normal, pressureLevel } as HostHeadroom, 100e9).held).toBe('memory-unmeasured');
    }
    const failed = readMacHostHeadroom(() => { throw new Error('unavailable'); }, 8 * GIB);
    expect(assessNodeCapacity(8 * GIB, failed, 100e9).held).toBe('memory-unmeasured');
  });
});
