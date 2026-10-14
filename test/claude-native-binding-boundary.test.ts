/** Hermetic metadata boundary only: no native process, OS identity command or account credential. */
import { createHash } from 'node:crypto';
import { chmodSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '../src/core/config.js';
import * as poolRuntime from '../src/core/resources/pool-runtime.js';
import { readClaudeNativeBinding } from '../src/core/sandbox/claude-native-admission.js';
import { canonical, digest } from '../src/core/universe/artifacts.js';

const resolver = vi.hoisted(() => vi.fn());
const observedStat = vi.hoisted(() => vi.fn());
vi.mock('../src/core/resources/native-profile.js', () => ({ resolveNativeSeatLaunch: resolver }));
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>();
  return { ...actual, lstatSync: (...args: Parameters<typeof actual.lstatSync>) => { observedStat(args[0]); return actual.lstatSync(...args); } };
});
let root: string; let state: string; let accounts: string; let files: string[];
let cfg: ReturnType<typeof defaultConfig>;
let launch: { seatId: string; provider: 'claude'; command: [string, string]; nativeStatePath: string; executable: string };
const identity = { emailAddress: 'fixture@example.invalid', organizationUuid: 'fixture-org' };
const metadata = () => join(state, '.claude.json');
const roster = () => join(accounts, 'connections.json');
function writeIdentity() { writeFileSync(metadata(), JSON.stringify({ oauthAccount: identity }), { mode: 0o600 }); }
function mutateOnFinalRoster(change: () => void) {
  const original = poolRuntime.readResourceJson; let reads = 0;
  vi.spyOn(poolRuntime, 'readResourceJson').mockImplementation((file, maximum) => {
    const value = original(file, maximum);
    if (file === roster() && ++reads === 2) change();
    return value;
  });
}
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-binding-boundary-')));
  const profile = join(root, 'profile'); mkdirSync(profile, { mode: 0o700 });
  state = join(profile, 'native-state'); mkdirSync(state, { mode: 0o700 });
  accounts = join(root, 'accounts'); mkdirSync(accounts, { mode: 0o700 });
  files = [join(root, 'node'), join(profile, 'launcher.mjs'), join(root, 'inert-native'), join(profile, 'profile.json')];
  files.slice(0, 3).forEach(file => writeFileSync(file, 'inert', { mode: 0o700 }));
  writeFileSync(files[3]!, JSON.stringify({ executable: files[2] }), { mode: 0o600 });
  launch = { seatId: 'claude-a', provider: 'claude', command: [files[0]!, files[1]!], nativeStatePath: state, executable: files[2]! };
  writeFileSync(roster(), JSON.stringify({ schemaVersion: 1, intervalMs: 30_000, accounts: [{ id: launch.seatId, provider: 'claude', label: 'Fixture', command: launch.command }] }), { mode: 0o600 });
  cfg = defaultConfig(); cfg.verse = { ...(cfg.verse ?? {}), accountsRoot: accounts };
  resolver.mockReset().mockImplementation(() => ({ ok: true, launch })); observedStat.mockReset();
});
afterEach(() => { vi.restoreAllMocks(); rmSync(root, { recursive: true, force: true }); });

