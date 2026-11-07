import { chmodSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AshlrConfig } from '../src/core/types.js';
const config = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../src/core/config.js', () => ({ loadConfigReadOnlyStrict: config.read, loadConfig: vi.fn(() => { throw new Error('legacy config forbidden'); }) }));
import { cmdComms } from '../src/cli/comms.js';
import { initializeOperatorSecret, readOperatorSecret } from '../src/core/fleet/operator-proof.js';
import { acceptTelegramPair } from '../src/core/fleet/operator-glance-read.js';
import * as telegram from '../src/core/integrations/telegram.js';

let home: string;
const owner = '1234567';
const cfg = () => ({ comms: { enabled: true, channel: 'telegram', telegram: { botToken: 'fake-local-pair-token', chatId: owner } } }) as AshlrConfig;
const secretPath = () => join(home, '.ashlr/comms/operator-secret');
const pairPath = () => join(home, '.ashlr-runs/queue/telegram-pair.json');
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'telegram-local-pair-')); vi.stubEnv('HOME', home); vi.stubEnv('USERPROFILE', home);
  vi.stubEnv('PHANTOM_OPERATOR_SECRET', undefined); vi.stubEnv('TELEGRAM_BOT_TOKEN', '');
  config.read.mockReset().mockImplementation(cfg);
  vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });
const output = () => JSON.parse(String(vi.mocked(console.log).mock.calls.at(-1)?.[0]));

