import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeCfg, makeFixture, type H1Fixture } from './helpers/h1-fixture.js';
import { auditPlugin, pluginDataDir, pluginDir, pluginsRootDir } from '../src/core/plugins/host-api.js';
import { readManifest } from '../src/core/plugins/manifest.js';
import * as registry from '../src/core/plugins/registry.js';
import {
  PLUGIN_CAPABILITIES,
  isPluginCapability,
  isPluginRecord,
  isValidPluginName,
  pluginErrorMessage,
} from '../src/core/plugins/types.js';

let fx: H1Fixture;

beforeEach(() => {
  fx = makeFixture();
  registry._resetPluginCacheForTest();
});

afterEach(() => {
  registry._resetPluginCacheForTest();
  fx.cleanup();
});

describe('plugins shared guards, paths, audit, and command helpers', () => {
  it('validates plugin names, capabilities, plain records, and error messages consistently', () => {
    expect(PLUGIN_CAPABILITIES).toEqual(['scanner', 'template', 'provider', 'command']);
    for (const cap of PLUGIN_CAPABILITIES) {
      expect(isPluginCapability(cap)).toBe(true);
    }
    expect(isPluginCapability('unknown')).toBe(false);
    expect(isPluginCapability(null)).toBe(false);

    expect(isValidPluginName('a')).toBe(true);
    expect(isValidPluginName('my-plugin-1')).toBe(true);
    expect(isValidPluginName('a' + 'b'.repeat(39))).toBe(true);
    expect(isValidPluginName('a' + 'b'.repeat(40))).toBe(false);
    expect(isValidPluginName('BadName')).toBe(false);
    expect(isValidPluginName('1bad')).toBe(false);
    expect(isValidPluginName(42)).toBe(false);

    expect(isPluginRecord({ ok: true })).toBe(true);
    expect(isPluginRecord(null)).toBe(false);
    expect(isPluginRecord([])).toBe(false);
    expect(isPluginRecord('str')).toBe(false);

    expect(pluginErrorMessage(new Error('boom'))).toBe('boom');
    expect(pluginErrorMessage('plain')).toBe('plain');
  });

  it('resolves plugin directories against the active HOME and writes plugin-scoped audits', () => {
    expect(pluginsRootDir()).toBe(join(fx.ashlrDir, 'plugins'));
    expect(pluginDir('demo')).toBe(join(fx.ashlrDir, 'plugins', 'demo'));
    expect(pluginDataDir('demo')).toBe(join(fx.ashlrDir, 'plugin-data', 'demo'));

    auditPlugin('plugin:demo:check', 'shared audit test', 'refused');
    const auditDir = join(fx.ashlrDir, 'audit');
    expect(existsSync(auditDir)).toBe(true);
    const lines = readdirSync(auditDir)
      .filter((f) => f.endsWith('.jsonl'))
      .flatMap((f) => readFileSync(join(auditDir, f), 'utf8').trim().split('\n'))
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines).toContainEqual(expect.objectContaining({
      action: 'plugin:demo:check',
      repo: null,
      sandboxId: null,
      summary: 'shared audit test',
      result: 'refused',
    }));
  });

  it('rejects proto-pollution keys nested inside manifest arrays', () => {
    const dir = pluginDir('nested-poison');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'manifest.json'),
      '{"name":"nested-poison","version":"0.1.0","apiVersion":"1.0.0","entry":"./index.mjs","capabilities":["scanner"],"extra":[{"__proto__":{"polluted":true}}]}',
      'utf8',
    );
    const res = readManifest(dir);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toContain('forbidden key');
  });

  it('runs enabled plugin commands via runPluginCommand and omits the pruned dead export', async () => {
    expect('getPluginCommands' in registry).toBe(false);

    const dir = pluginDir('cmd-shared');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'manifest.json'),
      JSON.stringify({
        name: 'cmd-shared',
        version: '0.1.0',
        apiVersion: '^1.0.0',
        entry: './index.mjs',
        capabilities: ['command'],
      }),
      'utf8',
    );
    const entry = join(dir, 'index.mjs');
    writeFileSync(
      entry,
      `export default {
        activate() {
          return {
            commands: [
              { name: 'ping', description: 'ok', async run(args) { return args[0] === 'ok' ? 0 : 9; } },
              { name: 'boom', description: 'throws', async run() { throw new Error('explode'); } },
            ],
          };
        },
      };\n`,
      'utf8',
    );
    const pin = `sha256:${createHash('sha256').update(readFileSync(entry)).digest('hex')}`;
    const cfg = makeCfg({
      plugins: { enabled: ['cmd-shared'], settings: {}, integrity: { 'cmd-shared': pin } },
    });

    expect(await registry.runPluginCommand(cfg, 'ping', ['ok'])).toBe(0);
    expect(await registry.runPluginCommand(cfg, 'ping', ['other'])).toBe(9);
    expect(await registry.runPluginCommand(cfg, 'boom', [])).toBe(1);
    expect(await registry.runPluginCommand(cfg, 'missing', [])).toBeNull();
  });
});
