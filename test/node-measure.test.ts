/**
 * `phm node measure` prints the self-measured `phm node beat --capacity` sample
 * so a node on the standalone path (docs/add-a-computer.md) can report honest
 * measured capacity instead of hand-crafting JSON. The mapping lives in
 * src/core/drive/nodes/capacity-sample.ts and is shared with the pool worker's
 * beat, so manual and worker samples can never drift apart.
 */
import { describe, expect, it, vi, afterEach } from 'vitest';
import { nodeBeatCapacity, nodeSampleHostId } from '../src/core/drive/nodes/capacity-sample.js';
import { isNodeCapacity, type NodeCapacitySample } from '../src/core/drive/nodes/state.js';
import type { NodeCapacity } from '../src/core/drive/nodes/capacity.js';
import { cmdNodeMeasure } from '../src/cli/node-measure.js';
import { cmdNode } from '../src/cli/node.js';

const GIB = 1024 ** 3;
const ready: NodeCapacity = { ramBytes: 16 * GIB, slots: 11, held: null };
const measured = { host: () => 'Test Mac!', now: () => 1_700_000_000_000 };

function capture() {
  const lines: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((line: string) => { lines.push(String(line)); });
  vi.spyOn(console, 'error').mockImplementation((line: string) => { lines.push(String(line)); });
  return lines;
}
const lastJson = (lines: string[]) => JSON.parse(lines.at(-1)!);
afterEach(() => vi.restoreAllMocks());

describe('nodeBeatCapacity', () => {
  it('maps a ready measurement to a beat-acceptable sample', () => {
    const report = nodeBeatCapacity(ready, measured);
    expect(report.omit).toBeNull();
    expect(report.held).toBeNull();
    expect(report.sample).toEqual({ hostId: 'Test-Mac-', ramBytes: 16 * GIB, slots: 11, held: null, sampledAtMs: 1_700_000_000_000 });
    expect(isNodeCapacity(report.sample)).toBe(true);
  });

  it('reports schema-expressible holds with zero slots', () => {
    for (const held of ['memory-unmeasured', 'memory-pressure', 'disk-unmeasured', 'disk-pressure'] as const) {
      const report = nodeBeatCapacity({ ramBytes: 8 * GIB, slots: 0, held }, measured);
      expect(report.sample).toMatchObject({ slots: 0, held });
      expect(isNodeCapacity(report.sample)).toBe(true);
    }
  });

  it('omits the sample for holds the beat schema cannot express, like the pool worker', () => {
    for (const held of ['cpu-unmeasured', 'cpu-pressure', 'host-slots-unmeasured', 'host-slots-exhausted'] as const) {
      const report = nodeBeatCapacity({ ramBytes: 8 * GIB, slots: 0, held }, measured);
      expect(report.sample).toBeNull();
      expect(report.omit).toBe('unreportable-held');
      expect(report.held).toBe(held);
    }
  });

  it('keeps measured slots for a ready node and zeroes them for a reportable hold', () => {
    expect(nodeBeatCapacity({ ramBytes: 8 * GIB, slots: 4, held: 'memory-pressure' }, measured).sample).toMatchObject({ slots: 0 });
    expect(nodeBeatCapacity({ ramBytes: 8 * GIB, slots: 4, held: null }, measured).sample).toMatchObject({ slots: 4 });
  });

  it('sanitizes the host id to the sample alphabet and length', () => {
    expect(nodeSampleHostId(() => 'a'.repeat(300))).toHaveLength(100);
    expect(nodeSampleHostId(() => 'my mac.local')).toBe('my-mac.local');
  });
});

describe('phm node measure', () => {
  const deps = (capacity: NodeCapacity) => ({ measure: () => capacity, host: () => 'node-one', now: () => 42 });

  it('prints the bare sample by default so --capacity "$(phm node measure)" pastes it', async () => {
    const lines = capture();
    expect(await cmdNodeMeasure([], deps(ready))).toBe(0);
    const sample = JSON.parse(lines.at(-1)!) as NodeCapacitySample;
    expect(sample).toEqual({ hostId: 'node-one', ramBytes: 16 * GIB, slots: 11, held: null, sampledAtMs: 42 });
    expect(isNodeCapacity(sample)).toBe(true);
  });

  it('wraps the sample in the standard envelope under --json', async () => {
    const lines = capture();
    expect(await cmdNodeMeasure(['--json'], deps(ready))).toBe(0);
    expect(lastJson(lines)).toEqual({ schemaVersion: 1, command: 'measure',
      capacity: { hostId: 'node-one', ramBytes: 16 * GIB, slots: 11, held: null, sampledAtMs: 42 } });
  });

  it('refuses unknown arguments as usage, with the envelope under --json', async () => {
    const lines = capture();
    expect(await cmdNodeMeasure(['--bogus', '--json'], deps(ready))).toBe(2);
    expect(lastJson(lines)).toMatchObject({ schemaVersion: 1, command: 'measure', error: { code: 'usage' } });
    expect(await cmdNodeMeasure(['extra'], deps(ready))).toBe(2);
  });

  it('reports a measurement failure as an operational error', async () => {
    const lines = capture();
    expect(await cmdNodeMeasure(['--json'], { measure: () => { throw new Error('telemetry denied'); } })).toBe(1);
    expect(lastJson(lines)).toMatchObject({ command: 'measure', error: { code: 'error' } });
  });

  it('exits 1 with the hold reason when the sample schema cannot express it', async () => {
    const lines = capture();
    expect(await cmdNodeMeasure(['--json'], deps({ ramBytes: 8 * GIB, slots: 0, held: 'host-slots-exhausted' }))).toBe(1);
    const out = lastJson(lines);
    expect(out.error).toMatchObject({ code: 'held', message: expect.stringContaining('host-slots-exhausted') });
    expect(out.error.fix).toContain('Omit --capacity');
  });

  it('is reachable through the node dispatcher and listed in its help', async () => {
    const lines = capture();
    expect(await cmdNode(['measure', '--help'])).toBe(0);
    expect(lines.join('\n')).toContain('phm node measure');
  });
});
