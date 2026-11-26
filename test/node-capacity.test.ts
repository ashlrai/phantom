import { execFile } from 'node:child_process';
import { chmodSync, linkSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, totalmem } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assessNodeCapacity, nodeRamSlots, packRamBytes, readNodeCapacity, shareNodeCapacity } from '../src/core/drive/nodes/capacity.js';
import { HostSlots } from '../src/core/drive/nodes/host-slots.js';
import { readMacHostHeadroom, type HostHeadroom } from '../src/core/run/host-headroom.js';
const GIB = 1024 ** 3;
const normal: HostHeadroom = { freePercent: 26, swapGb: 5.8, pressureLevel: 1 };
describe('conservative node RAM and disk admission', () => {
  it('budgets the 8GB Pro and 16GB Air independently', () => {
    expect(nodeRamSlots(8 * GIB)).toBe(4);
    expect(nodeRamSlots(16 * GIB)).toBe(11);
    for (const invalid of [NaN, Infinity, -1, 0, 3 * GIB]) expect(nodeRamSlots(invalid)).toBe(0);
    expect(nodeRamSlots(1024 * GIB)).toBe(64);
  });
  it('budgets RAM per pack; unknown packs keep the legacy 4 GiB divisor', () => {
    expect(packRamBytes('codex-file')).toBe(GIB);
    expect(packRamBytes('some-local-model-pack')).toBe(4 * GIB);
    expect(packRamBytes('toString')).toBe(4 * GIB);
    // before (flat 4 GiB) vs after, 8 GiB and 128 GiB hosts
    expect([8, 128].map(g => nodeRamSlots(g * GIB, 'unknown'))).toEqual([1, 22]);
    expect([8, 128].map(g => nodeRamSlots(g * GIB, 'codex-file'))).toEqual([4, 64]);
    expect(nodeRamSlots(8 * GIB, 'shell-check')).toBe(10);
    expect(nodeRamSlots(3 * GIB, 'shell-check')).toBe(0);
  });
  it('advertises more than one codex-file slot on an 8 GiB host under no pressure (live-pool regression)', () => {
    const idle: HostHeadroom = { freePercent: 60, swapGb: 0, pressureLevel: 1 };
    expect(assessNodeCapacity(8 * GIB, idle, 100e9)).toEqual({ ramBytes: 8 * GIB, slots: 4, held: null });
    // slots:1 on this class of host means the legacy flat 4 GiB divisor (old phm) or real pressure, never this code
    expect(nodeRamSlots(8 * GIB, 'no-such-pack')).toBe(1);
    expect(assessNodeCapacity(8 * GIB, { ...idle, pressureLevel: 2 }, 100e9)).toMatchObject({ slots: 0, held: 'memory-pressure' });
  });
  it('admits normal pressure despite low raw free memory and historical swap', () => {
    expect(assessNodeCapacity(16 * GIB, normal, 20e9)).toEqual({ ramBytes: 16 * GIB, slots: 11, held: null });
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
    expect(assessNodeCapacity(8 * GIB, normal, 20e9).slots).toBe(4);
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

describe('pack resource admission', () => {
  const assess = (pack: string, readCpu: () => { parallelism: number; load: number[] } | null) =>
    assessNodeCapacity(16 * GIB, normal, 100e9, false, { pack, readCpu });
  it.each(['codex-file', 'shell-check'])('%s ignores unrelated desktop load and missing CPU telemetry', pack => {
    const read = vi.fn(() => { throw new Error('must not sample load'); });
    expect(assess(pack, read).held).toBeNull();
    expect(read).not.toHaveBeenCalled();
  });
  it('holds local inference under CPU load and admits measured headroom', () => {
    expect(assess('omlx-chat', () => ({ parallelism: 8, load: [7, 9, 10] })).held).toBeNull();
    expect(assess('omlx-chat', () => ({ parallelism: 8, load: [7.1, 0, 0] }))).toMatchObject({ slots: 0, held: 'cpu-pressure' });
    expect(assessNodeCapacity(16 * GIB, normal, 100e9, false, { pack: 'future-pack', resourceHint: 'cpu-bound', readCpu: () => null }).held).toBe('cpu-unmeasured');
  });
  it('never substitutes optimistic CPU measurements', () => {
    expect(assessNodeCapacity(16 * GIB, normal, 100e9, false, { pack: 'omlx-chat' }).held).toBe('cpu-unmeasured');
    for (const cpu of [null, { parallelism: 0, load: [0, 0, 0] }, { parallelism: 1.5, load: [0, 0, 0] },
      { parallelism: 8, load: [] }, { parallelism: 8, load: new Array<number>(3) }, { parallelism: 8, load: [Infinity, 0, 0] },
      { parallelism: 8, load: [NaN, 0, 0] }, { parallelism: 8, load: [0, -1, 0] }]) {
      expect(assess('omlx-chat', () => cpu)).toMatchObject({ slots: 0, held: 'cpu-unmeasured' });
    }
    expect(assess('omlx-chat', () => { throw new Error('unavailable'); }).held).toBe('cpu-unmeasured');
  });
});

describe('physical host slot leases', () => {
  let root: string;
  beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'node-host-slots-'))); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });
  const base = () => assessNodeCapacity(8 * GIB, normal, 100e9);
  it('shares one budget across N independent worker registries and reuses released slots', () => {
    const siblings = Array.from({ length: 5 }, () => new HostSlots(root));
    const leases = siblings.map(registry => registry.acquire(4));
    expect(leases.filter(Boolean)).toHaveLength(4);
    expect(shareNodeCapacity(base(), { registry: siblings[4]! })).toMatchObject({ slots: 0, held: 'host-slots-exhausted' });
    expect(leases.slice(0, 4).map(l => l!.slot)).toEqual([0, 1, 2, 3]);
    expect(shareNodeCapacity(base(), { registry: siblings[0]!, lease: leases[0]! }).held).toBeNull();
    leases[0]!.release();
    expect(siblings[4]!.acquire(4)?.slot).toBe(0);
  });
  it('never overcommits when separate worker processes race for the same slots', async () => {
    const module = new URL('../src/core/drive/nodes/host-slots.ts', import.meta.url).href;
    const code = `import { HostSlots } from ${JSON.stringify(module)};
      let slot = null;
      try { slot = new HostSlots(process.argv[1]).acquire(2)?.slot ?? null; } catch {}
      process.stdout.write(JSON.stringify(slot));`;
    const results = await Promise.all(Array.from({ length: 4 }, () => promisify(execFile)(process.execPath,
      ['--import', 'tsx', '--input-type=module', '-e', code, root], { timeout: 10_000 })));
    const slots = results.map(r => JSON.parse(r.stdout)).filter(s => s !== null);
    expect(slots.length).toBeGreaterThan(0);
    expect(slots.length).toBeLessThanOrEqual(2);
    expect(new Set(slots).size).toBe(slots.length);
    expect(new HostSlots(root).available(2)).toBe(2 - slots.length);
  });
  it('uses native host/boot identity and OS home across different worker homes', async () => {
    const identity = vi.fn<() => { machineDigest: string; bootId: string } | null>(() => ({ machineDigest: 'a'.repeat(64), bootId: '00000000-0000-4000-8000-000000000001' }));
    vi.doMock('../src/core/resources/native-boot-identity.js', () => ({ readNativeBootIdentity: identity }));
    vi.doMock('node:os', async original => ({ ...await original<typeof import('node:os')>(), userInfo: () => ({ homedir: root }) }));
    const open = async () => { vi.resetModules(); return (await import('../src/core/drive/nodes/host-slots.js')).hostSlots(); };
    try {
      vi.stubEnv('HOME', join(root, 'worker-a')); vi.stubEnv('ASHLR_HOME', join(root, 'lane-a'));
      (await open()).acquire(1);
      vi.stubEnv('HOME', join(root, 'worker-b')); vi.stubEnv('ASHLR_HOME', join(root, 'lane-b'));
      expect((await open()).acquire(1)).toBeNull();
      identity.mockReturnValue({ machineDigest: 'a'.repeat(64), bootId: '00000000-0000-4000-8000-000000000002' });
      expect((await open()).acquire(1)).not.toBeNull();
      identity.mockReturnValue(null);
      await expect(open()).rejects.toThrow('Host identity unmeasured');
    } finally {
      vi.unstubAllEnvs(); vi.doUnmock('node:os'); vi.doUnmock('../src/core/resources/native-boot-identity.js'); vi.resetModules();
    }
  });
  it('preserves single-worker capacity, including the light ceiling and all prior holds', () => {
    const registry = new HostSlots(root);
    for (const ram of [8, 16, 128]) for (const light of [false, true]) {
      const capacity = assessNodeCapacity(ram * GIB, normal, 100e9, light);
      expect(shareNodeCapacity(capacity, { registry })).toEqual(capacity);
    }
    const held = assessNodeCapacity(8 * GIB, null, null);
    expect(shareNodeCapacity(held, { registry })).toEqual(held);
    const leases = Array.from({ length: 4 }, () => registry.acquire(4)!);
    expect(leases.every(lease => lease.valid())).toBe(true);
    leases.forEach(lease => lease.release());
    expect(shareNodeCapacity(base(), { registry })).toEqual(base());
  });
  it('retains reservations across registry reopens without reclaiming potentially live runners', () => {
    new HostSlots(root).acquire(1);
    expect(new HostSlots(root).acquire(1)).toBeNull();
    expect(statSync(root).mode & 0o777).toBe(0o700);
    expect(statSync(join(root, '0')).mode & 0o777).toBe(0o600);
  });
  it('refuses unsafe or ambiguous state, including lost leases', () => {
    const registry = new HostSlots(root), lease = registry.acquire(4)!;
    writeFileSync(join(root, '0'), 'corrupt');
    expect(shareNodeCapacity(base(), { registry, lease }).held).toBe('host-slots-unmeasured');
    expect(() => lease.release()).toThrow();
    expect(readFileSync(join(root, '0'), 'utf8')).toBe('corrupt');
  });
  it.each(['symlink', 'hardlink', 'permissions', 'unknown'])('holds on %s registry entries', kind => {
    const registry = new HostSlots(root);
    const target = join(root, '0');
    writeFileSync(target, '00000000-0000-4000-8000-000000000001', { mode: 0o600 });
    if (kind === 'symlink') { rmSync(target); symlinkSync('/nonexistent', target); }
    if (kind === 'hardlink') linkSync(target, join(root, '1'));
    if (kind === 'permissions') chmodSync(target, 0o644);
    if (kind === 'unknown') writeFileSync(join(root, 'unexpected'), 'x');
    expect(shareNodeCapacity(base(), { registry })).toMatchObject({ slots: 0, held: 'host-slots-unmeasured' });
    expect(() => registry.acquire(4)).toThrow();
  });
  it('refuses symlink directories and replacement directories', () => {
    const path = join(root, 'registry'), registry = new HostSlots(path);
    rmSync(path, { recursive: true });
    symlinkSync(root, path);
    expect(() => new HostSlots(path)).toThrow();
    expect(shareNodeCapacity(base(), { registry }).held).toBe('host-slots-unmeasured');
  });
});

describe('readNodeCapacity injected telemetry', () => {
  let root: string;
  beforeEach(() => { root = realpathSync(mkdtempSync(join(tmpdir(), 'node-read-capacity-'))); });
  afterEach(() => { rmSync(root, { recursive: true, force: true }); });

  it('advertises measured slots for a Linux-shaped headroom reading', () => {
    const registry = new HostSlots(root);
    const capacity = readNodeCapacity(false, { registry, readDisk: () => 100e9,
      readMemory: () => ({ freePercent: 50, swapGb: 1, pressureLevel: 1 }) });
    expect(capacity.held).toBeNull();
    expect(capacity.slots).toBe(nodeRamSlots(totalmem()));
  });

  it('holds memory-unmeasured when the platform reader has no telemetry', () => {
    const registry = new HostSlots(root);
    expect(readNodeCapacity(false, { registry, readDisk: () => 100e9, readMemory: () => null }))
      .toMatchObject({ slots: 0, held: 'memory-unmeasured' });
  });
});
