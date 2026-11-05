import { describe, expect, it } from 'vitest';
import { assessNodeCapacity, nodeRamSlots } from '../src/core/drive/nodes/capacity.js';
const GIB = 1024 ** 3;
describe('conservative node RAM and disk admission', () => {
  it('budgets the 8GB Pro and 16GB Air independently', () => {
    expect(nodeRamSlots(8 * GIB)).toBe(1);
    expect(nodeRamSlots(16 * GIB)).toBe(2);
    for (const invalid of [NaN, Infinity, -1, 0, 3 * GIB]) expect(nodeRamSlots(invalid)).toBe(0);
    expect(nodeRamSlots(1024 * GIB)).toBe(64);
  });
  it('holds before swap and retains the 20GB disk floor', () => {
    const assess = (freePercent: number, swapGb: number, disk = 20e9) => assessNodeCapacity(16 * GIB, { freePercent, swapGb }, disk);
    expect(assess(30, 0)).toMatchObject({ slots: 2, held: null });
    expect(assess(29.9, 0).held).toBe('memory-pressure');
    expect(assess(60, 0.01).held).toBe('memory-pressure');
    expect(assess(60, 0, 20e9 - 1).held).toBe('disk-pressure');
  });
  it('fails closed for unknown or malformed telemetry', () => {
    expect(assessNodeCapacity(8 * GIB, null, 100e9).slots).toBe(0);
    for (const freePercent of [NaN, -1, 101]) expect(assessNodeCapacity(8 * GIB, { freePercent, swapGb: 0 }, 100e9).held).toBe('memory-unmeasured');
    expect(assessNodeCapacity(8 * GIB, { freePercent: 60, swapGb: 0 }, null).held).toBe('disk-unmeasured');
  });
});
