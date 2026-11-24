/** `phm host memory`: canned readings in, one typed report out. Nothing here reads the real home or the real machine. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { cmdHost } from '../src/cli/host.js';
import { buildHostMemory, memoryVerdict, readHostMemory, type HostMemoryInput } from '../src/core/fleet/host-memory.js';

const NOW = 1_800_000_000_000;
const TOTAL = 16 * 1024 ** 3;
const PAGE = 16384;
/** vm_stat text where `freePct` of RAM is free pages. */
const vmStat = (freePct: number): string =>
  `Mach Virtual Memory Statistics: (page size of ${PAGE} bytes)\nPages free: ${Math.round((TOTAL / PAGE) * freePct / 100)}.\nPages speculative: 0.\n`;
const swap = (usedGb: number): string => `vm.swapusage: total = 8192.00M  used = ${(usedGb * 1024).toFixed(2)}M  free = ${((8 - usedGb) * 1024).toFixed(2)}M  (encrypted)`;
const ps = [
  '  PID  PPID  %CPU    RSS COMM',
  '  10     1   1.0 4194304 /Applications/Big.app/Contents/MacOS/Big',
  '  11     1   1.0 2097152 /usr/bin/node',
  '  12     1   1.0 1048576 /usr/bin/python3',
  '  13     1   1.0  524288 /bin/zsh',
  '  14     1   1.0  262144 /usr/bin/ssh',
  '  15     1   1.0  131072 /usr/bin/tiny',
].join('\n');
const memstat = (swapouts: number | null, ageMs = 1000) => ({ ts: new Date(NOW - ageMs).toISOString(), free_pct: 75, swap_gb: 6.25, swapouts_per_min: swapouts, disk_gb: 100 });
/** Dispatcher swap samples: swap was 1 GB lower five minutes ago, so it grew ~200 MB per minute... scaled by `gbGrown`. */
const admission = (nowGb: number, gbGrown: number) => ({ swap_samples: [[NOW / 1000 - 300, nowGb - gbGrown]] });
const base: HostMemoryInput = { psText: ps, vmStatText: vmStat(75), swapText: swap(6.25), totalBytes: TOTAL, memstat: memstat(0), admission: admission(6.25, 5), now: NOW };

describe('host memory verdict', () => {
  it('swap growing with 75% free and no swapouts is a false alarm', () => {
    const report = buildHostMemory(base);
    expect(report.freePercent).toBe(75);
    expect(report.swapoutsPerMin).toBe(0);
    expect(report.swapGrowthMbPerMin).toBe(1024);
    expect(report.verdict).toBe('false-alarm');
    expect(report.summary).toContain('swap is growing but memory is free (likely a false alarm)'.replace('swap', 'Swap'));
    expect(report.gaps).toEqual([]);
  });

  it('low free memory with swapouts is real pressure', () => {
    const report = buildHostMemory({ ...base, vmStatText: vmStat(10), memstat: memstat(250) });
    expect(report.verdict).toBe('real-pressure');
    expect(report.summary).toMatch(/^Real pressure/);
  });

  it('swapouts alone are real pressure, and low free alone is real pressure', () => {
    expect(buildHostMemory({ ...base, memstat: memstat(3) }).verdict).toBe('real-pressure');
    expect(buildHostMemory({ ...base, vmStatText: vmStat(20) }).verdict).toBe('real-pressure');
  });

  it('free memory and steady swap is fine', () => {
    const report = buildHostMemory({ ...base, admission: admission(6.25, 0) });
    expect(report.swapGrowthMbPerMin).toBe(0);
    expect(report.verdict).toBe('fine');
  });

  it('missing samples are unknown, not zero', () => {
    const report = buildHostMemory({ psText: null, vmStatText: null, swapText: null, totalBytes: TOTAL, memstat: null, admission: null, now: NOW });
    expect(report).toMatchObject({ verdict: 'unknown', freePercent: null, swapUsedGb: null, swapGrowthMbPerMin: null, swapoutsPerMin: null, topProcesses: [] });
    expect(report.gaps).toHaveLength(5);
  });

  it('growing swap with free memory but unknown swapouts is unknown, and a stale memstat is not used', () => {
    expect(buildHostMemory({ ...base, memstat: memstat(0, 10 * 60_000) }).verdict).toBe('unknown');
    expect(buildHostMemory({ ...base, memstat: null }).swapoutsPerMin).toBeNull();
  });

  it('falls back to a fresh memstat when vm_stat is unreadable', () => {
    const report = buildHostMemory({ ...base, vmStatText: null, swapText: null });
    expect(report).toMatchObject({ freePercent: 75, swapUsedGb: 6.25 });
  });

  it('lists the 5 largest processes by memory, biggest first', () => {
    const { topProcesses } = buildHostMemory(base);
    expect(topProcesses.map(p => [p.name, p.memoryMb])).toEqual([['Big', 4096], ['node', 2048], ['python3', 1024], ['zsh', 512], ['ssh', 256]]);
  });

  it('memoryVerdict boundaries', () => {
    const v = (freePercent: number | null, swapoutsPerMin: number | null, swapGrowthMbPerMin: number | null) => memoryVerdict({ freePercent, swapoutsPerMin, swapGrowthMbPerMin });
    expect(v(35, 0, 5000)).toBe('false-alarm');
    expect(v(34.9, 0, 0)).toBe('real-pressure');
    expect(v(80, 0, null)).toBe('fine');
    expect(v(80, 0, 399)).toBe('fine');
    expect(v(null, 5, null)).toBe('real-pressure');
    expect(v(null, 0, 5000)).toBe('unknown');
  });
});