describe('explicit local Telegram operator setup', () => {
  it('creates one private random secret and uses normal pairing; second run preserves exact credentials and owner', async () => {
    expect(await cmdComms(['pair-telegram', '--json'])).toBe(0);
    expect(output()).toEqual({ ok: true, reason: 'paired', secretCreated: true });
    const secret = readFileSync(secretPath(), 'utf8'); const pair = readFileSync(pairPath(), 'utf8');
    expect(secret).toMatch(/^[a-f0-9]{64}\n$/);
    expect(lstatSync(secretPath()).mode & 0o777).toBe(0o600);
    expect(lstatSync(pairPath()).mode & 0o777).toBe(0o600);
    expect(acceptTelegramPair(Number(owner), join(home, '.ashlr-runs'))).toBe(true);
    expect(acceptTelegramPair(999, join(home, '.ashlr-runs'))).toBe(false);
    expect(await cmdComms(['pair-telegram', '--json'])).toBe(0);
    expect(output()).toEqual({ ok: true, reason: 'paired', secretCreated: false });
    expect(readFileSync(secretPath(), 'utf8')).toBe(secret); expect(readFileSync(pairPath(), 'utf8')).toBe(pair);
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain(secret.trim());
  });
  it('refuses another paired owner before creating a credential', async () => {
    mkdirSync(join(home, '.ashlr-runs/queue'), { recursive: true, mode: 0o700 });
    const original = JSON.stringify({ v: 1, userId: 999 }); writeFileSync(pairPath(), original, { mode: 0o600 });
    expect(await cmdComms(['pair-telegram', '--json'])).toBe(1);
    expect(output().reason).toBe('existing-owner-conflict');
    expect(existsSync(secretPath())).toBe(false); expect(readFileSync(pairPath(), 'utf8')).toBe(original);
  });
  it.each(['-123', '0', '1.5', '9007199254740992', '123junk'])('refuses invalid configured private id %s with no files', async chatId => {
    config.read.mockReturnValue({ ...cfg(), comms: { ...cfg().comms, telegram: { botToken: 'fake', chatId } } });
    expect(await cmdComms(['pair-telegram', '--json'])).toBe(1);
    expect(output().reason).toBe('configured-private-owner-required');
    expect(existsSync(join(home, '.ashlr-runs'))).toBe(false); expect(existsSync(secretPath())).toBe(false);
  });
  it('refuses disabled, missing-token or unavailable configuration without setup effects', async () => {
    for (const comms of [{ ...cfg().comms, enabled: false }, { ...cfg().comms, telegram: { chatId: owner } }]) {
      config.read.mockReturnValue({ comms }); expect(await cmdComms(['pair-telegram', '--json'])).toBe(1);
    }
    config.read.mockImplementation(() => { throw new Error('private path must not escape'); });
    expect(await cmdComms(['pair-telegram', '--json'])).toBe(1);
    expect(existsSync(secretPath())).toBe(false); expect(existsSync(pairPath())).toBe(false);
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain('private path');
  });
  it('preserves existing valid secret and refuses an invalid environment credential without replacing it', async () => {
    mkdirSync(join(home, '.ashlr/comms'), { recursive: true, mode: 0o700 });
    writeFileSync(secretPath(), 'existing-pairing-secret-unchanged\n', { mode: 0o600 });
    expect(await cmdComms(['pair-telegram', '--json'])).toBe(0);
    expect(readFileSync(secretPath(), 'utf8')).toBe('existing-pairing-secret-unchanged\n');
    vi.stubEnv('PHANTOM_OPERATOR_SECRET', 'short');
    expect(initializeOperatorSecret()).toEqual({ ok: false, created: false });
    expect(readFileSync(secretPath(), 'utf8')).toBe('existing-pairing-secret-unchanged\n');
  });
  it('never overwrites malformed, public, symlinked or hardlinked credentials', () => {
    mkdirSync(join(home, '.ashlr/comms'), { recursive: true, mode: 0o700 });
    writeFileSync(secretPath(), 'short', { mode: 0o600 });
    expect(initializeOperatorSecret().ok).toBe(false); expect(readFileSync(secretPath(), 'utf8')).toBe('short');
    rmSync(secretPath()); writeFileSync(secretPath(), 'existing-valid-but-public-secret', { mode: 0o644 });
    expect(initializeOperatorSecret().ok).toBe(false); rmSync(secretPath());
    const sentinel = join(home, 'sentinel'); writeFileSync(sentinel, 'sentinel-credential-unchanged', { mode: 0o600 });
    symlinkSync(sentinel, secretPath()); expect(initializeOperatorSecret().ok).toBe(false); rmSync(secretPath());
    linkSync(sentinel, secretPath()); expect(initializeOperatorSecret().ok).toBe(false);
    expect(readFileSync(sentinel, 'utf8')).toBe('sentinel-credential-unchanged');
  });
  it('refuses unsafe pair and directory paths before credential creation', async () => {
    const sentinel = join(home, 'sentinel'); writeFileSync(sentinel, '{}', { mode: 0o600 });
    mkdirSync(join(home, '.ashlr-runs/queue'), { recursive: true, mode: 0o700 });
    symlinkSync(sentinel, pairPath()); expect(await cmdComms(['pair-telegram', '--json'])).toBe(1);
    expect(existsSync(secretPath())).toBe(false); rmSync(pairPath());
    chmodSync(join(home, '.ashlr-runs/queue'), 0o777); expect(await cmdComms(['pair-telegram', '--json'])).toBe(1);
    expect(existsSync(secretPath())).toBe(false); expect(readFileSync(sentinel, 'utf8')).toBe('{}');
  });
  it('rejects a changed configured owner before pairing, retaining only the newly private credential', async () => {
    config.read.mockReturnValueOnce(cfg()).mockReturnValue({ ...cfg(), comms: { ...cfg().comms, telegram: { botToken: 'fake-local-pair-token', chatId: '999' } } });
    expect(await cmdComms(['pair-telegram', '--json'])).toBe(1);
    expect(output()).toEqual({ ok: false, reason: 'configuration-changed', secretCreated: true });
    expect(existsSync(pairPath())).toBe(false); expect(readOperatorSecret().state).toBe('ready');
  });
  it('uses an existing valid environment credential without writing a credential file', async () => {
    vi.stubEnv('PHANTOM_OPERATOR_SECRET', 'existing-environment-secret-123');
    expect(await cmdComms(['pair-telegram', '--json'])).toBe(0);
    expect(existsSync(secretPath())).toBe(false); expect(existsSync(pairPath())).toBe(true);
    expect(JSON.stringify(vi.mocked(console.log).mock.calls)).not.toContain('existing-environment-secret-123');
  });
  it('refuses a linked or public secret directory without writing through it', () => {
    const foreign = join(home, 'elsewhere'); mkdirSync(foreign, { mode: 0o700 }); mkdirSync(join(home, '.ashlr'), { mode: 0o700 });
    symlinkSync(foreign, join(home, '.ashlr/comms'));
    expect(initializeOperatorSecret().ok).toBe(false); expect(existsSync(join(foreign, 'operator-secret'))).toBe(false);
    rmSync(join(home, '.ashlr/comms')); mkdirSync(join(home, '.ashlr/comms'), { mode: 0o755 });
    expect(initializeOperatorSecret().ok).toBe(false); expect(existsSync(secretPath())).toBe(false);
  });
  it('refuses Windows new-file initialization before any setup filesystem effect', async () => {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      expect(initializeOperatorSecret()).toEqual({ ok: false, created: false });
      expect(await cmdComms(['pair-telegram', '--json'])).toBe(1);
      expect(output()).toEqual({ ok: false, reason: 'operator-secret-initialization-unsupported', secretCreated: false });
      expect(existsSync(join(home, '.ashlr'))).toBe(false); expect(existsSync(join(home, '.ashlr-runs'))).toBe(false);
    } finally { Object.defineProperty(process, 'platform', original); }
  });
  it('does not contact Telegram or accept identity/secret/path arguments; help has no config or filesystem effects', async () => {
    const send = vi.spyOn(telegram, 'sendTelegramMessage'), poll = vi.spyOn(telegram, 'pollTelegramUpdates');
    for (const args of [['--owner', owner], ['--secret', 'secret'], ['--json', '--json'], ['extra'], ['--path', '/tmp']]) {
      expect(await cmdComms(['pair-telegram', ...args])).toBe(2);
    }
    expect(await cmdComms(['pair-telegram', '--help'])).toBe(0);
    expect(config.read).not.toHaveBeenCalled(); expect(existsSync(pairPath())).toBe(false);
    expect(send).not.toHaveBeenCalled(); expect(poll).not.toHaveBeenCalled();
  });
});
