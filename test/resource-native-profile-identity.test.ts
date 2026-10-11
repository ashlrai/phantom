/** Inert profiles only: no vendor login, credentials, network or model call. */
import { spawnSync } from 'node:child_process';
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { prepareResourceNativeProfile, repinResourceNativeProfile, resolveNativeSeatLaunch,
  upgradeResourceNativeProfileIdentity } from '../src/core/resources/native-profile.js';

let root: string; let binary: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'native-identity-')));
  binary = join(root, 'inert-native');
  writeFileSync(binary, `#!${realpathSync(process.execPath)}\nconsole.log('INERT_NATIVE_RAN')\n`, { mode: 0o700 });
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function prepare(provider: 'codex' | 'claude' | 'grok' = 'codex', legacy = false) {
  if (!legacy) return prepareResourceNativeProfile({ provider, directory: join(root, provider), executable: binary });
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...descriptor, value: 'linux' });
  try { return prepareResourceNativeProfile({ provider, directory: join(root, provider), executable: binary }); }
  finally { Object.defineProperty(process, 'platform', descriptor); }
}
function run(command: string[]) {
  return spawnSync(command[0]!, [...command.slice(1), '--version'], { encoding: 'utf8', timeout: 5_000 });
}
function editLine(file: string, prefix: string, change: (value: string) => string): void {
  const lines = readFileSync(file, 'utf8').split('\n');
  const index = lines.findIndex(line => line.startsWith(prefix));
  expect(index).toBeGreaterThan(0);
  lines[index] = change(lines[index]!);
  writeFileSync(file, lines.join('\n'));
}
function roster(profile: ReturnType<typeof prepare>) {
  const accountsRoot = join(root, 'accounts'); mkdirSync(accountsRoot, { mode: 0o700, recursive: true });
  writeFileSync(join(accountsRoot, 'connections.json'), JSON.stringify({ schemaVersion: 1,
    accounts: [{ id: 'seat-a', provider: profile.provider, command: profile.command }] }), { mode: 0o600 });
  return () => resolveNativeSeatLaunch({ accountsRoot, provider: profile.provider, seatId: 'seat-a' });
}

