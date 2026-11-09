/**
 * CLI contract: `phm status --json` prints exactly one JSON object on stdout,
 * with no ANSI color codes and no human prose. Runs the source CLI in a fresh
 * Node/tsx subprocess against a temp HOME so it never reads the real ~/.ashlr.
 * PATH is narrowed to the Node binary's directory so the best-effort
 * gh / vercel / phantom reads degrade to null instead of touching the network.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { outputContractShape } from './output-contract-shape.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });

function runStatus(args: string[], writeConfig: (home: string) => void = () => {}, inventory = false) {
  const home = mkdtempSync(join(tmpdir(), 'phantom-status-json-')); homes.push(home);
  writeConfig(home);
  const env: NodeJS.ProcessEnv = { HOME: home, USERPROFILE: home, PATH: dirname(process.execPath), TMPDIR: process.env.TMPDIR };
  delete env.ASHLR_HOME;
  delete env.NO_COLOR;
  delete env.FORCE_COLOR;
  delete env.CLAUDE_CODE_PLUGIN_CACHE_DIR;
  // The CLI now exposes the live fleet contract. Keep every legacy board
  // assertion against its still-owned serializer, with real config/index data.
  const inventoryScript = `
    import { loadConfig } from './src/core/config.ts';
    import { buildIndex } from './src/core/index-engine.ts';
    import { printStatusJson } from './src/cli/status.ts';
    const load = (path, key) => async () => (await import(path))[key];
    const cfg = loadConfig();
    await printStatusJson(cfg, buildIndex(cfg), {
      getToolsRegistry: load('./src/core/tools-registry.ts', 'getToolsRegistry'),
      discoverMcpServers: load('./src/core/mcp-registry.ts', 'discoverMcpServers'),
      buildRollup: load('./src/core/observability/rollup.ts', 'buildRollup'),
      githubStatus: load('./src/core/integrations/github.ts', 'githubStatus'),
      vercelStatus: load('./src/core/integrations/vercel.ts', 'vercelStatus'),
      getIdentity: load('./src/core/integrations/identity.ts', 'getIdentity'),
    });
  `;
  const argv = inventory
    ? ['--import', 'tsx', '--input-type=module', '-e', inventoryScript]
    : ['--import', 'tsx', 'src/cli/index.ts', 'status', ...args];
  const result = spawnSync(process.execPath, argv, {
    cwd: root, encoding: 'utf8', timeout: 20_000, env,
  });
  return { home, result };
}

describe('CLI: phm status --json', () => {
  it('prints the live v1 JSON contract and keeps unmeasured pool usage unknown', () => {
    const { result } = runStatus(['--json']);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('\u001b');
    const data = JSON.parse(result.stdout);
    expect(result.stdout).toBe(JSON.stringify(data, null, 2) + '\n');
    expect(Object.keys(data).sort()).toEqual(['v', 'generatedAt', 'state', 'reason', 'running', 'merged', 'blocked', 'spent', 'lanes', 'repos', 'summary'].sort());
    expect(data.v).toBe(1);
    expect(Number.isFinite(Date.parse(data.generatedAt))).toBe(true);
    expect(data.state).toBe('dark');
    expect(data.reason).toBe('No standing grant is in force.');
    expect(data.running).toEqual([]);
    expect(data.merged).toEqual([]);
    expect(data.blocked).toEqual([]);
    expect(data.spent.length).toBeGreaterThan(0);
    for (const pool of data.spent) {
      expect(pool.pool).toEqual(expect.any(String));
      expect(pool.pctUsed).toBeNull();
      expect(pool.resetAt).toBeNull();
    }
  });

  it('prints one parseable JSON object with no ANSI codes', () => {
    const { result } = runStatus(['--json'], undefined, true);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('\u001b');
    const data = JSON.parse(result.stdout) as Record<string, unknown> & {
      summary: Record<string, number>; roots: Array<{ path: string; exists: boolean }>;
      tools: { installed: number; total: number; installedIds: unknown } | null;
    };
    expect(result.stdout).toBe(JSON.stringify(data) + '\n');
    // installedIds is the roster of PATH/app-bundle probe hits on this machine;
    // its length varies (an Ashlr MD.app install, a binary beside node), so the
    // contract is asserted strictly here, then pinned to a sentinel for the
    // environment-independent shape snapshot.
    expect(data.tools).not.toBeNull();
    expect(Array.isArray(data.tools!.installedIds)).toBe(true);
    const installedIds = data.tools!.installedIds as unknown[];
    expect(installedIds.every(id => typeof id === 'string' && id.length > 0)).toBe(true);
    expect(installedIds.length).toBe(data.tools!.installed);
    data.tools!.installedIds = ['<tool>'];
    expect(outputContractShape(data)).toMatchSnapshot();
    expect(data.schemaVersion).toBe(1);
    expect(data.summary).toEqual({ tracked: 0, clean: 0, dirty: 0, offSync: 0, stale: 0, staleDays: 30 });
    expect(data.dirty).toEqual([]);
    // A fresh HOME with no code folders gets no roots (not two missing ones).
    expect(data.roots).toEqual([]);
    for (const key of ['tools', 'mcpServers', 'activity7d', 'memory', 'github', 'vercel', 'identity', 'resources', 'custody', 'localInference', 'phantomPreflight']) {
      expect(data).toHaveProperty(key);
    }
  });

  it('detects an existing code folder as a root when no config exists', () => {
    const { home, result } = runStatus(['--json'], (h) => mkdirSync(join(h, 'code'), { recursive: true }), true);
    expect(result.status).toBe(0);
    const data = JSON.parse(result.stdout) as { roots: Array<{ path: string; exists: boolean }> };
    expect(data.roots).toEqual([{ path: join(home, 'code'), exists: true }]);
  });

  it('reports configured roots and whether each exists', () => {
    const { result } = runStatus(['--json'], (home) => {
      const code = join(home, 'code');
      mkdirSync(code, { recursive: true });
      mkdirSync(join(home, '.ashlr'), { recursive: true });
      writeFileSync(join(home, '.ashlr', 'config.json'), JSON.stringify({
        version: 1, roots: [code, join(home, 'missing')], staleDays: 7,
      }));
    }, true);
    expect(result.status).toBe(0);
    const data = JSON.parse(result.stdout) as { summary: { staleDays: number }; roots: Array<{ exists: boolean }> };
    expect(data.summary.staleDays).toBe(7);
    expect(data.roots.map(r => r.exists)).toEqual([true, false]);
  });

  it('keeps the human board without --json', () => {
    const { result } = runStatus([]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('ashlr status');
    expect(result.stdout).toContain('No git repos are being tracked yet.');
    expect(result.stdout).toContain('phm config set roots --json');
    // Only this platform's quoting is shown.
    if (process.platform !== 'win32') expect(result.stdout).not.toContain('PowerShell');
    expect(() => JSON.parse(result.stdout)).toThrow();
  });
});
