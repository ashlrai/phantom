/**
 * CLI contract: `phm mcp ecosystem [--write] --json` prints exactly one JSON
 * document on stdout — the published companion smoke parses that stream with
 * JSON.parse, so a banner, notice or second line breaks the seam (Companion
 * Smoke run 41089879277 failed on exactly this against published v3.29.15,
 * which predates --json here). Fresh Node/tsx subprocesses run the source CLI
 * against a temp HOME; PATH is narrowed to a gateway-bin fixture of inert
 * native-header binaries that detection reads but never executes.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('..', import.meta.url));
const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });

/** ECOSYSTEM_SERVERS order (src/cli/mcp.ts): probe binary -> registered name + launch args. */
const SERVERS = [
  { name: 'phantom-secrets', probe: 'phantom', args: ['mcp', 'serve'] },
  { name: 'locus', probe: 'locus-mcp', args: [] },
  { name: 'ashlr-md', probe: 'mdopener-mcp', args: [] },
] as const;

interface EcosystemReport {
  ok: boolean;
  settingsPath: string;
  write: boolean;
  available: Array<{ name: string; probe: string; command: string; args: string[]; registered: boolean }>;
  missing: Array<{ name: string; probe: string }>;
  refused: Array<{ name: string; probe: string; reason: string }>;
  added: string[];
}

/** Mach-O 64-bit little-endian magic: detection classifies the file native from its header; it is never run. */
const NATIVE_HEADER = Buffer.from('cffaedfe00000000', 'hex');

function newHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'phm-mcp-ecosystem-json-'));
  homes.push(home);
  return home;
}

/** Inert fixture binaries in `<home>/gateway-bin`, like the smoke's PATH shim. */
function fixtureBins(home: string): { binDir: string; resolved: Record<string, string> } {
  const binDir = join(home, 'gateway-bin');
  mkdirSync(binDir, { recursive: true });
  const resolved: Record<string, string> = {};
  for (const { probe } of SERVERS) {
    const file = join(binDir, process.platform === 'win32' ? `${probe}.exe` : probe);
    writeFileSync(file, NATIVE_HEADER);
    chmodSync(file, 0o700);
    resolved[probe] = realpathSync(file);
  }
  return { binDir, resolved };
}

function runEcosystem(args: string[], opts: { home?: string; withBins?: boolean } = {}) {
  const home = opts.home ?? newHome();
  const { binDir, resolved } = opts.withBins === false
    ? { binDir: join(home, 'gateway-bin'), resolved: {} }
    : fixtureBins(home);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    PATH: binDir,
    LOCUS_HOME: join(home, '.locus'),
    NO_COLOR: '1',
    CI: '1',
    PHANTOM_VAULT_PASSPHRASE: 'phm-mcp-ecosystem-json-test',
  };
  delete env.ASHLR_HOME;
  delete env.FORCE_COLOR;
  delete env.CLAUDE_CODE_PLUGIN_CACHE_DIR;
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'mcp', 'ecosystem', ...args], {
    cwd: root, encoding: 'utf8', timeout: 30_000, env,
  });
  return { home, bins: resolved, result };
}

/** The smoke's contract: stdout is one parseable JSON document and nothing else. */
function oneJsonDocument(stdout: string): EcosystemReport {
  expect(stdout).not.toContain('\u001b');
  const data = JSON.parse(stdout) as EcosystemReport;
  expect(stdout).toBe(JSON.stringify(data) + '\n');
  return data;
}

const settingsFile = (home: string) => join(home, '.ashlr', 'settings.json');

describe('CLI: phm mcp ecosystem --json', () => {
  it('--write --json prints one JSON document and registers every detected server', () => {
    const { home, bins, result } = runEcosystem(['--write', '--json']);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const data = oneJsonDocument(result.stdout);
    expect(data.ok).toBe(true);
    expect(data.write).toBe(true);
    expect(data.settingsPath).toBe(settingsFile(home));
    expect(data.added).toEqual(['phantom-secrets', 'locus', 'ashlr-md']);
    expect(data.missing).toEqual([]);
    expect(data.refused).toEqual([]);
    expect(data.available.map(s => s.name)).toEqual(['phantom-secrets', 'locus', 'ashlr-md']);
    for (const srv of data.available) {
      const spec = SERVERS.find(s => s.name === srv.name)!;
      expect(srv.probe).toBe(spec.probe);
      expect(srv.command).toBe(bins[srv.probe]);
      expect(srv.args).toEqual(spec.args);
      expect(srv.registered).toBe(false);
    }
    // Settings merged: launch commands + locus env only — no env values leak in.
    const settings = JSON.parse(readFileSync(settingsFile(home), 'utf8')) as {
      mcpServers: Record<string, { command: string; args?: string[]; env?: Record<string, string> }>;
    };
    expect(Object.keys(settings.mcpServers).sort()).toEqual(['ashlr-md', 'locus', 'phantom-secrets']);
    expect(settings.mcpServers['phantom-secrets']).toEqual({ command: bins['phantom'], args: ['mcp', 'serve'] });
    expect(settings.mcpServers['ashlr-md']).toEqual({ command: bins['mdopener-mcp'], args: [] });
    expect(settings.mcpServers['locus']).toEqual({
      command: bins['locus-mcp'],
      args: [],
      env: { LOCUS_HOME: join(home, '.locus'), LOCUS_CLIENT: 'ashlr-hub', LOCUS_NOTIFY: '0' },
    });
  });

  it('is idempotent: a second --write --json still prints one JSON document with added: []', () => {
    const home = newHome();
    const first = runEcosystem(['--write', '--json'], { home });
    expect(first.result.status).toBe(0);
    const second = runEcosystem(['--write', '--json'], { home });
    expect(second.result.status).toBe(0);
    const data = oneJsonDocument(second.result.stdout);
    expect(data.ok).toBe(true);
    expect(data.added).toEqual([]);
    expect(data.available.map(s => s.registered)).toEqual([true, true, true]);
  });

  it('prints one JSON document (exit 0, added: []) when nothing is detected, and writes no file', () => {
    const { home, result } = runEcosystem(['--write', '--json'], { withBins: false });
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    const data = oneJsonDocument(result.stdout);
    expect(data.ok).toBe(true);
    expect(data.write).toBe(true);
    expect(data.added).toEqual([]);
    expect(data.available).toEqual([]);
    expect(data.refused).toEqual([]);
    expect(data.missing.map(s => s.probe)).toEqual(['phantom', 'locus-mcp', 'mdopener-mcp']);
    expect(existsSync(settingsFile(home))).toBe(false);
  });

  it('--json without --write reports state and never touches settings', () => {
    const { home, result } = runEcosystem(['--json']);
    expect(result.status).toBe(0);
    const data = oneJsonDocument(result.stdout);
    expect(data.ok).toBe(true);
    expect(data.write).toBe(false);
    expect(data.added).toEqual([]);
    expect(data.available.map(s => s.registered)).toEqual([false, false, false]);
    expect(existsSync(settingsFile(home))).toBe(false);
  });
});
