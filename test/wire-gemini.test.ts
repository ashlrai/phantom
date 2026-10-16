/**
 * Gemini CLI target: status-only. Hermetic temp files, no vendor CLI.
 * Config format source: google-gemini/gemini-cli docs/tools/mcp-server.md
 * (`mcpServers` object in ~/.gemini/settings.json).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  ALL_EDITOR_TARGETS,
  detectEditors,
  inspectEditorWiring,
  wireEditor,
} from '../src/core/integrations/editors.js';
import { cmdWire } from '../src/cli/wire.js';

const roots: string[] = [];
function root(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-wire-gemini-'));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('gemini status', () => {
  it('is listed in all targets', () => {
    expect(ALL_EDITOR_TARGETS).toContain('gemini');
  });

  it('reports wired with the expected entry and ignores unrelated settings', () => {
    const dir = root();
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, JSON.stringify({
      theme: 'x',
      mcpServers: { 'ashlr-hub': { command: 'ashlr', args: ['mcp'] }, other: { command: 'y' } },
    }));
    expect(inspectEditorWiring('gemini', { configPath: file, home: dir, pathEnv: '' }))
      .toMatchObject({ target: 'gemini', configFound: true, wired: true, matchesExpected: true });
  });

  it('reports not wired and differing entries', () => {
    const dir = root();
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: 'y' } } }));
    expect(inspectEditorWiring('gemini', { configPath: file, home: dir, pathEnv: '' }))
      .toMatchObject({ configFound: true, wired: false });
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { 'ashlr-hub': { command: 'z', args: [] } } }));
    expect(inspectEditorWiring('gemini', { configPath: file, home: dir, pathEnv: '' }))
      .toMatchObject({ wired: true, matchesExpected: false });
  });

  it('defaults to a missing config without creating anything', () => {
    const dir = root();
    const status = inspectEditorWiring('gemini', { home: dir, pathEnv: '' });
    expect(status.configPath.endsWith(path.join('.gemini', 'settings.json'))).toBe(true);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('detects ~/.gemini for status but never feeds it to the writing path', () => {
    const dir = root();
    fs.mkdirSync(path.join(dir, '.gemini'));
    expect(detectEditors({ home: dir, pathEnv: '' })).not.toContain('gemini');
    expect(detectEditors({ home: dir, pathEnv: '', includeStatusOnly: true })).toContain('gemini');
    expect(inspectEditorWiring('gemini', { home: dir, pathEnv: '' }).detected).toBe(true);
  });
});

describe('gemini write is refused', () => {
  it('wireEditor does not touch the config', async () => {
    const dir = root();
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, '{"a":1}');
    const res = await wireEditor('gemini', { configPath: file });
    expect(res.ok).toBe(false);
    expect(res.detail).toMatch(/status-only/);
    expect(fs.readFileSync(file, 'utf8')).toBe('{"a":1}');
    expect(fs.readdirSync(dir)).toEqual(['settings.json']);
  });

  it('wire gemini exits 1 and wire status gemini --json works', async () => {
    const dir = root();
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { 'ashlr-hub': { command: 'ashlr', args: ['mcp'] } } }));
    let out = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => { out += String(c); return true; });
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdWire(['status', 'gemini', '--config', file, '--json'])).toBe(0);
    const parsed = JSON.parse(out) as { clients: Array<Record<string, unknown>> };
    expect(parsed.clients[0]).toMatchObject({ target: 'gemini', wired: true, matchesExpected: true });
    expect(await cmdWire(['gemini', '--config', file, '--json'])).toBe(1);
  });
});
