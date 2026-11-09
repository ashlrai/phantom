/**
 * CLI contract: `phm status --json` prints exactly one JSON object on stdout,
 * with no ANSI color codes and no human prose. Runs the source CLI in a fresh
 * Node/tsx subprocess against a temp HOME so it never reads the real ~/.ashlr.
 * PATH is narrowed to the Node binary's directory so the best-effort
 * gh / vercel / phantom reads degrade to null instead of touching the network.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { stripAnsi } from '../src/cli/ui.js';
import { outputContractShape } from './output-contract-shape.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });

function runStatus(args: string[], writeConfig: (home: string) => void = () => {}, inventory = false,
  installed = false, failure?: string, observeImports = false) {
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
  const preloads: string[] = [];
  if (installed && (observeImports || failure !== undefined)) {
    const observer = join(home, 'observe.mjs');
    writeFileSync(observer, `import { registerHooks } from 'node:module';
registerHooks({ load(url, context, nextLoad) {
  if (/\\/cli\\/(index|picker|open|doctor-init)\\.js$/.test(url) || url.endsWith('/core/tidy.js') ||
      url.endsWith('/sandbox/claude-broker-tool-invocation.js')) throw Error('Unrelated CLI graph loaded');
  if (${JSON.stringify(failure)} !== undefined && url.endsWith('/core/index-store.js')) {
    return { format: 'module', shortCircuit: true, source:
      'export function loadIndex() { throw Error(' + JSON.stringify(${JSON.stringify(failure)}) + '); }' +
      'export function writeIndex() {}' };
  }
  return nextLoad(url, context);
}});`);
    preloads.push('--import', observer);
  }
  const sourceEntry = ['--import', 'tsx', 'src/cli/index.ts'];
  const execute = (entry: string[], imports: string[] = []) => spawnSync(process.execPath,
    [...imports, ...entry, 'status', ...args], { cwd: root, encoding: 'utf8', timeout: 20_000, env });
  const argv = inventory
    ? ['--import', 'tsx', '--input-type=module', '-e', inventoryScript]
    : ['--import', 'tsx', 'src/cli/index.ts', 'status', ...args];
  const result = installed ? execute(['bin/ashlr'], preloads) : spawnSync(process.execPath, argv, {
    cwd: root, encoding: 'utf8', timeout: 20_000, env,
  });
  return { home, result, source: () => execute(sourceEntry) };
}

describe('CLI: phm status --json', () => {
  it('prints the live v1 JSON contract and keeps unmeasured pool usage unknown', () => {
    const { result } = runStatus(['--json']);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('\u001b');
    const data = JSON.parse(result.stdout);
    expect(result.stdout).toBe(JSON.stringify(data, null, 2) + '\n');
    expect(Object.keys(data).sort()).toEqual(['v', 'generatedAt', 'state', 'reason', 'summary', 'lanes', 'repos', 'running', 'merged', 'blocked', 'spent'].sort());
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

function writeBucketIndex(home: string): void {
  mkdirSync(join(home, '.ashlr'), { recursive: true });
  writeFileSync(join(home, '.ashlr', 'config.json'), JSON.stringify({ version: 1, roots: [], staleDays: 7 }));
  const items = ['dirty', 'off-sync', 'stale', 'clean'].map((name, i) => ({
    id: name, name, path: join(home, name), kind: 'repo',
    lastModified: new Date(Date.now() - (i === 2 ? 30 : 1) * 86_400_000).toISOString(),
    git: { branch: 'main', dirty: i === 0 ? 2 : 0, ahead: i === 1 ? 1 : 0, behind: 0, lastCommit: null },
  }));
  writeFileSync(join(home, '.ashlr', 'index.json'), JSON.stringify({ version: 1, items }));
}

// bin/ashlr's status fast path imports dist/cli/status.js — skipped when the
// build output is absent (environment issue, not a regression).
const distStatusBuilt = existsSync(join(root, 'dist', 'cli', 'status.js'));

describe('installed status fast path', () => {
  it('renders empty status without loading the dispatcher or unrelated commands', () => {
    if (!distStatusBuilt) return;
    const { result } = runStatus([], () => {}, false, true, undefined, true);
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
    expect(result.stdout).toContain('No git repos are being tracked yet.');
    expect(result.stdout).toContain('phm config set roots --json');
    expect(result.stderr).not.toContain('Unrelated CLI graph loaded');
  });
  it('retains index auto-build for invalid cached data', () => {
    if (!distStatusBuilt) return;
    const { home, result } = runStatus([], home => {
      mkdirSync(join(home, '.ashlr'), { recursive: true });
      writeFileSync(join(home, '.ashlr', 'index.json'), '{invalid');
    }, false, true);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('No index found');
    expect(JSON.parse(readFileSync(join(home, '.ashlr', 'index.json'), 'utf8')).items).toEqual([]);
  });
  it('preserves the populated human attention board', () => {
    if (!distStatusBuilt) return;
    const { result } = runStatus([], writeBucketIndex, false, true);
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
    // The Phantom Secrets PATH warning is a deliberate one-off diagnostic when
    // credential CLIs run without `phantom exec`; it is not a fast-path error.
    expect(result.stderr).not.toContain('error');
    expect(result.stderr).not.toContain('Unrelated CLI graph loaded');
    const output = stripAnsi(result.stdout);
    for (const text of ['4 repos tracked', 'Dirty (1)', 'Off-sync (1)', 'Stale', '1 clean', '1 dirty', '1 off-sync', '1 stale']) {
      expect(output).toContain(text);
    }
  });
  it('matches the source live-status JSON payload', () => {
    if (!distStatusBuilt) return;
    const { result, source } = runStatus(['--json'], writeBucketIndex, false, true);
    const direct = source();
    for (const child of [result, direct]) {
      expect(child.error).toBeUndefined(); expect(child.status).toBe(0); expect(child.stderr).toBe('');
      expect(child.stdout).not.toContain('\u001b');
    }
    const normalize = (s: string) => { const d = JSON.parse(s) as Record<string, unknown>; d.generatedAt = '<ts>'; return d; };
    expect(normalize(result.stdout)).toEqual(normalize(direct.stdout));
  });
  it.each(['fixture status failure', 'fixture not implemented'])(
    'keeps shared CLI error formatting for %s', failure => {
      if (!distStatusBuilt) return;
      const { result } = runStatus([], () => {}, false, true, failure);
      expect(result.error).toBeUndefined(); expect(result.status).toBe(1); expect(result.stdout).toBe('');
      const detail = failure.includes('not implemented')
        ? `Module not yet implemented: ${failure}\nThis command depends on a core module that hasn't been built yet.`
        : failure;
      expect(stripAnsi(result.stderr)).toBe(`error: ${detail}\n`);
    });
});

it('reads a cached status without loading scanners, tidy or picker modules', () => {
  const home2 = mkdtempSync(join(tmpdir(), 'phantom-status-cached-')); homes.push(home2);
  mkdirSync(join(home2, '.ashlr'));
  writeFileSync(join(home2, '.ashlr', 'config.json'), JSON.stringify({ version: 1, roots: [] }));
  writeFileSync(join(home2, '.ashlr', 'index.json'), JSON.stringify({ version: 1, items: [], generatedAt: new Date().toISOString() }));
  const observer = join(home2, 'observe.mjs');
  writeFileSync(observer, `import { registerHooks } from 'node:module';
registerHooks({ load(url, context, nextLoad) {
  if (/\\/(?:index-engine|classify|tidy|picker|open)\\.ts$/.test(url)) throw Error('Cached status loaded: ' + url);
  return nextLoad(url, context);
}});`);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home2, USERPROFILE: home2, PATH: dirname(process.execPath) };
  delete env.ASHLR_HOME;
  delete env.NO_COLOR;
  delete env.FORCE_COLOR;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--import', observer, 'src/cli/index.ts', 'status'], {
    cwd: root, encoding: 'utf8', timeout: 20_000, env,
  });
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(0);
  expect(result.stdout).toContain('No git repos are being tracked yet.');
});