describe('one fresh late Claude launch resolution with local replacement fences', () => {
  it('keeps keychain-only absence and independently resolves every read with broker safety after stamps', () => {
    resolver.mockImplementation(() => {
      expect(observedStat.mock.calls.some(([file]) => file === files[3])).toBe(true);
      return { ok: true, launch };
    });
    expect(readClaudeNativeBinding(cfg, launch.seatId)?.localAccountDigest).toBeNull();
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver).toHaveBeenLastCalledWith({ accountsRoot: accounts, provider: 'claude', seatId: launch.seatId, requireClaudeBrokerSafety: true });
    expect(readClaudeNativeBinding(cfg, launch.seatId)).not.toBeNull(); expect(resolver).toHaveBeenCalledTimes(2);
  });
  it('preserves the original launch stamp digest and exact stable OAuth principal', () => {
    writeIdentity(); const stamps = files.map(file => { const s = lstatSync(file, { bigint: true }); return [file, ...[s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].map(String)]; });
    const result = readClaudeNativeBinding(cfg, launch.seatId);
    expect(result?.epochDigest).toBe(digest(canonical(['claude-native-launch-epoch-v1', stamps])));
    expect(result?.localAccountDigest).toBe(createHash('sha256').update(JSON.stringify(['claude-native-auth-v1', identity.emailAddress, identity.organizationUuid])).digest('hex'));
    expect(resolver).toHaveBeenCalledTimes(1);
  });
  it.each([0, 1, 2, 3])('refuses launch file %i changed across the late independent resolution', index => {
    resolver.mockImplementation(() => { writeFileSync(files[index]!, readFileSync(files[index]!, 'utf8') + 'changed'); return { ok: true, launch }; });
    expect(readClaudeNativeBinding(cfg, launch.seatId)).toBeNull();
  });
  it('propagates fresh OS/profile refusal despite stable provisional file stamps', () => {
    resolver.mockReturnValue({ ok: false, reason: 'profile-invalid', detail: 'fixed refusal' });
    expect(readClaudeNativeBinding(cfg, launch.seatId)).toBeNull();
    expect(resolver).toHaveBeenCalledTimes(1); expect(resolver.mock.calls[0]?.[0].requireClaudeBrokerSafety).toBe(true);
  });
  it.each(['command', 'executable', 'provider', 'seatId'])('refuses a mismatching freshly resolved %s', field => {
    const value = field === 'command' ? [files[0], join(root, 'foreign-launcher')] : field === 'executable' ? join(root, 'foreign-native') : field === 'provider' ? 'codex' : 'foreign-seat';
    resolver.mockReturnValue({ ok: true, launch: { ...launch, [field]: value } });
    expect(readClaudeNativeBinding(cfg, launch.seatId)).toBeNull();
  });
  it('refuses malformed, oversized or public provisional profile hints before resolving', () => {
    writeFileSync(files[3]!, '{}'); expect(readClaudeNativeBinding(cfg, launch.seatId)).toBeNull();
    writeFileSync(files[3]!, JSON.stringify({ executable: files[2], padding: 'x'.repeat(64 * 1024) })); expect(readClaudeNativeBinding(cfg, launch.seatId)).toBeNull();
    writeFileSync(files[3]!, JSON.stringify({ executable: files[2] })); chmodSync(files[3]!, 0o644); expect(readClaudeNativeBinding(cfg, launch.seatId)).toBeNull();
    expect(resolver).not.toHaveBeenCalled();
  });
  it('refuses full roster account mutation after the selected account read', () => {
    resolver.mockImplementation(() => {
      const value = JSON.parse(readFileSync(roster(), 'utf8')); value.accounts[0].expectedAccountHint = 'd'.repeat(64);
      writeFileSync(roster(), JSON.stringify(value)); return { ok: true, launch };
    });
    expect(readClaudeNativeBinding(cfg, launch.seatId)).toBeNull();
  });
  it('checks keychain-only absence AFTER post-stamps and final roster equality', () => {
    mutateOnFinalRoster(writeIdentity); expect(readClaudeNativeBinding(cfg, launch.seatId)).toBeNull();
  });
  it('checks OAuth file epoch AFTER post-stamps and final roster equality', () => {
    writeIdentity(); mutateOnFinalRoster(() => writeFileSync(metadata(), JSON.stringify({ oauthAccount: { ...identity, organizationUuid: 'different' } })));
    expect(readClaudeNativeBinding(cfg, launch.seatId)).toBeNull();
  });
  it.each(['missing', 'present'])('refuses replacement of the native-state directory for %s OAuth metadata', kind => {
    if (kind === 'present') writeIdentity();
    mutateOnFinalRoster(() => { renameSync(state, state + '-old'); mkdirSync(state, { mode: 0o700 }); if (kind === 'present') writeIdentity(); });
    expect(readClaudeNativeBinding(cfg, launch.seatId)).toBeNull();
  });
  it.each(['public', 'symlink', 'hardlink', 'malformed', 'oversized'])('holds existing %s OAuth metadata instead of treating it as absent', kind => {
    writeIdentity();
    if (kind === 'public') chmodSync(metadata(), 0o644);
    if (kind === 'symlink') { renameSync(metadata(), metadata() + '-other'); symlinkSync(metadata() + '-other', metadata()); }
    if (kind === 'hardlink') linkSync(metadata(), metadata() + '-other');
    if (kind === 'malformed') writeFileSync(metadata(), '{}');
    if (kind === 'oversized') writeFileSync(metadata(), JSON.stringify({ padding: 'x'.repeat(2 * 1024 * 1024) }));
    expect(readClaudeNativeBinding(cfg, launch.seatId)).toBeNull();
  });
});
