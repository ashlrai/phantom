import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { memoryView, FLEET_MEMORY_STALE_MS } from '../src/core/fleet/memory-view.js';
import { cmdFleetMemory } from '../src/cli/fleet-memory.js';

const now = Date.parse('2026-11-01T19:30:00Z');
const memstat = { free_pct: 42.5, swap_gb: 1.2, swapouts_per_min: 0.25, disk_gb: 118.4, ts: '2026-11-01T19:29:30Z' };
const memguard = { level: 'normal', stopped: ['RQ-PHX-A', 'RQ-PHX-B'] };

let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'fleet-memory-view-')); });
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe('memoryView', () => {
  it('projects a full sample and guard file', () => {
    expect(memoryView(memstat, memguard, now)).toEqual({
      schema: 'fleet.memory.v1',
      generatedAt: '2026-11-01T19:30:00.000Z',
      sample: {
        free_pct: 42.5, swap_gb: 1.2, swapouts_per_min: 0.25, disk_gb: 118.4,
        sampled_at: '2026-11-01T19:29:30.000Z', age_ms: 30_000, stale: false,
      },
      memguard: { level: 'normal', stopped: ['RQ-PHX-A', 'RQ-PHX-B'] },
    });
  });

  it('degrades each field independently and keeps usable fields', () => {
    expect(memoryView({ free_pct: -5, swap_gb: 8, swapouts_per_min: 'x', disk_gb: 101, ts: 'garbage' }, { level: 2, stopped: 'nope' }, now)).toMatchObject({
      sample: { free_pct: null, swap_gb: 8, swapouts_per_min: null, disk_gb: 101, sampled_at: null, age_ms: null, stale: null },
      memguard: { level: 2, stopped: null },
    });
  });

  it('marks a sample stale only past the five-minute bound', () => {
    const fresh = memoryView({ ts: '2026-11-01T19:25:00Z' }, null, now).sample;
    const stale = memoryView({ ts: '2026-11-01T19:24:59.999Z' }, null, now).sample;
    expect(fresh).toMatchObject({ age_ms: FLEET_MEMORY_STALE_MS, stale: false });
    expect(stale.stale).toBe(true);
    expect(stale.age_ms).toBeGreaterThan(FLEET_MEMORY_STALE_MS);
  });

  it('accepts an epoch-milliseconds ts and reports a future sample as not stale', () => {
    const view = memoryView({ ts: now + 60_000 }, null, now).sample;
    expect(view).toMatchObject({ sampled_at: '2026-11-01T19:31:00.000Z', age_ms: -60_000, stale: false });
  });

  it('reports every field unknown for missing or non-object input', () => {
    for (const input of [null, undefined, 'x', 42, []]) {
      const view = memoryView(input, input, now);
      expect(view.sample).toEqual({ free_pct: null, swap_gb: null, swapouts_per_min: null, disk_gb: null, sampled_at: null, age_ms: null, stale: null });
      expect(view.memguard).toEqual({ level: null, stopped: null });
    }
  });

  it('keeps only identifier job ids and accepts the stopped_jobs alias', () => {
    expect(memoryView(null, { stopped: ['RQ-1', 'has space', '', 'RQ-2', 7] }, now).memguard.stopped).toEqual(['RQ-1', 'RQ-2']);
    expect(memoryView(null, { stopped_jobs: ['RQ-9'] }, now).memguard.stopped).toEqual(['RQ-9']);
    expect(memoryView(null, { stopped: [] }, now).memguard.stopped).toEqual([]);
  });

  it('rejects a non-finite clock', () => {
    expect(() => memoryView(memstat, memguard, Number.NaN)).toThrow('Invalid reporting time');
  });
});