describe.skipIf(process.platform !== 'darwin' || typeof process.execve !== 'function')('reboot-stable native profile identity', () => {
  it.each(['codex', 'claude', 'grok'] as const)('prepares %s with APFS UUID, birthtime and boot witness without contacting a provider', provider => {
    const profile = prepare(provider); const launch = run(profile.command);
    expect(launch.status).toBe(0); expect(launch.stdout).toContain('INERT_NATIVE_RAN');
    const text = readFileSync(profile.launcherPath, 'utf8');
    const row = JSON.parse(/^const directories=(.*);$/m.exec(text)![1]!);
    expect(row).toHaveLength(provider === 'claude' ? 3 : 2);
    expect(row.every((entry: { birthtimeNs: string; volumeUuid: string }) =>
      /^[1-9]\d*$/.test(entry.birthtimeNs) && /^[a-f0-9-]{36}$/.test(entry.volumeUuid))).toBe(true);
    expect(text).toMatch(/^const preparedBootId="[a-f0-9-]{36}";$/m);
    expect(roster(profile)()).toMatchObject({ ok: true });
  });

  it('accepts only witnessed device renumbering after a different boot', () => {
    const profile = prepare(); const resolve = roster(profile);
    editLine(profile.launcherPath, 'const directories=', line => {
      const rows = JSON.parse(line.slice('const directories='.length, -1));
      return `const directories=${JSON.stringify(rows.map((row: { dev: string }) => ({ ...row, dev: String(Number(row.dev) + 1) })))};`;
    });
    const manifest = JSON.parse(readFileSync(profile.manifestPath, 'utf8'));
    manifest.identity.directories = JSON.parse(/^const directories=(.*);$/m.exec(readFileSync(profile.launcherPath, 'utf8'))![1]!);
    writeFileSync(profile.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    expect(run(profile.command).status).toBe(126);
    expect(resolve()).toMatchObject({ ok: false, reason: 'profile-invalid' });
    editLine(profile.launcherPath, 'const preparedBootId=', () => 'const preparedBootId="11111111-1111-4111-8111-111111111111";');
    manifest.identity.preparedBootId = '11111111-1111-4111-8111-111111111111';
    writeFileSync(profile.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    expect(run(profile.command).status).toBe(0);
    expect(resolve()).toMatchObject({ ok: true });
  });

  it('refuses a changed volume, state directory replacement and symlink before native contact', () => {
    const profile = prepare(); const original = readFileSync(profile.launcherPath, 'utf8');
    editLine(profile.launcherPath, 'const directories=', line => line.replace(/"volumeUuid":"[a-f0-9-]+"/,
      '"volumeUuid":"11111111-1111-4111-8111-111111111111"'));
    const manifest = JSON.parse(readFileSync(profile.manifestPath, 'utf8'));
    manifest.identity.directories[0].volumeUuid = '11111111-1111-4111-8111-111111111111';
    writeFileSync(profile.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    expect(run(profile.command).status).toBe(126);
    writeFileSync(profile.launcherPath, original);
    manifest.identity.directories[0].volumeUuid = JSON.parse(/^const directories=(.*);$/m.exec(original)![1]!)[0].volumeUuid;
    writeFileSync(profile.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const aside = `${profile.nativeStatePath}.old`;
    renameSync(profile.nativeStatePath, aside); mkdirSync(profile.nativeStatePath, { mode: 0o700 });
    expect(run(profile.command).status).toBe(126);
    expect(roster(profile)()).toMatchObject({ ok: false, reason: 'profile-invalid' });
    expect(lstatSync(profile.nativeStatePath).ino).not.toBe(lstatSync(aside).ino);
    chmodSync(profile.nativeStatePath, 0o755);
    expect(run(profile.command).status).toBe(126);
  });

  it('cross-checks the independent manifest and refuses one-file witness edits', () => {
    const profile = prepare(); const original = readFileSync(profile.manifestPath, 'utf8');
    const manifest = JSON.parse(original);
    manifest.identity.directories[0].ino = String(Number(manifest.identity.directories[0].ino) + 1);
    writeFileSync(profile.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    expect(run(profile.command).status).toBe(126);
    expect(roster(profile)()).toMatchObject({ ok: false, reason: 'profile-invalid' });
    writeFileSync(profile.manifestPath, original);
    expect(run(profile.command).status).toBe(0);
    manifest.identity.directories[0].ino = JSON.parse(original).identity.directories[0].ino;
    manifest.nativeStatePath = join(root, 'different-state');
    writeFileSync(profile.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    expect(run(profile.command).status).toBe(126);
    writeFileSync(profile.manifestPath, original);
    expect(upgradeResourceNativeProfileIdentity({ directory: profile.directory })).toMatchObject({ status: 'unchanged', backupPath: null });
  });

  it('upgrades an unchanged legacy profile explicitly, preserves state and supports repin', () => {
    const profile = prepare('claude', true); const legacy = readFileSync(profile.launcherPath, 'utf8');
    const legacyManifest = readFileSync(profile.manifestPath, 'utf8');
    const state = join(profile.nativeStatePath, 'fixture-state'); writeFileSync(state, 'KEEP', { mode: 0o600 });
    expect(upgradeResourceNativeProfileIdentity({ directory: profile.directory, dryRun: true })).toMatchObject({ status: 'would-upgrade' });
    expect(readFileSync(profile.launcherPath, 'utf8')).toBe(legacy);
    expect(readFileSync(profile.manifestPath, 'utf8')).toBe(legacyManifest);
    expect(upgradeResourceNativeProfileIdentity({ directory: profile.directory })).toMatchObject({ status: 'upgraded' });
    expect(readFileSync(`${profile.launcherPath}.identity-prev`, 'utf8')).toBe(legacy);
    expect(readFileSync(state, 'utf8')).toBe('KEEP');
    expect(upgradeResourceNativeProfileIdentity({ directory: profile.directory })).toMatchObject({ status: 'unchanged' });
    expect(roster(profile)()).toMatchObject({ ok: true });
    expect(run(profile.command).status).toBe(0);
    expect(repinResourceNativeProfile({ directory: profile.directory, executable: binary })).toMatchObject({ status: 'unchanged' });
  });

  it('never upgrades a legacy profile whose recorded device already differs', () => {
    const profile = prepare('codex', true);
    editLine(profile.launcherPath, 'const directories=', line => {
      const rows = JSON.parse(line.slice('const directories='.length, -1));
      return `const directories=${JSON.stringify(rows.map((row: { dev: string }) => ({ ...row, dev: String(Number(row.dev) + 1) })))};`;
    });
    const before = readFileSync(profile.launcherPath);
    expect(() => upgradeResourceNativeProfileIdentity({ directory: profile.directory, dryRun: true })).toThrow();
    expect(readFileSync(profile.launcherPath)).toEqual(before);
    expect(run(profile.command).status).toBe(126);
  });

  it('resumes a backup-only interruption without trusting a conflicting backup', () => {
    const profile = prepare('codex', true);
    const oldLauncher = readFileSync(profile.launcherPath, 'utf8');
    writeFileSync(`${profile.launcherPath}.identity-prev`, oldLauncher, { mode: 0o600 });
    expect(upgradeResourceNativeProfileIdentity({ directory: profile.directory })).toMatchObject({ status: 'upgraded' });
    expect(readFileSync(`${profile.manifestPath}.identity-prev`, 'utf8')).toContain('"schemaVersion": 1');
    expect(run(profile.command).status).toBe(0);
    const tampered = prepare('claude', true);
    writeFileSync(`${tampered.launcherPath}.identity-prev`, 'different source', { mode: 0o600 });
    const before = readFileSync(tampered.launcherPath);
    expect(() => upgradeResourceNativeProfileIdentity({ directory: tampered.directory })).toThrow();
    expect(readFileSync(tampered.launcherPath)).toEqual(before);
  });

  it('finishes only the backed launcher-published/manifest-old interruption', () => {
    const profile = prepare('grok', true); const oldManifest = readFileSync(profile.manifestPath, 'utf8');
    expect(upgradeResourceNativeProfileIdentity({ directory: profile.directory })).toMatchObject({ status: 'upgraded' });
    const newLauncher = readFileSync(profile.launcherPath, 'utf8');
    writeFileSync(profile.manifestPath, oldManifest);
    expect(run(profile.command).status).toBe(126);
    expect(roster(profile)()).toMatchObject({ ok: false, reason: 'profile-invalid' });
    expect(upgradeResourceNativeProfileIdentity({ directory: profile.directory, dryRun: true })).toMatchObject({ status: 'would-upgrade' });
    expect(readFileSync(profile.manifestPath, 'utf8')).toBe(oldManifest);
    expect(upgradeResourceNativeProfileIdentity({ directory: profile.directory })).toMatchObject({ status: 'upgraded' });
    expect(readFileSync(profile.launcherPath, 'utf8')).toBe(newLauncher);
    expect(run(profile.command).status).toBe(0);
    expect(roster(profile)()).toMatchObject({ ok: true });
  });
});
