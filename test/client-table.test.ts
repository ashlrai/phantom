/** Shared client table: shape, JSON export, and wiring consumes it. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { CLIENT_TABLE, clientTableJson, getClient } from '../src/core/integrations/client-table.js';
import {
  ALL_EDITOR_TARGETS,
  WRITABLE_EDITOR_TARGETS,
  detectEditors,
  inspectEditorWiring,
  wireEditor,
} from '../src/core/integrations/editors.js';
import { cmdWire } from '../src/cli/wire.js';

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function tmp(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-client-table-'));
  roots.push(dir);
  return dir;
}

describe('windsurf and gemini rows', () => {
  it('windsurf is status-only with the Rust-side path, and is never wired by default wire', async () => {
    const w = getClient('windsurf');
    expect(w.wire).toBe('status');
    expect(w.configPath.linux).toEqual(['.codeium', 'windsurf', 'mcp_config.json']);
    expect(WRITABLE_EDITOR_TARGETS).not.toContain('windsurf');
    const home = tmp();
    fs.mkdirSync(path.join(home, '.codeium', 'windsurf'), { recursive: true });
    expect(detectEditors({ home, pathEnv: '' })).toEqual([]);
    expect(detectEditors({ home, pathEnv: '', includeStatusOnly: true })).toEqual(['windsurf']);
    const file = path.join(home, 'mcp_config.json');
    fs.writeFileSync(file, JSON.stringify({ mcpServers: { 'ashlr-hub': { command: 'ashlr', args: ['mcp'] } } }));
    expect(inspectEditorWiring('windsurf', { configPath: file, home, pathEnv: '' }))
      .toMatchObject({ target: 'windsurf', wired: true, matchesExpected: true });
    const res = await wireEditor('windsurf', { configPath: file });
    expect(res.ok).toBe(false);
  });

  it('gemini records its project-scoped config path', () => {
    expect(getClient('gemini').projectConfigPath).toEqual(['.gemini', 'settings.json']);
  });

  it('status JSON keeps the agreed fields (stable contract)', () => {
    const home = tmp();
    const status = inspectEditorWiring('gemini', { home, pathEnv: '' });
    for (const key of ['target', 'configPath', 'detected', 'wired', 'matchesExpected', 'backupFound']) {
      expect(status).toHaveProperty(key);
    }
  });
});

describe('client table', () => {
  it('has unique ids, one server name, and home-relative paths for every OS', () => {
    const ids = CLIENT_TABLE.map(c => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(['claude', 'codex', 'cursor', 'windsurf', 'gemini']);
    for (const c of CLIENT_TABLE) {
      expect(c.serverName).toBe('ashlr-hub');
      for (const os of ['darwin', 'linux', 'win32'] as const) {
        expect(c.configPath[os].length).toBeGreaterThan(0);
        expect(c.configPath[os].every(seg => !seg.includes('/') && !seg.includes('\\') && seg !== '..')).toBe(true);
      }
      expect(c.source.length).toBeGreaterThan(0);
    }
  });

  it('keeps docs/client-table.json in sync with the table', () => {
    const file = path.join(__dirname, '..', 'docs', 'client-table.json');
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual(JSON.parse(JSON.stringify(clientTableJson())));
  });

  it('is the source of the target lists', () => {
    expect([...ALL_EDITOR_TARGETS]).toEqual(CLIENT_TABLE.map(c => c.id));
    expect([...WRITABLE_EDITOR_TARGETS]).toEqual(CLIENT_TABLE.filter(c => c.wire === 'write').map(c => c.id));
    expect(getClient('gemini').wire).toBe('status');
  });

  it('drives detection and the default config path', () => {
    const home = tmp();
    fs.mkdirSync(path.join(home, '.cursor'));
    expect(detectEditors({ home, pathEnv: '' })).toEqual(['cursor']);
    const status = inspectEditorWiring('cursor', { home, pathEnv: '' });
    expect(status.configPath.endsWith(path.join('.cursor', 'mcp.json'))).toBe(true);
  });

  it('writes exactly the entry the table describes (claude and cursor)', async () => {
    const dir = tmp();
    for (const id of ['claude', 'cursor'] as const) {
      const file = path.join(dir, `${id}.json`);
      expect((await wireEditor(id, { configPath: file })).ok).toBe(true);
      const written = JSON.parse(fs.readFileSync(file, 'utf8')) as { mcpServers: Record<string, unknown> };
      expect(written.mcpServers[getClient(id).serverName]).toEqual(JSON.parse(JSON.stringify(getClient(id).wiredEntry)));
      expect(inspectEditorWiring(id, { configPath: file, home: dir, pathEnv: '' }).matchesExpected).toBe(true);
    }
  });

  it('wire table prints the JSON export and changes nothing', async () => {
    let out = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => { out += String(c); return true; });
    expect(await cmdWire(['table'])).toBe(0);
    expect(JSON.parse(out)).toEqual(JSON.parse(JSON.stringify(clientTableJson())));
  });
});
