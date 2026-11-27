import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { setImessageBridge } from '../src/core/comms/owner-adapters-file.js';
import { loadOwnerThreadSettings } from '../src/core/comms/owner-channel.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function setup(text: string): { root: string; file: string } {
  const root = mkdtempSync(join(tmpdir(), 'bridge-switch-'));
  roots.push(root);
  mkdirSync(join(root, 'comms'));
  const file = join(root, 'comms', 'owner-adapters.toml');
  writeFileSync(file, text);
  return { root, file };
}

describe('quoted owner adapter bridge switch', () => {
  it.each([
    ['[imessage]', 'bridge'],
    ['["imessage"]', 'bridge'],
    ['[imessage]', '"bridge"'],
    ['["imessage"]', '"bridge"'],
    ["['imessage']", "'bridge'"],
    ['["imess\\u0061ge"]', '"brid\\u0067e"'],
  ])('switches %s %s without disturbing other settings', (header, key) => {
    const before = `# header\n${header} # section\n${key} = "loopback" # bridge comment\n[telegram]\nsecretHandle = "phm_TELEGRAM_BOT_TOKEN" # telegram comment\n[slack]\nsecretHandle = "phm_SLACK_BOT_TOKEN" # slack comment\n`;
    const { root, file } = setup(before);
    const settings = loadOwnerThreadSettings(root);
    expect(settings.imessageBridge).toBe('loopback');
    expect(setImessageBridge(root, false).changed).toBe(true);
    expect(loadOwnerThreadSettings(root)).toEqual({ ...settings, imessageBridge: 'off' });
    expect(readFileSync(file, 'utf8')).toBe(before.replace('"loopback"', '"off"'));
    expect(setImessageBridge(root, false).changed).toBe(false);
    expect(setImessageBridge(root, true).changed).toBe(true);
    expect(loadOwnerThreadSettings(root)).toEqual(settings);
    expect(readFileSync(file, 'utf8')).toBe(before);
    expect(setImessageBridge(root, true).changed).toBe(false);
  });

  it('adds a missing key to a quoted section', () => {
    const { root, file } = setup('["imessage"] # keep\n# existing\n[slack]\n# untouched\n');
    setImessageBridge(root, true);
    expect(loadOwnerThreadSettings(root).imessageBridge).toBe('loopback');
    expect(readFileSync(file, 'utf8')).toContain('# existing\n[slack]\n# untouched');
  });

  it('refuses malformed TOML without changing bytes', () => {
    const before = '["imessage"]\nbridge = "loopback"\n[slack\n';
    const { root, file } = setup(before);
    expect(() => setImessageBridge(root, false)).toThrow(/invalid owner adapters TOML/);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });

  it('refuses an unsupported inline table without changing bytes', () => {
    const before = 'imessage = { bridge = "loopback", extra = true } # keep\n';
    const { root, file } = setup(before);
    expect(() => setImessageBridge(root, false)).toThrow(/no safe TOML edit/);
    expect(readFileSync(file, 'utf8')).toBe(before);
  });
});
