/**
 * `phm mcp ecosystem` registers Ashlr MD's native MCP server (`mdopener-mcp`)
 * as the optional `ashlr-md` entry, under the same native-executable rule as
 * Phantom Secrets and Locus.
 *
 * Hermetic: HOME, USERPROFILE, LOCUS_HOME and PATH point into a temp root.
 * The native fixture is a copy of a real system binary (/bin/true) renamed to
 * mdopener-mcp; detection reads its header and never runs it.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { mergeEcosystemServers, cmdMcp } from '../src/cli/mcp.js';

const tmpRoots: string[] = [];
const NATIVE_SOURCE = '/bin/true';
const unixWithNative = process.platform !== 'win32' && fs.existsSync(NATIVE_SOURCE);

afterEach(() => {
  for (const root of tmpRoots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

function fixture(): { root: string; bin: string; settings: string } {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'phm-eco-md-')));
  tmpRoots.push(root);
  vi.stubEnv('HOME', root);
  vi.stubEnv('USERPROFILE', root);
  vi.stubEnv('LOCUS_HOME', path.join(root, 'locus-home'));
  const bin = path.join(root, 'bin');
  fs.mkdirSync(bin);
  vi.stubEnv('PATH', bin);
  return { root, bin, settings: path.join(root, '.ashlr', 'settings.json') };
}

async function runEcosystem(args: string[]): Promise<{ code: number; stdout: string }> {
  const chunks: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => { chunks.push(values.map(String).join(' ') + '\n'); });
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
    return true;
  }) as typeof process.stdout.write);
  const code = await cmdMcp(['ecosystem', ...args]);
  return { code, stdout: chunks.join('') };
}

describe('mcp ecosystem: Ashlr MD (mdopener-mcp)', () => {
  it.skipIf(!unixWithNative)('detects and registers a native mdopener-mcp on PATH as ashlr-md', async () => {
    const { bin, settings } = fixture();
    const exe = path.join(bin, 'mdopener-mcp');
    fs.copyFileSync(NATIVE_SOURCE, exe);
    fs.chmodSync(exe, 0o700);
    const selected = fs.realpathSync(exe);

    const r = await runEcosystem(['--write', '--json']);
    expect(r.code).toBe(0);
    const obj = JSON.parse(r.stdout) as {
      ok: boolean; added: string[];
      available: Array<Record<string, unknown>>;
      missing: Array<{ name: string }>;
      refused: unknown[];
    };
    expect(obj.ok).toBe(true);
    expect(obj.available).toEqual([{
      name: 'ashlr-md', label: 'Ashlr MD (mdopener-mcp)', probe: 'mdopener-mcp',
      command: selected, args: [], registered: false,
    }]);
    expect(obj.added).toEqual(['ashlr-md']);
    expect(obj.refused).toEqual([]);
    expect(obj.missing.map(m => m.name).sort()).toEqual(['locus', 'phantom-secrets']);

    const stored = JSON.parse(fs.readFileSync(settings, 'utf8')) as { mcpServers: Record<string, unknown> };
    expect(stored.mcpServers).toEqual({ 'ashlr-md': { command: selected, args: [] } });
  });

  it('reports ashlr-md as missing (not an error) when mdopener-mcp is absent', async () => {
    fixture();
    const r = await runEcosystem(['--json']);
    expect(r.code).toBe(0);
    const obj = JSON.parse(r.stdout) as { ok: boolean; missing: Array<Record<string, unknown>> };
    expect(obj.ok).toBe(true);
    expect(obj.missing).toContainEqual({ name: 'ashlr-md', label: 'Ashlr MD (mdopener-mcp)', probe: 'mdopener-mcp' });
  });

  it.skipIf(process.platform === 'win32')('refuses a script launcher named mdopener-mcp without running or registering it', async () => {
    const { root, bin, settings } = fixture();
    const marker = path.join(root, 'must-not-run');
    const launcher = path.join(bin, 'mdopener-mcp');
    fs.writeFileSync(launcher, `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(marker)}, 'ran');\n`);
    fs.chmodSync(launcher, 0o700);

    const r = await runEcosystem(['--write', '--json']);
    expect(r.code).toBe(0);
    const obj = JSON.parse(r.stdout) as { added: string[]; available: unknown[]; refused: Array<Record<string, unknown>> };
    expect(obj.available).toEqual([]);
    expect(obj.added).toEqual([]);
    expect(obj.refused).toEqual([{
      name: 'ashlr-md', label: 'Ashlr MD (mdopener-mcp)', probe: 'mdopener-mcp', reason: 'unsupported-launcher',
    }]);
    expect(fs.existsSync(settings)).toBe(false);
    expect(fs.existsSync(marker)).toBe(false);
  });

  it('mergeEcosystemServers writes {command, args: []} for ashlr-md and keeps other entries', () => {
    const { root } = fixture();
    const settings = path.join(root, 'nested', 'settings.json');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, JSON.stringify({ theme: 'dark', mcpServers: { other: { command: '/x/other', args: ['a'] } } }));

    const added = mergeEcosystemServers([{ name: 'ashlr-md', command: '/opt/md/mdopener-mcp', args: [] }], settings);
    expect(added).toEqual(['ashlr-md']);
    const stored = JSON.parse(fs.readFileSync(settings, 'utf8')) as Record<string, unknown>;
    expect(stored).toEqual({
      theme: 'dark',
      mcpServers: {
        other: { command: '/x/other', args: ['a'] },
        'ashlr-md': { command: '/opt/md/mdopener-mcp', args: [] },
      },
    });

    // Idempotent: a second merge leaves the existing entry alone.
    expect(mergeEcosystemServers([{ name: 'ashlr-md', command: '/elsewhere/mdopener-mcp', args: [] }], settings)).toEqual([]);
    expect((JSON.parse(fs.readFileSync(settings, 'utf8')) as { mcpServers: Record<string, { command: string }> })
      .mcpServers['ashlr-md']!.command).toBe('/opt/md/mdopener-mcp');
  });
});
