/**
 * `ashlr wire status`: read-only wiring report. Hermetic: temp files only, no
 * vendor CLI, no real home directory.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { inspectEditorWiring } from '../src/core/integrations/editors.js';
import { cmdWire } from '../src/cli/wire.js';

const roots: string[] = [];
function root(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-wire-status-'));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function snapshotTree(dir: string): string {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const name of fs.readdirSync(d).sort()) {
      const full = path.join(d, name);
      const st = fs.lstatSync(full);
      if (st.isDirectory()) walk(full);
      else out.push(`${path.relative(dir, full)}:${st.size}:${st.mtimeMs}:${fs.readFileSync(full, 'utf8')}`);
    }
  };
  walk(dir);
  return out.join('\n');
}

const claudeEntry = { type: 'stdio', command: 'ashlr', args: ['mcp'], env: {} };
const cursorEntry = { command: 'ashlr', args: ['mcp'] };

describe('inspectEditorWiring', () => {
  it('reports a missing config as not wired without creating anything', () => {
    const dir = root();
    const configPath = path.join(dir, 'mcp.json');
    const status = inspectEditorWiring('cursor', { configPath, home: dir, pathEnv: '' });
    expect(status).toMatchObject({ configFound: false, wired: false, matchesExpected: false, backupFound: false });
    expect(status.error).toBeUndefined();
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('reports wired with the exact expected entry (claude and cursor)', () => {
    const dir = root();
    const claude = path.join(dir, '.claude.json');
    const cursor = path.join(dir, 'mcp.json');
    fs.writeFileSync(claude, JSON.stringify({ mcpServers: { 'ashlr-hub': claudeEntry, other: { command: 'x' } } }));
    fs.writeFileSync(cursor, JSON.stringify({ mcpServers: { 'ashlr-hub': cursorEntry } }));
    expect(inspectEditorWiring('claude', { configPath: claude, home: dir, pathEnv: '' }))
      .toMatchObject({ configFound: true, wired: true, matchesExpected: true });
    expect(inspectEditorWiring('cursor', { configPath: cursor, home: dir, pathEnv: '' }))
      .toMatchObject({ configFound: true, wired: true, matchesExpected: true });
  });

  it('reports a modified entry as wired but not matching, and never returns env values', () => {
    const dir = root();
    const cursor = path.join(dir, 'mcp.json');
    fs.writeFileSync(cursor, JSON.stringify({
      mcpServers: { 'ashlr-hub': { command: 'other', args: ['mcp'], env: { TOKEN: 'synthetic-secret-value' } } },
    }));
    const status = inspectEditorWiring('cursor', { configPath: cursor, home: dir, pathEnv: '' });
    expect(status).toMatchObject({ wired: true, matchesExpected: false });
    expect(JSON.stringify(status)).not.toContain('synthetic-secret-value');
  });

  it('reports malformed JSON as an error instead of throwing', () => {
    const dir = root();
    const claude = path.join(dir, '.claude.json');
    fs.writeFileSync(claude, '{ not json');
    const status = inspectEditorWiring('claude', { configPath: claude, home: dir, pathEnv: '' });
    expect(status.wired).toBe(false);
    expect(status.error).toBeTruthy();
  });

  it('detects a backup file next to the config', () => {
    const dir = root();
    const cursor = path.join(dir, 'mcp.json');
    fs.writeFileSync(cursor, '{}');
    fs.writeFileSync(`${cursor}.bak`, '{}');
    expect(inspectEditorWiring('cursor', { configPath: cursor, home: dir, pathEnv: '' }).backupFound).toBe(true);
  });

  it('reads the codex config.toml section for the gateway server', () => {
    const dir = root();
    const toml = path.join(dir, 'config.toml');
    fs.writeFileSync(toml, [
      'model = "x"',
      '[mcp_servers.other]',
      'command = "other"',
      '[mcp_servers.ashlr-hub]',
      'command = "ashlr"',
      'args = ["mcp"]',
      '[mcp_servers.after]',
      'command = "nope"',
      '',
    ].join('\n'));
    expect(inspectEditorWiring('codex', { configPath: toml, home: dir, pathEnv: '' }))
      .toMatchObject({ configFound: true, wired: true, matchesExpected: true });
    fs.writeFileSync(toml, '[mcp_servers.ashlr-hub]\ncommand = "ashlr"\nargs = ["mcp", "--extra"]\n');
    expect(inspectEditorWiring('codex', { configPath: toml, home: dir, pathEnv: '' }))
      .toMatchObject({ wired: true, matchesExpected: false });
    fs.writeFileSync(toml, '[mcp_servers.other]\ncommand = "ashlr"\nargs = ["mcp"]\n');
    expect(inspectEditorWiring('codex', { configPath: toml, home: dir, pathEnv: '' }))
      .toMatchObject({ wired: false });
  });
});

describe('ashlr wire status (CLI)', () => {
  it('prints JSON for one target and changes nothing on disk', async () => {
    const dir = root();
    const cursor = path.join(dir, 'mcp.json');
    fs.writeFileSync(cursor, JSON.stringify({ mcpServers: { 'ashlr-hub': cursorEntry } }, null, 2));
    fs.writeFileSync(`${cursor}.bak`, '{}');
    const before = snapshotTree(dir);
    let out = '';
    vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
      out += String(chunk);
      return true;
    });
    const code = await cmdWire(['status', 'cursor', '--config', cursor, '--json']);
    expect(code).toBe(0);
    const parsed = JSON.parse(out) as { clients: Array<Record<string, unknown>> };
    expect(parsed.clients).toHaveLength(1);
    expect(parsed.clients[0]).toMatchObject({
      target: 'cursor', configPath: cursor, configFound: true, wired: true, matchesExpected: true, backupFound: true,
    });
    expect(snapshotTree(dir)).toBe(before);
  });

  it('exits 1 when a config cannot be parsed and 2 on bad usage', async () => {
    const dir = root();
    const claude = path.join(dir, '.claude.json');
    fs.writeFileSync(claude, '{ nope');
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    expect(await cmdWire(['status', 'claude', '--config', claude])).toBe(1);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await cmdWire(['status', '--config', claude])).toBe(2);
    expect(stderr).toHaveBeenCalled();
  });
});
