/** `wire sync`: dry run by default, backups, undo. Hermetic temp dirs only. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { applyEditorSync, planEditorSync, undoEditorSync } from '../src/core/integrations/editors.js';
import { cmdWire } from '../src/cli/wire.js';

const roots: string[] = [];
function root(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ashlr-wire-sync-'));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});
function tree(dir: string): string {
  return fs.readdirSync(dir).sort().map(n => `${n}:${fs.readFileSync(path.join(dir, n), 'utf8')}`).join('\n');
}
async function run(args: string[]): Promise<{ code: number; json: any }> {
  let out = '';
  vi.spyOn(process.stdout, 'write').mockImplementation((c: string | Uint8Array) => { out += String(c); return true; });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const code = await cmdWire(args);
  vi.restoreAllMocks();
  return { code, json: out ? JSON.parse(out) : undefined };
}
const entry = { command: 'ashlr', args: ['mcp'] };

describe('wire sync', () => {
  it('writes nothing without --apply and reports planned changes', async () => {
    const dir = root();
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, JSON.stringify({ theme: 'x', mcpServers: { other: { command: 'o' } } }));
    const before = tree(dir);
    const { code, json } = await run(['sync', 'gemini', '--config', file, '--json']);
    expect(code).toBe(0);
    expect(json.mode).toBe('dry-run');
    expect(json.clients[0]).toMatchObject({ target: 'gemini', action: 'add', applied: false, configPath: file });
    expect(tree(dir)).toBe(before);
  });

  it('dry run on a missing config creates nothing', async () => {
    const dir = root();
    const file = path.join(dir, 'sub', 'mcp.json');
    const { json } = await run(['sync', 'cursor', '--config', file, '--json']);
    expect(json.clients[0].action).toBe('add');
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it('--apply preserves other keys, writes a timestamped backup and is idempotent', async () => {
    const dir = root();
    const file = path.join(dir, 'settings.json');
    const original = JSON.stringify({ theme: 'x', mcpServers: { other: { command: 'o' } } });
    fs.writeFileSync(file, original);
    const { code, json } = await run(['sync', 'gemini', '--apply', '--config', file, '--json']);
    expect(code).toBe(0);
    expect(json.clients[0]).toMatchObject({ applied: true });
    const written = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(written.theme).toBe('x');
    expect(written.mcpServers.other).toEqual({ command: 'o' });
    expect(written.mcpServers['ashlr-hub']).toEqual(entry);
    const backup = json.clients[0].backupPath as string;
    expect(path.basename(backup)).toMatch(/^settings\.json\.wire-sync-\d{13}-[0-9a-f]{8}\.bak$/);
    expect(fs.readFileSync(backup, 'utf8')).toBe(original);
    const again = await run(['sync', 'gemini', '--apply', '--config', file, '--json']);
    expect(again.json.clients[0]).toMatchObject({ action: 'unchanged', applied: false });
  });

  it('refuses malformed JSON and never overwrites a differing entry', async () => {
    const dir = root();
    const bad = path.join(dir, 'bad.json');
    fs.writeFileSync(bad, '{ not json');
    const r1 = await run(['sync', 'gemini', '--apply', '--config', bad, '--json']);
    expect(r1.code).toBe(1);
    expect(r1.json.clients[0].action).toBe('invalid');
    expect(fs.readFileSync(bad, 'utf8')).toBe('{ not json');
    const diff = path.join(dir, 'diff.json');
    const text = JSON.stringify({ mcpServers: { 'ashlr-hub': { command: 'other', args: [] } } });
    fs.writeFileSync(diff, text);
    const r2 = await run(['sync', 'cursor', '--apply', '--config', diff, '--json']);
    expect(r2.code).toBe(1);
    expect(r2.json.clients[0]).toMatchObject({ action: 'conflict', applied: false });
    expect(fs.readFileSync(diff, 'utf8')).toBe(text);
    expect(fs.readdirSync(dir).sort()).toEqual(['bad.json', 'diff.json']);
  });

  it('--undo restores the previous bytes, and removes a config sync created', async () => {
    const dir = root();
    const file = path.join(dir, 'settings.json');
    const original = '{"a": 1}\n';
    fs.writeFileSync(file, original);
    await run(['sync', 'gemini', '--apply', '--config', file, '--json']);
    const u = await run(['sync', 'gemini', '--undo', '--config', file, '--json']);
    expect(u.code).toBe(0);
    expect(u.json.clients[0].restored).toBe(true);
    expect(fs.readFileSync(file, 'utf8')).toBe(original);

    const fresh = path.join(dir, 'new', 'mcp.json');
    await run(['sync', 'cursor', '--apply', '--config', fresh, '--json']);
    expect(fs.existsSync(fresh)).toBe(true);
    const u2 = await run(['sync', 'cursor', '--undo', '--config', fresh, '--json']);
    expect(u2.json.clients[0].restored).toBe(true);
    expect(fs.existsSync(fresh)).toBe(false);
  });

  it('--undo refuses when the config changed after the sync', async () => {
    const dir = root();
    const file = path.join(dir, 'settings.json');
    fs.writeFileSync(file, '{}');
    await run(['sync', 'gemini', '--apply', '--config', file, '--json']);
    const edited = '{"user":"edit"}';
    fs.writeFileSync(file, edited);
    const u = await run(['sync', 'gemini', '--undo', '--config', file, '--json']);
    expect(u.code).toBe(1);
    expect(u.json.clients[0].restored).toBe(false);
    expect(fs.readFileSync(file, 'utf8')).toBe(edited);
  });

  it('undo with no backup is a no-op, and --apply with --undo is a usage error', async () => {
    const dir = root();
    const file = path.join(dir, 'settings.json');
    const u = await run(['sync', 'gemini', '--undo', '--config', file, '--json']);
    expect(u.code).toBe(0);
    expect(u.json.clients[0].restored).toBe(false);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await cmdWire(['sync', '--apply', '--undo'])).toBe(2);
  });

  it('default plan skips undetected clients and codex without touching anything', () => {
    const home = root();
    const codex = planEditorSync('codex', { home, pathEnv: '' });
    expect(codex.action).toBe('skip');
    const gem = planEditorSync('gemini', { home, pathEnv: '' });
    expect(gem).toMatchObject({ action: 'skip', detected: false });
    fs.mkdirSync(path.join(home, '.gemini'));
    expect(planEditorSync('gemini', { home, pathEnv: '' }).action).toBe('add');
    expect(applyEditorSync({ ...gem, action: 'skip' }).applied).toBe(false);
    expect(fs.readdirSync(home)).toEqual(['.gemini']);
    expect(undoEditorSync('gemini', { home }).restored).toBe(false);
  });
});