describe('cmdFleetMemory', () => {
  it('prints the exact text view for a full fixture', async () => {
    await writeFile(join(root, 'memstat.json'), JSON.stringify(memstat));
    await writeFile(join(root, '.memguard2.json'), JSON.stringify(memguard));
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetMemory(['--root', root], undefined, now)).toBe(0);
    expect(String(output.mock.calls[0]![0])).toBe([
      'free_pct: 42.5',
      'swap_gb: 1.2',
      'swapouts_per_min: 0.25',
      'disk_gb: 118.4',
      'sampled_at: 2026-11-01T19:29:30.000Z',
      'sample_age: 30s',
      'stale: no',
      'memguard_level: normal',
      'memguard_stopped: RQ-PHX-A, RQ-PHX-B',
    ].join('\n'));
  });

  it('prints the exact JSON view for a full fixture', async () => {
    await writeFile(join(root, 'memstat.json'), JSON.stringify(memstat));
    await writeFile(join(root, '.memguard2.json'), JSON.stringify(memguard));
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetMemory(['--root', root, '--json'], undefined, now)).toBe(0);
    expect(JSON.parse(String(output.mock.calls[0]![0]))).toEqual({
      schema: 'fleet.memory.v1',
      generatedAt: '2026-11-01T19:30:00.000Z',
      sample: {
        free_pct: 42.5, swap_gb: 1.2, swapouts_per_min: 0.25, disk_gb: 118.4,
        sampled_at: '2026-11-01T19:29:30.000Z', age_ms: 30_000, stale: false,
      },
      memguard: { level: 'normal', stopped: ['RQ-PHX-A', 'RQ-PHX-B'] },
    });
  });

  it('marks a stale sample in text and JSON', async () => {
    await writeFile(join(root, 'memstat.json'), JSON.stringify({ ...memstat, ts: '2026-11-01T19:20:00Z' }));
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetMemory(['--root', root], undefined, now)).toBe(0);
    expect(String(output.mock.calls[0]![0])).toContain('sample_age: 10.0m\nstale: yes');
    expect(await cmdFleetMemory(['--root', root, '--json'], undefined, now)).toBe(0);
    expect(JSON.parse(String(output.mock.calls[1]![0])).sample).toMatchObject({ age_ms: 600_000, stale: true });
    expect(JSON.parse(String(output.mock.calls[1]![0])).memguard).toEqual({ level: null, stopped: null });
  });

  it('exits 0 with every field unknown when both files are missing', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetMemory(['--root', root], undefined, now)).toBe(0);
    expect(String(output.mock.calls[0]![0])).toBe([
      'free_pct: unknown',
      'swap_gb: unknown',
      'swapouts_per_min: unknown',
      'disk_gb: unknown',
      'sampled_at: unknown',
      'sample_age: unknown',
      'stale: unknown',
      'memguard_level: unknown',
      'memguard_stopped: unknown',
    ].join('\n'));
  });

  it('exits 0 with null fields for malformed files', async () => {
    await writeFile(join(root, 'memstat.json'), '{broken');
    await writeFile(join(root, '.memguard2.json'), 'not json either');
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetMemory(['--root', root, '--json'], undefined, now)).toBe(0);
    expect(JSON.parse(String(output.mock.calls[0]![0]))).toMatchObject({
      sample: { free_pct: null, swap_gb: null, swapouts_per_min: null, disk_gb: null, sampled_at: null, age_ms: null, stale: null },
      memguard: { level: null, stopped: null },
    });
  });

  it('keeps a readable file when the other is malformed', async () => {
    await writeFile(join(root, 'memstat.json'), JSON.stringify(memstat));
    await writeFile(join(root, '.memguard2.json'), '{"level":"warn","stopped":{}}');
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetMemory(['--root', root], undefined, now)).toBe(0);
    const text = String(output.mock.calls[0]![0]);
    expect(text).toContain('free_pct: 42.5');
    expect(text).toContain('memguard_level: warn');
    expect(text).toContain('memguard_stopped: unknown');
  });

  it('rejects invalid flags before reading', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const read = vi.fn(async () => ({ memstat: null, memguard: null }));
    for (const args of [['--wat'], ['--root'], ['--root', '--json'], ['--json', '--json'], ['--root', '/tmp', '--root', '/tmp'], ['--help', 'x']]) {
      expect(await cmdFleetMemory(args, read, now)).toBe(2);
    }
    expect(read).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
  });

  it('prints usage for --help and reports a reader failure without leaking it', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdFleetMemory(['--help'], undefined, now)).toBe(0);
    expect(String(output.mock.calls[0]![0])).toContain('Usage: ashlr fleet memory');
    expect(await cmdFleetMemory([], async () => { throw new Error('private path'); }, now)).toBe(1);
    expect(error).toHaveBeenCalledWith('fleet memory: samples unavailable');
  });
});
