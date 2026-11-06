import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdFleetMemory } from '../src/cli/fleet-memory.js';
import { ENGINE_ADMISSION_POLICY, type EngineAdmissionView } from '../src/core/fleet/engine-admission-view.js';

const now = Date.parse('2026-11-01T19:30:00Z');
const memstat = { free_pct: 42.5, swap_gb: 1.2, swapouts_per_min: 0.25, disk_gb: 118.4, ts: '2026-11-01T19:29:30Z' };

const ALLOWED: EngineAdmissionView = {
  gated: true, allowed: true, pressure_level: 1, free_pct: 41.2, swap_gb: 1.3, reason: null,
  policy: ENGINE_ADMISSION_POLICY,
};
const HELD: EngineAdmissionView = {
  gated: true, allowed: false, pressure_level: 2, free_pct: 12.3, swap_gb: 9.87,
  reason: 'Kernel memory pressure warning; launch held.',
  policy: ENGINE_ADMISSION_POLICY,
};
const NOT_GATED: EngineAdmissionView = {
  gated: false, allowed: null, pressure_level: null, free_pct: null, swap_gb: null,
  reason: 'Engine memory gate runs on macOS only.',
  policy: ENGINE_ADMISSION_POLICY,
};

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'fleet-memory-admission-'));
  await writeFile(join(root, 'memstat.json'), JSON.stringify(memstat));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

async function textOutput(admission: EngineAdmissionView, args: string[] = []): Promise<string> {
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleetMemory(['--root', root, ...args], undefined, now, () => admission)).toBe(0);
  return String(output.mock.calls[0]![0]);
}

describe('cmdFleetMemory engine launch line', () => {
  it('prints the allowed verdict with the live reading', async () => {
    const text = await textOutput(ALLOWED);
    expect(text).toContain('engine launch: allowed (pressure 1, 41.2% raw free, 1.30 GiB swap)');
    expect(text).toContain('free_pct: 42.5');
  });

  it('prints HELD with the gate reason when the gate refuses', async () => {
    const text = await textOutput(HELD);
    expect(text).toContain('engine launch: HELD - Kernel memory pressure warning; launch held.');
  });

  it('prints not gated when the platform has no engine gate', async () => {
    expect(await textOutput(NOT_GATED)).toContain('engine launch: not gated on this platform');
  });

  it('carries engine_admission in --json next to an unchanged fleet.memory.v1 view', async () => {
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetMemory(['--root', root, '--json'], undefined, now, () => HELD)).toBe(0);
    const body = JSON.parse(String(output.mock.calls[0]![0]));
    expect(body.schema).toBe('fleet.memory.v1');
    expect(body.engine_admission).toEqual(HELD);
    expect(body.sample).toMatchObject({ free_pct: 42.5, swap_gb: 1.2 });
    expect(body.memguard).toEqual({ level: null, stopped: null });
  });
});