describe('phm host memory', () => {
  const runsDir = mkdtempSync(join(tmpdir(), 'host-memory-'));
  writeFileSync(join(runsDir, 'memstat.json'), JSON.stringify(memstat(0)));
  afterAll(() => { rmSync(runsDir, { recursive: true, force: true }); });
  const deps = (over: Record<string, unknown> = {}) => ({
    ps: async () => ps, run: async (_f: string, args: string[]) => args[0] === 'vm.swapusage' ? swap(6.25) : vmStat(75),
    runsDir, totalBytes: TOTAL, now: () => NOW,
    readAdmission: async () => JSON.stringify(admission(6.25, 5)), ...over,
  });
  const run = async (args: string[], over = {}) => { const out: string[] = []; const code = await cmdHost(args, { ...deps(over), write: t => { out.push(t); } }); return { code, text: out.join('') }; };

  it('--json carries a schema id and the typed fields', async () => {
    const { code, text } = await run(['memory', '--json']);
    const report = JSON.parse(text);
    expect(code).toBe(0);
    expect(report).toMatchObject({ schema: 'host.memory.v1', verdict: 'false-alarm', freePercent: 75, swapUsedGb: 6.3 });
    expect(report.topProcesses).toHaveLength(5);
  });

  it('prints plain words', async () => {
    const { code, text } = await run(['memory']);
    expect(code).toBe(0);
    expect(text).toContain('Swap is growing but memory is free (likely a false alarm)');
    expect(text).toContain('Free memory: 75%');
    expect(text).toContain('Largest by memory:');
  });

  it('says unknown and exits 1 when nothing can be read', async () => {
    const { code, text } = await run(['memory'], { ps: async () => null, run: async () => null, readAdmission: async () => null, runsDir: '/nonexistent-runs-dir' });
    expect(code).toBe(1);
    expect(text).toContain('Free memory: unknown');
  });

  it('rejects bad flags with exit 2', async () => {
    expect((await run(['memory', '--kill'])).code).toBe(2);
    expect((await run(['memory', '--json', '--json'])).code).toBe(2);
  });

  it('readHostMemory never throws when readers fail', async () => {
    const report = await readHostMemory({ ps: async () => { throw new Error('x'); }, run: async () => { throw new Error('x'); }, readAdmission: async () => { throw new Error('x'); }, runsDir: '/nonexistent-runs-dir', now: () => NOW });
    expect(report.verdict).toBe('unknown');
  });
});
