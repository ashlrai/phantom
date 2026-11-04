/** Inert APFS fixtures: count helper spawns without touching host volumes or credentials. */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { prepareResourceNativeProfile, resolveNativeSeatLaunch } from '../src/core/resources/native-profile.js';

vi.mock('node:child_process', () => ({ execFileSync: vi.fn() }));
const bootId = '11111111-1111-4111-8111-111111111111';
const volumeUuid = '22222222-2222-4222-8222-222222222222';
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
let root: string;
let now: number;
let resolveSeat: (display?: boolean) => ReturnType<typeof resolveNativeSeatLaunch>;
const diskutilSpawns = () => vi.mocked(execFileSync).mock.calls.filter(([file]) => file === '/usr/sbin/diskutil').length;
beforeEach(() => {
  Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' });
  now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.mocked(execFileSync).mockImplementation(((file: string) => {
    if (file === '/usr/sbin/sysctl') return bootId;
    if (file === '/bin/df') return 'Filesystem 512-blocks Used Available Capacity Mounted on\n/dev/disk3s1 100 10 90 10% /\n';
    if (file === '/usr/sbin/diskutil') return '<plist/>';
    if (file === '/usr/bin/plutil') return JSON.stringify({ FilesystemType: 'apfs', DeviceNode: '/dev/disk3s1', VolumeUUID: volumeUuid });
    throw new Error('Unexpected helper');
  }) as typeof execFileSync);
  root = realpathSync(mkdtempSync(join(tmpdir(), 'volume-polling-')));
  const binary = join(root, 'inert'); writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
  const profile = prepareResourceNativeProfile({ provider: 'codex', directory: join(root, 'profile'), executable: binary });
  writeFileSync(join(root, 'connections.json'), JSON.stringify({ schemaVersion: 1,
    accounts: [{ id: 'seat-a', provider: 'codex', command: profile.command }] }), { mode: 0o600 });
  resolveSeat = (historicalDisplayOnly = true) => resolveNativeSeatLaunch({ accountsRoot: root, provider: 'codex', seatId: 'seat-a', historicalDisplayOnly });
  vi.mocked(execFileSync).mockClear();
});
afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true });
});

it('spawns diskutil at most ten times over ten minutes of display polling', () => {
  // Reproduce the uncached path with the same two subscribers and clock.
  for (now = 0; now < 600_000; now += 1_000) {
    expect(resolveSeat(false).ok).toBe(true);
    expect(resolveSeat(false).ok).toBe(true);
  }
  expect(diskutilSpawns()).toBe(1_200);
  vi.mocked(execFileSync).mockClear();
  for (now = 0; now < 600_000; now += 1_000) {
    expect(resolveSeat().ok).toBe(true);
    expect(resolveSeat().ok).toBe(true); // Multiple subscribers share the volume observation.
  }
  expect(diskutilSpawns()).toBe(10);
  now = 600_000; expect(resolveSeat().ok).toBe(true);
  expect(diskutilSpawns()).toBe(11);
  // Security-sensitive resolution always makes a fresh identity read.
  expect(resolveSeat(false).ok).toBe(true); expect(resolveSeat(false).ok).toBe(true);
  expect(diskutilSpawns()).toBe(13);
}, 120_000);

it('throttles failed probes and recovers at the next minute', () => {
  // Move beyond any observation retained by the preceding test.
  now = 1_000_000;
  const success = vi.mocked(execFileSync).getMockImplementation()!;
  vi.mocked(execFileSync).mockImplementation(((...args: Parameters<typeof execFileSync>) => {
    if (args[0] === '/usr/sbin/diskutil') throw new Error('Unavailable volume');
    return success(...args);
  }) as typeof execFileSync);
  for (let i = 0; i < 100; i++) expect(resolveSeat().ok).toBe(false);
  expect(diskutilSpawns()).toBe(1);
  vi.mocked(execFileSync).mockImplementation(success);
  now += 60_000; expect(resolveSeat().ok).toBe(true); expect(diskutilSpawns()).toBe(2);
});

it('still rejects manifest tampering while the volume observation is cached', () => {
  now = 2_000_000;
  expect(resolveSeat().ok).toBe(true);
  writeFileSync(join(root, 'profile', 'profile.json'), '{}', { mode: 0o600 });
  expect(resolveSeat().ok).toBe(false); expect(diskutilSpawns()).toBe(1);
});

it('rechecks a changed volume at expiry and immediately for launch authorization', () => {
  now = 3_000_000;
  expect(resolveSeat().ok).toBe(true);
  const success = vi.mocked(execFileSync).getMockImplementation()!;
  vi.mocked(execFileSync).mockImplementation(((...args: Parameters<typeof execFileSync>) => {
    if (args[0] === '/usr/bin/plutil') return JSON.stringify({ FilesystemType: 'apfs', DeviceNode: '/dev/disk3s1',
      VolumeUUID: '33333333-3333-4333-8333-333333333333' });
    return success(...args);
  }) as typeof execFileSync);
  expect(resolveSeat().ok).toBe(true);
  expect(resolveSeat(false).ok).toBe(false);
  now += 60_000;
  expect(resolveSeat().ok).toBe(false);
  expect(diskutilSpawns()).toBe(3);
});
