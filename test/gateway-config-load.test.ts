/**
 * Gateway slice A2: the top-level `gateways` block is validated when config
 * loads. Absent block is a no-op. Problems name only the fixed client id or
 * field plus a closed reason; config values are never echoed. The lenient
 * loader warns; the strict activation loader refuses.
 *
 * Hermetic: HOME points at a temp dir; no network, no spawn.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gatewaysConfigProblems, loadConfigReadOnly, loadConfigReadOnlyStrict } from '../src/core/config.js';

const SECRET = 'SECRETVALUE';
let home: string; let savedHome: string | undefined;
function writeConfig(value: Record<string, unknown>): void {
  mkdirSync(join(home, '.ashlr'), { recursive: true, mode: 0o700 });
  writeFileSync(join(home, '.ashlr', 'config.json'), JSON.stringify({ version: 1, roots: [], ...value }), { mode: 0o600 });
}
beforeEach(() => {
  savedHome = process.env['HOME'];
  home = mkdtempSync(join(tmpdir(), 'gateway-config-load-'));
  process.env['HOME'] = home;
});
afterEach(() => {
  vi.restoreAllMocks();
  if (savedHome === undefined) delete process.env['HOME']; else process.env['HOME'] = savedHome;
  rmSync(home, { recursive: true, force: true });
});

describe('gatewaysConfigProblems', () => {
  it.each([
    ['absent', undefined],
    ['null', null],
    ['empty', {}],
    ['disabled with no url', { anthropic: { enabled: false } }],
    ['valid loopback', { openaiAgents: { enabled: true, baseUrl: 'http://127.0.0.1:4000' } }],
    ['valid listed https', { anthropic: { enabled: true, baseUrl: 'https://gw.example.com/a', allowedHosts: ['gw.example.com:443'] } }],
    ['valid but disabled', { anthropic: { enabled: false, baseUrl: 'https://gw.example.com', allowedHosts: ['gw.example.com:443'] } }],
  ])('%s: no problems', (_label, value) => {
    expect(gatewaysConfigProblems(value)).toEqual([]);
  });

  it.each([
    ['not an object', 'https://gw.example.com', ['gateways: must be an object']],
    ['array', [], ['gateways: must be an object']],
    ['unknown client', { [`openai${SECRET}`]: {} }, ['gateways: 1 unrecognized client key(s); supported: anthropic, openaiAgents']],
    ['entry not an object', { anthropic: 'x' }, ['gateways.anthropic: must be an object']],
    ['unknown entry key', { anthropic: { enabled: false, [`ca${SECRET}`]: 'pem' } }, ['gateways.anthropic: 1 unrecognized key(s); supported: enabled, baseUrl, allowedHosts (custom CA and extra headers are not supported)']],
    ['enabled string', { anthropic: { enabled: 'true', baseUrl: 'http://127.0.0.1:4000' } }, ['gateways.anthropic.enabled: must be true or false']],
    ['enabled without url', { openaiAgents: { enabled: true } }, ['gateways.openaiAgents.baseUrl: required when enabled']],
    ['localhost', { anthropic: { enabled: true, baseUrl: 'http://localhost:4000' } }, ['gateways.anthropic: loopback-name-not-allowed']],
    ['unlisted', { anthropic: { enabled: true, baseUrl: 'https://gw.example.com' } }, ['gateways.anthropic: host-not-allowlisted']],
    ['host-only allowlist', { anthropic: { enabled: true, baseUrl: 'https://gw.example.com', allowedHosts: ['gw.example.com'] } }, ['gateways.anthropic: allowlist-invalid']],
    ['http remote', { anthropic: { enabled: true, baseUrl: 'http://gw.example.com', allowedHosts: ['gw.example.com:80'] } }, ['gateways.anthropic: http-requires-loopback']],
    ['disabled but invalid url', { anthropic: { enabled: false, baseUrl: 'ftp://gw.example.com' } }, ['gateways.anthropic: scheme-not-allowed']],
    ['two clients', { anthropic: { enabled: true, baseUrl: 'http://localhost:1' }, openaiAgents: { enabled: true, baseUrl: 'http://0.0.0.0:1' } }, ['gateways.anthropic: loopback-name-not-allowed', 'gateways.openaiAgents: ip-literal-not-allowed']],
  ])('%s', (_label, value, expected) => {
    expect(gatewaysConfigProblems(value)).toEqual(expected);
  });

  it('never echoes values, including userinfo, query and unknown key names', () => {
    const value = {
      anthropic: { enabled: true, baseUrl: `https://${SECRET}:${SECRET}@gw.example.com/?k=${SECRET}`, allowedHosts: ['gw.example.com:443'] },
      openaiAgents: { enabled: true, baseUrl: `https://${SECRET}.example.com`, [SECRET]: SECRET },
      [SECRET]: { enabled: true },
    };
    const problems = gatewaysConfigProblems(value);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join('\n')).not.toContain(SECRET);
    // The query is checked before userinfo; either way only the code is reported.
    expect(problems).toContain('gateways.anthropic: query-not-allowed');
  });
});

describe('config load', () => {
  it('absent gateways block: no warning and no gateways key in the result', () => {
    writeConfig({});
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const cfg = loadConfigReadOnly() as unknown as Record<string, unknown>;
    expect(warn.mock.calls.map(call => String(call[0])).filter(text => text.includes('gateways'))).toEqual([]);
    expect('gateways' in cfg).toBe(false);
    expect('gateways' in (loadConfigReadOnlyStrict() as unknown as Record<string, unknown>)).toBe(false);
  });

  it('valid block loads silently and is preserved', () => {
    const gateways = { openaiAgents: { enabled: true, baseUrl: 'http://127.0.0.1:4000' } };
    writeConfig({ gateways });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect((loadConfigReadOnly() as unknown as Record<string, unknown>)['gateways']).toEqual(gateways);
    expect((loadConfigReadOnlyStrict() as unknown as Record<string, unknown>)['gateways']).toEqual(gateways);
    expect(warn.mock.calls.map(call => String(call[0])).filter(text => text.includes('gateways'))).toEqual([]);
  });

  it('invalid block: lenient load warns without values, strict load refuses without values', () => {
    writeConfig({ gateways: { anthropic: { enabled: true, baseUrl: `https://${SECRET}@gw.example.com`, allowedHosts: ['gw.example.com:443'] } } });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    loadConfigReadOnly();
    const warned = warn.mock.calls.map(call => String(call[0])).filter(text => text.includes('gateways'));
    expect(warned).toHaveLength(1);
    expect(warned[0]).toContain('gateways.anthropic: userinfo-not-allowed');
    expect(warned[0]).not.toContain(SECRET);
    let message = '';
    try { loadConfigReadOnlyStrict(); } catch (error) { message = (error as Error).message; }
    expect(message).toContain('Refusing autonomous activation');
    expect(message).toContain('gateways.anthropic: userinfo-not-allowed');
    expect(message).not.toContain(SECRET);
  });
});
