import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  buildLanePressure, decideLaneMemory, laneMemoryClass, laneMemoryLine, pressureLevel, readLanePressure,
} from '../src/core/fleet/lane-memory-pressure.js';
import { cmdLanes } from '../src/cli/lanes.js';

const codexLocal = { lane: 'codex-local', target: 8, floor: 1 };
const claude = { lane: 'claude', target: 8, floor: 1 };
const mem = (freePercent: number | null, extra: { swapGrowthMbPerMin?: number | null; swapoutsPerMin?: number | null } = {}) =>
  ({ freePercent, swapGrowthMbPerMin: null, swapoutsPerMin: null, ...extra });

describe('pressure level', () => {
  it('maps free memory to levels', () => {
    expect(pressureLevel(mem(60))).toBe('normal');
    expect(pressureLevel(mem(31))).toBe('warning');
    expect(pressureLevel(mem(14))).toBe('critical');
    expect(pressureLevel(mem(null))).toBe('unknown');
  });
  it('fast swap growth is critical only while memory is short', () => {
    expect(pressureLevel(mem(30, { swapGrowthMbPerMin: 900 }))).toBe('critical');
    expect(pressureLevel(mem(60, { swapGrowthMbPerMin: 900 }))).toBe('normal');
  });
});

describe('lane memory class', () => {
  it('defaults codex-local to local, everything else (unknown lanes too) to cloud, config wins', () => {
    expect(laneMemoryClass('codex-local')).toBe('local');
    expect(laneMemoryClass('claude')).toBe('cloud');
    expect(laneMemoryClass('some-new-lane')).toBe('cloud');
    expect(laneMemoryClass('gemini', 'local')).toBe('local');
    expect(laneMemoryClass('codex-local', 'cloud')).toBe('cloud');
    expect(laneMemoryClass('codex-local', 'nonsense')).toBe('local');
  });
});

describe('decideLaneMemory', () => {
  it('warning throttles local only: half first, then the floor', () => {
    expect(decideLaneMemory('warning', codexLocal)).toMatchObject({ allowed: 4, throttled: true, class: 'local' });
    expect(decideLaneMemory('warning', codexLocal, { warningMinutes: 10 })).toMatchObject({ allowed: 1, throttled: true });
    expect(decideLaneMemory('warning', claude)).toMatchObject({ allowed: 8, throttled: false, class: 'cloud' });
    expect(decideLaneMemory('warning', { lane: 'new-lane', target: 3, floor: 1 })).toMatchObject({ allowed: 3, throttled: false });
  });
  it('half never goes under the floor', () => {
    expect(decideLaneMemory('warning', { lane: 'codex-local', target: 3, floor: 2 }).allowed).toBe(2);
  });
  it('critical stops local and halves cloud, never down to 1 from a larger target', () => {
    expect(decideLaneMemory('critical', codexLocal)).toMatchObject({ allowed: 0, throttled: true });
    expect(decideLaneMemory('critical', claude)).toMatchObject({ allowed: 4, throttled: true });
    expect(decideLaneMemory('critical', { lane: 'claude', target: 1, floor: 1 })).toMatchObject({ allowed: 1, throttled: false });
  });
  it('recovery restores every target', () => {
    for (const lane of [codexLocal, claude]) {
      expect(decideLaneMemory('normal', lane)).toMatchObject({ allowed: 8, throttled: false });
      expect(decideLaneMemory('unknown', lane)).toMatchObject({ allowed: 8, throttled: false });
    }
  });
});

describe('wording', () => {
  const line = (level: Parameters<typeof decideLaneMemory>[0], lane: typeof claude, free: number | null, minutes = 0) =>
    laneMemoryLine(decideLaneMemory(level, lane, { warningMinutes: minutes }), free);
  it('says it in plain words', () => {
    expect(line('warning', { lane: 'codex-local', target: 4, floor: 1 }, 31)).toBe('codex-local: held at 2 of 4, memory 31% free (warning)');
    expect(line('warning', claude, 31)).toBe('claude: not throttled, cloud lane (memory 31% free, warning)');
    expect(line('normal', claude, 70)).toBe('claude: not throttled, cloud lane');
    expect(line('normal', codexLocal, 70)).toBe('codex-local: not throttled, memory 70% free');
    expect(line('critical', codexLocal, 12)).toBe('codex-local: held at 0 of 8, memory 12% free (critical), no new launches');
    expect(line('critical', claude, 12)).toBe('claude: held at 4 of 8, memory 12% free (critical)');
  });
});

describe('buildLanePressure', () => {
  it('reports every lane sorted, with a gap when memory is unknown', () => {
    const report = buildLanePressure({ now: 0, memory: mem(null), lanes: [claude, codexLocal] });
    expect(report.schema).toBe('lanes.pressure.v1');
    expect(report.lanes.map(l => l.lane)).toEqual(['claude', 'codex-local']);
    expect(report.gaps.join(' ')).toContain('no lane is throttled');
  });
});

describe('phm lanes pressure', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true })));
  });
  async function runsDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'lane-pressure-'));
    dirs.push(dir);
    await mkdir(join(dir, 'queue'));
    await writeFile(join(dir, 'queue', 'slots.json'), JSON.stringify({
      claude: { target: 8, floor: 1, ceiling: 12 },
      'codex-local': { target: 4, floor: 1, ceiling: 8 },
      gemini: { target: 2, floor: 1, ceiling: 4, memory_class: 'local' },
    }));
    return dir;
  }
  /** vm_stat text where `freePct` percent of 1000 pages are free. */
  const vmStat = (freePct: number): string =>
    `Mach Virtual Memory Statistics: (page size of 16384 bytes)\nPages free: ${freePct * 10}.\nPages inactive: 0.\nPages speculative: 0.\nPages purgeable: 0.\n`;

  it('reads lane config and a free-memory reading end to end', async () => {
    const dir = await runsDir();
    const report = await readLanePressure({
      runsDir: dir, now: () => 1_000_000, ps: async () => null, totalBytes: 1000 * 16384,
      run: async (file) => file.endsWith('vm_stat') ? vmStat(31) : null,
    });
    expect(report.level).toBe('warning');
    const by = Object.fromEntries(report.lanes.map(l => [l.lane, l]));
    expect(by['codex-local']).toMatchObject({ class: 'local', allowed: 2, throttled: true });
    expect(by['gemini']).toMatchObject({ class: 'local', allowed: 1, throttled: true });
    expect(by['claude']).toMatchObject({ class: 'cloud', allowed: 8, throttled: false });
  });

  it('prints one line per lane and usage on bad flags', async () => {
    const dir = await runsDir();
    vi.stubEnv('ASHLR_RUNS_DIR', dir);
    const out = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    expect(await cmdLanes(['pressure', '--json'])).toBe(0);
    expect(JSON.parse(String(out.mock.calls.at(-1)![0])).schema).toBe('lanes.pressure.v1');
    expect(await cmdLanes(['pressure', '--bogus'])).toBe(2);
    expect(err).toHaveBeenCalled();
  });
});
