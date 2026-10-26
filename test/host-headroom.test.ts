import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { assessHostHeadroom, createHostHeadroomGate, parseSwapUsage, parseVmStat,
  readMacHostHeadroom, HOST_SWAP_WINDOW_MS } from '../src/core/run/host-headroom.js';

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

describe('launch refusal from recent swap growth', () => {
  it.each([[0, true], [2, true], [2.01, false]])('growth %s allows %s', (growth, allowed) => {
    expect(assessHostHeadroom({ freePercent: 0, swapGb: 19.35 }, growth).allowed).toBe(allowed);
  });

  it('allows the recorded stale swap with low free pages and flat growth', () => {
    let at = 0;
    const gate = createHostHeadroomGate(() => readMacHostHeadroom(file => file === '/usr/bin/vm_stat' ? vm : swap, total), () => at);
    expect(gate().allowed).toBe(true);
    at = HOST_SWAP_WINDOW_MS / 2;
    expect(gate().allowed).toBe(true);
    at = HOST_SWAP_WINDOW_MS;
    expect(gate().allowed).toBe(true);
  });

  it('holds on growth, shares the window across attempts, and recovers without draining stale swap', () => {
    let at = 0;
    let swapGb = 19.35;
    const gate = createHostHeadroomGate(() => ({ freePercent: 1, swapGb }), () => at);
    expect(gate().allowed).toBe(true);
    at = 60_000;
    swapGb += 2.01;
    expect(gate()).toMatchObject({ allowed: false, reason: expect.stringContaining('within 10 minutes') });
    at = HOST_SWAP_WINDOW_MS;
    expect(gate().allowed).toBe(false);
    at += 1;
    expect(gate().allowed).toBe(true);
    expect(swapGb).toBeGreaterThan(19.35);
  });

  it('recovers when swap falls, and detects growth from a later low point', () => {
    let at = 0;
    let swapGb = 19.35;
    const gate = createHostHeadroomGate(() => ({ freePercent: 1, swapGb }), () => at);
    expect(gate().allowed).toBe(true);
    at = 1000; swapGb = 18;
    expect(gate().allowed).toBe(true);
    at = 2000; swapGb = 20.01;
    expect(gate().allowed).toBe(false);
    at = 3000; swapGb = 20;
    expect(gate().allowed).toBe(true);
  });

  it('detects growth within one second even after many attempts', () => {
    let at = 0;
    let swapGb = 19.35;
    const gate = createHostHeadroomGate(() => ({ freePercent: 1, swapGb }), () => at);
    expect(gate().allowed).toBe(true);
    for (let i = 1; i <= 1500; i++) {
      at = i / 2;
      swapGb = 19.35 + i / 500;
      expect(gate().allowed).toBe(i <= 1000);
    }
  });

  it('never holds on an expired minimum from a partially expired second', () => {
    let at = 0;
    let swapGb = 19.35;
    const gate = createHostHeadroomGate(() => ({ freePercent: 1, swapGb }), () => at);
    expect(gate().allowed).toBe(true);
    at = 500; swapGb = 20;
    expect(gate().allowed).toBe(true);
    at = 1000; swapGb = 21.5;
    expect(gate().allowed).toBe(false);
    at = HOST_SWAP_WINDOW_MS + 1;
    expect(gate().allowed).toBe(true);
    at += HOST_SWAP_WINDOW_MS;
    expect(gate().allowed).toBe(true);
  });

  it('does not extrapolate growth across an idle gap longer than the window', () => {
    let at = 0;
    let swapGb = 0;
    const gate = createHostHeadroomGate(() => ({ freePercent: 1, swapGb }), () => at);
    expect(gate().allowed).toBe(true);
    at = HOST_SWAP_WINDOW_MS + 1; swapGb = 19.35;
    expect(gate().allowed).toBe(true);
  });

  it('retains evidence through unavailable readings but does not latch an unknown sample forever', () => {
    let at = 0;
    const read = vi.fn().mockReturnValueOnce({ freePercent: 1, swapGb: 19.35 })
      .mockReturnValueOnce(null).mockImplementationOnce(() => { throw new Error('unavailable'); })
      .mockReturnValue({ freePercent: 1, swapGb: 22 });
    const gate = createHostHeadroomGate(read, () => at);
    expect(gate().allowed).toBe(true);
    at = 1000;
    expect(gate().allowed).toBe(false);
    expect(gate().allowed).toBe(false);
    expect(gate().allowed).toBe(false);
    at = HOST_SWAP_WINDOW_MS + 1;
    expect(gate().allowed).toBe(true);
  });

  it('rejects an invalid clock and resets the window on clock rollback', () => {
    let at = 1000;
    let swapGb = 0;
    const gate = createHostHeadroomGate(() => ({ freePercent: 1, swapGb }), () => at);
    expect(gate().allowed).toBe(true);
    at = NaN;
    expect(gate().allowed).toBe(false);
    at = 2000; swapGb = 3;
    expect(gate().allowed).toBe(false);
    at = 0;
    expect(gate().allowed).toBe(true);
  });

  it.each([null, { freePercent: NaN, swapGb: 0 }, { freePercent: 101, swapGb: 0 },
    { freePercent: -1, swapGb: 0 }, { freePercent: 40, swapGb: Infinity }, { freePercent: 40, swapGb: -1 }])(
    'refuses invalid telemetry %j', (reading) => { expect(assessHostHeadroom(reading).allowed).toBe(false); });

  it.each([NaN, Infinity, -1])('refuses invalid growth %s', growth => {
    expect(assessHostHeadroom({ freePercent: 40, swapGb: 1 }, growth).allowed).toBe(false);
  });
});
