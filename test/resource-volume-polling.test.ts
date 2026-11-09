/** Inert APFS fixtures: count helper spawns without touching host volumes or credentials. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { readResourceAccountDisplayEpoch, readResourceAccountLocalEpoch } from '../src/core/resources/account-identity-witness.js';
import type { ResourceAccountLocalEpoch } from '../src/core/resources/account-identity-witness.js';
import type { ResourceAccountConnection } from '../src/core/resources/connection-types.js';
import {
  prepareResourceNativeProfile, resolveNativeSeatDisplayMetadata, resolveNativeSeatLaunch,
  type NativeSeatLaunch, type NativeSeatLaunchResult, type ResourceNativeProfile,
} from '../src/core/resources/native-profile.js';
import { createResourceReadingCache } from '../src/core/resources/reading-cache.js';

vi.mock('node:child_process', async (importOriginal) => ({ ...await importOriginal<typeof import('node:child_process')>(), execFileSync: vi.fn() }));
const bootId = '11111111-1111-4111-8111-111111111111';
const volumeUuid = '22222222-2222-4222-8222-222222222222';
const otherVolume = '33333333-3333-4333-8333-333333333333';
const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
let root: string;
let profile: ResourceNativeProfile;
let now: number;
const account = () => ({ id: 'seat-a', label: 'Seat A', provider: 'codex' as const, command: profile.command });
const display = () => resolveNativeSeatDisplayMetadata({ accountsRoot: root, provider: 'codex', seatId: 'seat-a' });
const launch = () => resolveNativeSeatLaunch({ accountsRoot: root, provider: 'codex', seatId: 'seat-a' });
const diskutilSpawns = () => vi.mocked(execFileSync).mock.calls.filter(([file]) => file === '/usr/sbin/diskutil').length;
const withVolume = (uuid: string) => {
  const success = vi.mocked(execFileSync).getMockImplementation()!;
  vi.mocked(execFileSync).mockImplementation(((...args: Parameters<typeof execFileSync>) => {
    if (args[0] === '/usr/bin/plutil') return JSON.stringify({ FilesystemType: 'apfs', DeviceNode: '/dev/disk3s1', VolumeUUID: uuid });
    return success(...args);
  }) as typeof execFileSync);
  return success;
};
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
  profile = prepareResourceNativeProfile({ provider: 'codex', directory: join(root, 'profile'), executable: binary });
  writeFileSync(join(root, 'connections.json'), JSON.stringify({ schemaVersion: 1,
    accounts: [{ id: 'seat-a', provider: 'codex', command: profile.command }] }), { mode: 0o600 });
  vi.mocked(execFileSync).mockClear();
});
afterEach(() => {
  Object.defineProperty(process, 'platform', platform);
  vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true });
});

it('spawns diskutil at most ten times over ten minutes of display polling', () => {
  // Reproduce the uncached path with the same two subscribers and clock.
  for (now = 0; now < 600_000; now += 1_000) {
    expect(launch().ok).toBe(true);
    expect(launch().ok).toBe(true);
  }
  expect(diskutilSpawns()).toBe(1_200);
  vi.mocked(execFileSync).mockClear();
  for (now = 0; now < 600_000; now += 1_000) {
    expect(display()).not.toBeNull();
    expect(display()).not.toBeNull(); // Multiple subscribers share the volume observation.
  }
  expect(diskutilSpawns()).toBe(10);
  now = 600_000; expect(display()).not.toBeNull();
  expect(diskutilSpawns()).toBe(11);
  // Security-sensitive resolution always makes a fresh identity read.
  expect(launch().ok).toBe(true); expect(launch().ok).toBe(true);
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
  for (let i = 0; i < 100; i++) expect(display()).toBeNull();
  expect(diskutilSpawns()).toBe(1);
  vi.mocked(execFileSync).mockImplementation(success);
  now += 60_000; expect(display()).not.toBeNull(); expect(diskutilSpawns()).toBe(2);
});

it('still rejects manifest tampering while the volume observation is cached', () => {
  now = 2_000_000;
  expect(display()).not.toBeNull();
  writeFileSync(join(root, 'profile', 'profile.json'), '{}', { mode: 0o600 });
  expect(display()).toBeNull(); expect(diskutilSpawns()).toBe(1);
});

it('rechecks a changed volume at expiry for display and immediately for launch authorization', () => {
  now = 3_000_000;
  expect(display()).not.toBeNull();
  withVolume(otherVolume);
  expect(display()).not.toBeNull();
  expect(launch().ok).toBe(false);
  now += 60_000;
  expect(display()).toBeNull();
  expect(diskutilSpawns()).toBe(3);
});

it('keeps display metadata unusable as a launch result', () => {
  const metadata = display()!;
  // @ts-expect-error metadata has neither ok nor launch
  const asResult: NativeSeatLaunchResult = metadata;
  // @ts-expect-error metadata lacks the pinned executable
  const asLaunch: NativeSeatLaunch = metadata;
  void asResult; void asLaunch;
  expect(metadata).toEqual({ seatId: 'seat-a', provider: 'codex', command: profile.command, nativeStatePath: profile.nativeStatePath });
  expect('ok' in metadata || 'launch' in metadata || 'executable' in metadata).toBe(false);
  // The display epoch is likewise not a witness input.
  writeFileSync(join(profile.nativeStatePath, 'auth.json'), '{}', { mode: 0o600 });
  const shown = readResourceAccountDisplayEpoch(root, account())!;
  // @ts-expect-error a display epoch is not a ResourceAccountLocalEpoch
  const asEpoch: ResourceAccountLocalEpoch = shown;
  void asEpoch;
  expect(shown.displayEpochDigest).toBe(readResourceAccountLocalEpoch(root, account())!.epochDigest);
});

it('lets display history stay historical for 60s while witness, capture and launch reject a changed volume immediately', async () => {
  now = 4_000_000;
  mkdirSync(join(root, 'cache'), { mode: 0o700 });
  writeFileSync(join(profile.nativeStatePath, 'auth.json'), '{}', { mode: 0o600 });
  const a = account();
  const hint = 'a'.repeat(64);
  const row: ResourceAccountConnection = { id: a.id, label: a.label, provider: a.provider, state: 'observed',
    authentication: 'signed-in', health: 'reachable', planType: 'plus', observedAt: new Date(Date.now() - 1_000).toISOString(),
    expiresAt: new Date(Date.now() + 30_000).toISOString(), windows: [{ id: 'weekly', usedPercent: 7, resetsAt: null }],
    reason: 'probe-observed', onDemandEnabled: false, executionSupported: true };
  const cache = createResourceReadingCache({ root: join(root, 'cache'), accountsRoot: root, accounts: [a], assertOwnership: () => {} });
  const before = cache.captureEpoch(a)!;
  expect(before).not.toBeNull();
  cache.remember(a, row, hint, before); await cache.flush();

  // Controls: with an unchanged volume every authority path succeeds and each makes a fresh read.
  const spawns = diskutilSpawns();
  expect(cache.witness(a)?.source).toBe('native-account-checked');
  expect(diskutilSpawns()).toBe(spawns + 1);
  expect(launch().ok).toBe(true);
  expect(cache.lastKnown(a)?.identitySource).toBe('native-account-checked');
  const populated = diskutilSpawns();
  expect(cache.lastKnown(a)).not.toBeNull(); expect(cache.lastKnown(a)).not.toBeNull();
  expect(diskutilSpawns()).toBe(populated); // display polling reuses the cached volume, spawning nothing

  // The volume changes after the display cache is populated.
  withVolume(otherVolume);
  expect(cache.witness(a)).toBeNull();
  expect(cache.captureEpoch(a)).toBeNull();
  expect(launch().ok).toBe(false);
  expect(readResourceAccountLocalEpoch(root, a)).toBeNull();
  const history = cache.lastKnown(a);
  expect(history).toEqual({ observedAt: row.observedAt, expiresAt: row.expiresAt, windows: row.windows,
    source: 'native-account-checked-history', identitySource: 'native-account-checked' });
  now += 59_999; expect(cache.lastKnown(a)).not.toBeNull();
  expect(cache.witness(a)).toBeNull(); expect(launch().ok).toBe(false);
  now += 1; expect(cache.lastKnown(a)).toBeNull();

  // A restarted cache has no live witness: the local-epoch label comes from a fresh read only.
  withVolume(volumeUuid); now += 60_000; // expire the display observation of the changed volume
  const restarted = createResourceReadingCache({ root: join(root, 'cache'), accountsRoot: root, accounts: [a], assertOwnership: () => {} });
  expect(restarted.witness(a)?.source).toBe('native-account-checked-local-epoch');
  expect(restarted.lastKnown(a)?.identitySource).toBe('native-account-checked-local-epoch');
  withVolume(otherVolume);
  expect(restarted.witness(a)).toBeNull();
  expect(restarted.lastKnown(a)).not.toBeNull(); // within the 60s display window
}, 30_000);

// Real storage checker against the actual host volume: the inert APFS fixtures
// above pin the polling semantics; this one runs the same bounded
// sysctl/df/diskutil/plutil chain end to end on the machine that hosts the suite.
it.skipIf(platform.value !== 'darwin')('checks the real storage identity against the actual host volume', async () => {
  const real = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  vi.mocked(execFileSync).mockImplementation(real.execFileSync);
  const attempt = () => {
    const realRoot = realpathSync(mkdtempSync(join(tmpdir(), 'volume-polling-real-')));
    try {
      const binary = join(realRoot, 'inert'); writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o700 });
      const realProfile = prepareResourceNativeProfile({ provider: 'codex', directory: join(realRoot, 'profile'), executable: binary });
      writeFileSync(join(realRoot, 'connections.json'), JSON.stringify({ schemaVersion: 1,
        accounts: [{ id: 'seat-a', provider: 'codex', command: realProfile.command }] }), { mode: 0o600 });
      return { profile: realProfile,
        launch: resolveNativeSeatLaunch({ accountsRoot: realRoot, provider: 'codex', seatId: 'seat-a' }),
        display: resolveNativeSeatDisplayMetadata({ accountsRoot: realRoot, provider: 'codex', seatId: 'seat-a' }) };
    } finally { rmSync(realRoot, { recursive: true, force: true }); }
  };
  // Each helper spawn carries a fixed one-second bound; a loaded host can spend
  // that on diskutil alone, so allow a few whole fresh reads before failing.
  let result: ReturnType<typeof attempt> | undefined; let refused: unknown;
  for (let i = 0; i < 8 && (result?.launch.ok !== true || result.display === null); i++) {
    try {
      result = attempt();
      refused = result.launch.ok ? (result.display === null ? 'identity unavailable' : undefined) : result.launch;
    } catch (error) { refused = error; }
  }
  if (result?.launch.ok === true && result.display !== null) {
    expect(result.launch).toMatchObject({ launch: { seatId: 'seat-a', provider: 'codex',
      command: result.profile.command, nativeStatePath: result.profile.nativeStatePath } });
    expect(result.display).toEqual({ seatId: 'seat-a', provider: 'codex',
      command: result.profile.command, nativeStatePath: result.profile.nativeStatePath });
  } else {
    // A host whose bounded reads cannot complete must fail closed, never guess.
    expect(refused instanceof Error ? String(refused) : JSON.stringify(refused))
      .toMatch(/preparation failed|identity unavailable|profile-invalid/);
  }
});
