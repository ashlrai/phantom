import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { assessHostHeadroom, createHostHeadroomGate, parseSwapUsage, parseVmStat,
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

  it('collects both fixed commands with a fixture reader', () => {
    const read = vi.fn((file: string) => file === '/usr/bin/vm_stat' ? vm : swap);
    expect(readMacHostHeadroom(read, total)).toEqual({ freePercent: parseVmStat(vm, total), swapGb: 19813 / 1024 });
    expect(read.mock.calls).toEqual([['/usr/bin/vm_stat', []], ['/usr/sbin/sysctl', ['vm.swapusage']]]);
  });

  it('fails closed on command errors or partial readings without exposing errors', () => {
    expect(readMacHostHeadroom(() => { throw new Error('private process details'); }, total)).toBeNull();
    expect(readMacHostHeadroom(() => vm, total)).toBeNull();
  });
});

describe('launch refusal and hysteresis', () => {
  it.each([[29.99, 0, false], [60, 8.01, false], [30, 8, true], [100, 0, true]])(
    'free %s swap %s allows %s', (freePercent, swapGb, allowed) => {
      expect(assessHostHeadroom({ freePercent, swapGb }).allowed).toBe(allowed);
    });

  it('holds every lane through the deadband and resumes only when both metrics recover', () => {
    let reading = { freePercent: 40, swapGb: 9 };
    const gate = createHostHeadroomGate(() => reading);
    expect(gate().allowed).toBe(false);
    for (const next of [{ freePercent: 40, swapGb: 8 }, { freePercent: 40, swapGb: 6.01 },
      { freePercent: 34.99, swapGb: 6 }]) {
      reading = next;
      expect(gate().allowed).toBe(false);
    }
    reading = { freePercent: 35, swapGb: 6 };
    expect(gate().allowed).toBe(true);
    reading = { freePercent: 30, swapGb: 8 };
    expect(gate().allowed).toBe(true);
    reading = { freePercent: 29, swapGb: 0 };
    expect(gate().allowed).toBe(false);
    reading = { freePercent: 32, swapGb: 0 };
    expect(gate().allowed).toBe(false);
    reading = { freePercent: 35, swapGb: 0 };
    expect(gate().allowed).toBe(true);
  });

  it('keeps the recovery latch through unknown telemetry and reader exceptions', () => {
    const read = vi.fn().mockReturnValueOnce(null).mockImplementationOnce(() => { throw new Error('unavailable'); })
      .mockReturnValueOnce({ freePercent: 32, swapGb: 7 }).mockReturnValue({ freePercent: 35, swapGb: 6 });
    const gate = createHostHeadroomGate(read);
    expect(gate().allowed).toBe(false);
    expect(gate().allowed).toBe(false);
    expect(gate().allowed).toBe(false);
    expect(gate().allowed).toBe(true);
  });

  it.each([null, { freePercent: NaN, swapGb: 0 }, { freePercent: 101, swapGb: 0 },
    { freePercent: -1, swapGb: 0 }, { freePercent: 40, swapGb: Infinity }, { freePercent: 40, swapGb: -1 }])(
    'refuses invalid telemetry %j', (reading) => { expect(assessHostHeadroom(reading).allowed).toBe(false); });
});
