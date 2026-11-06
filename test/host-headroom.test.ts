import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { assessHostHeadroom, createHostHeadroomGate, parsePressureLevel, parseSwapUsage, parseVmStat,
  readMacHostHeadroom } from '../src/core/run/host-headroom.js';

const vm = readFileSync(new URL('./fixtures/host-headroom/vm_stat.txt', import.meta.url), 'utf8');
const swap = readFileSync(new URL('./fixtures/host-headroom/swapusage.txt', import.meta.url), 'utf8');
const total = 137438953472;

describe('recorded macOS memory telemetry', () => {
  it('uses physical free and speculative pages, excluding reclaimable and compressed pages', () => {
    expect(parseVmStat(vm, total)).toBeCloseTo((1778028 + 47124) * 16384 / total * 100);
    expect(parseSwapUsage(swap)).toBeCloseTo(19813 / 1024);
  });

  it('honors Intel page sizes and zero free pages', () => {
    expect(parseVmStat('Mach Virtual Memory Statistics: (page size of 4096 bytes)\nPages free: 0.\nPages speculative: 1.\n', 409600)).toBe(1);
  });

  it.each(['', vm.replace('Pages free:', 'Unknown:'), vm + '\nPages free: 4.\n',
    vm.replace('1778028.', '-1.'), vm.replace('16384', '0')])('rejects malformed vm_stat %s', (text) => {
    expect(parseVmStat(text, total)).toBeNull();
  });

  it.each([0, -1, NaN, Infinity, 1])('rejects invalid or inconsistent physical memory %s', (bytes) => {
    expect(parseVmStat(vm, bytes)).toBeNull();
  });

  it.each([
    ['vm.swapusage: total = 10.00G used = 8.00G free = 2.00G', 8],
    ['vm.swapusage: total = 1024K used = 512K free = 512K', 512 / 1024 ** 2],
    ['vm.swapusage: total = 1T used = 0.5T free = 0.5T', 512],
    ['vm.swapusage: total = 0.00M used = 0.00M free = 0.00M (encrypted)', 0],
  ])('normalizes swap units: %s', (text, expected) => {
    expect(parseSwapUsage(text)).toBe(expected);
  });

  it.each(['', 'used = 9G', swap.replace('19813.00M', '-1M'), swap.replace('19813.00M', '99999M'),
    swap.replace('19813.00M', '1..2M'), swap.replace('19813.00M', '1X')])('rejects malformed swap %s', (text) => {
    expect(parseSwapUsage(text)).toBeNull();
  });

  it.each([['1\n', 1], ['2\n', 2], ['4\n', 4]])('parses kernel pressure %j', (text, expected) => {
    expect(parsePressureLevel(text)).toBe(expected);
  });

  it.each(['', '0', '3', '5', '-1', '1.0', '1 garbage', '1\n2', 'normal', 'NaN'])(
    'rejects unknown or malformed kernel pressure %j', (text) => {
      expect(parsePressureLevel(text)).toBeNull();
    });

  it('collects fixed bounded telemetry commands with a fixture reader', () => {
    const read = vi.fn((file: string, args: string[]) => file === '/usr/bin/vm_stat' ? vm
      : args[0] === 'vm.swapusage' ? swap : '1\n');
    expect(readMacHostHeadroom(read, total)).toEqual({ freePercent: parseVmStat(vm, total), swapGb: 19813 / 1024, pressureLevel: 1 });
    expect(read.mock.calls).toEqual([
      ['/usr/bin/vm_stat', []], ['/usr/sbin/sysctl', ['vm.swapusage']],
      ['/usr/sbin/sysctl', ['-n', 'kern.memorystatus_vm_pressure_level']],
    ]);
  });

  it('fails closed on command errors or partial readings without exposing errors', () => {
    expect(readMacHostHeadroom(() => { throw new Error('private process details'); }, total)).toBeNull();
    expect(readMacHostHeadroom(() => vm, total)).toBeNull();
    const read = (pressure: string) => (file: string, args: string[]) => file === '/usr/bin/vm_stat' ? vm
      : args[0] === 'vm.swapusage' ? swap : pressure;
    expect(readMacHostHeadroom(read(''), total)).toBeNull();
    expect(readMacHostHeadroom(read('1 junk'), total)).toBeNull();
    expect(readMacHostHeadroom((file, args) => {
      if (args[0] === '-n') throw new Error('ETIMEDOUT private process details');
      return file === '/usr/bin/vm_stat' ? vm : swap;
    }, total)).toBeNull();
  });
});

describe('launch refusal based on kernel pressure', () => {
  it('admits normal pressure even with 26% raw free and 5.8 GiB historical swap', () => {
    expect(assessHostHeadroom({ freePercent: 26, swapGb: 5.8, pressureLevel: 1 })).toMatchObject({ allowed: true, reason: null });
  });

  it.each([2, 4] as const)('holds pressure level %s even with ample raw free and no swap', (pressureLevel) => {
    expect(assessHostHeadroom({ freePercent: 99, swapGb: 0, pressureLevel }).allowed).toBe(false);
  });

  it('samples each attempt and immediately resumes when kernel pressure returns to normal', () => {
    const read = vi.fn()
      .mockReturnValueOnce({ freePercent: 99, swapGb: 0, pressureLevel: 2 })
      .mockReturnValueOnce(null)
      .mockImplementationOnce(() => { throw new Error('unavailable'); })
      .mockReturnValueOnce({ freePercent: 26, swapGb: 5.8, pressureLevel: 1 })
      .mockReturnValueOnce({ freePercent: 99, swapGb: 0, pressureLevel: 4 });
    const gate = createHostHeadroomGate(read);
    expect([gate().allowed, gate().allowed, gate().allowed, gate().allowed, gate().allowed])
      .toEqual([false, false, false, true, false]);
    expect(read).toHaveBeenCalledTimes(5);
  });

  it.each([null, { freePercent: NaN, swapGb: 0, pressureLevel: 1 },
    { freePercent: 101, swapGb: 0, pressureLevel: 1 }, { freePercent: -1, swapGb: 0, pressureLevel: 1 },
    { freePercent: 40, swapGb: Infinity, pressureLevel: 1 }, { freePercent: 40, swapGb: -1, pressureLevel: 1 },
    { freePercent: 40, swapGb: 0 }, { freePercent: 40, swapGb: 0, pressureLevel: 0 },
    { freePercent: 40, swapGb: 0, pressureLevel: 3 }, { freePercent: 40, swapGb: 0, pressureLevel: '1' }])(
    'refuses invalid telemetry %j', (reading) => {
      expect(assessHostHeadroom(reading as Parameters<typeof assessHostHeadroom>[0]).allowed).toBe(false);
    });
});
