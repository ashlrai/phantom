/**
 * CLI contract: `phm status --json` prints exactly one JSON object on stdout,
 * with no ANSI color codes and no human prose. Runs the source CLI in a fresh
 * Node/tsx subprocess against a temp HOME so it never reads the real ~/.ashlr.
 * PATH is narrowed to the Node binary's directory so the best-effort
 * gh / vercel / phantom reads degrade to null instead of touching the network.
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { stripAnsi } from '../src/cli/ui.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });

function runStatus(args: string[], writeConfig: (home: string) => void = () => {},
  installed = false, failure?: string, observeImports = false) {
  const home = mkdtempSync(join(tmpdir(), 'phantom-status-json-')); homes.push(home);
  writeConfig(home);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, PATH: dirname(process.execPath) };
  delete env.ASHLR_HOME;
  delete env.NO_COLOR;
  delete env.FORCE_COLOR;
  const preloads: string[] = [];
  if (installed && (observeImports || failure !== undefined)) {
    const observer = join(home, 'observe.mjs');
    writeFileSync(observer, `import { registerHooks } from 'node:module';
registerHooks({ load(url, context, nextLoad) {
  if (/\\/cli\\/(index|picker|open|doctor-init)\\.js$/.test(url) || url.endsWith('/core/tidy.js') ||
      url.endsWith('/sandbox/claude-broker-tool-invocation.js')) throw Error('Unrelated CLI graph loaded');
  if (${JSON.stringify(failure)} !== undefined && url.endsWith('/core/index-engine.js')) {
    return { format: 'module', shortCircuit: true, source:
      'export function loadIndex() { throw Error(' + JSON.stringify(${JSON.stringify(failure)}) + '); }' +
      'export function buildIndex() {} export function writeIndex() {}' };
  }
  return nextLoad(url, context);
}});`);
    preloads.push('--import', observer);
  }
  const sourceEntry = ['--import', 'tsx', 'src/cli/index.ts'];
  const execute = (entry: string[], imports: string[] = []) => spawnSync(process.execPath,
    [...imports, ...entry, 'status', ...args], { cwd: root, encoding: 'utf8', timeout: 20_000, env });
  const result = execute(installed ? ['bin/ashlr'] : sourceEntry, preloads);
  return { home, result, source: () => execute(sourceEntry) };
}

describe('CLI: phm status --json', () => {
  it('prints one parseable JSON object with no ANSI codes', () => {
    const { result } = runStatus(['--json']);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('\u001b');
    const data = JSON.parse(result.stdout) as Record<string, unknown> & {
      summary: Record<string, number>; roots: Array<{ path: string; exists: boolean }>;
    };
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
    const { home, result } = runStatus(['--json'], (h) => mkdirSync(join(h, 'code'), { recursive: true }));
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
    });
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

describe('installed status fast path', () => {
  it('renders empty status without loading the dispatcher or unrelated commands', () => {
    const { result } = runStatus([], () => {}, true, undefined, true);
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
    expect(result.stdout).toContain('No git repos are being tracked yet.');
    expect(result.stdout).toContain('phm config set roots --json');
    expect(result.stderr).not.toContain('Unrelated CLI graph loaded');
  });
  it('retains index auto-build for invalid cached data', () => {
    const { home, result } = runStatus([], home => {
      mkdirSync(join(home, '.ashlr'), { recursive: true });
      writeFileSync(join(home, '.ashlr', 'index.json'), '{invalid');
    }, true);
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('No index found');
    expect(JSON.parse(readFileSync(join(home, '.ashlr', 'index.json'), 'utf8')).items).toEqual([]);
  });
  it('preserves the populated human attention board', () => {
    const { result } = runStatus([], writeBucketIndex, true);
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0); expect(result.stderr).toBe('');
    const output = stripAnsi(result.stdout);
    for (const text of ['4 repos tracked', 'Dirty (1)', 'Off-sync (1)', 'Stale', '1 clean', '1 dirty', '1 off-sync', '1 stale']) {
      expect(output).toContain(text);
    }
  });
  it('retains JSON fields and repo buckets from a cached index', () => {
    const { home, result } = runStatus(['--json'], writeBucketIndex, true);
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('\u001b'); expect(result.stderr).toBe('');
    const data = JSON.parse(result.stdout);
    expect(data.schemaVersion).toBe(1);
    expect(data.summary).toEqual({ tracked: 4, clean: 1, dirty: 1, offSync: 1, stale: 1, staleDays: 7 });
    expect(data.dirty[0]).toMatchObject({ name: 'dirty', path: join(home, 'dirty'), dirty: 2 });
    expect(data.offSync[0]).toMatchObject({ name: 'off-sync', ahead: 1 });
    expect(data.stale[0]).toMatchObject({ name: 'stale' });
    for (const key of ['roots', 'tools', 'mcpServers', 'activity7d', 'memory', 'github', 'vercel', 'identity', 'resources', 'custody', 'localInference', 'phantomPreflight']) {
      expect(data).toHaveProperty(key);
    }
  });
  it('matches the source JSON payload including optional sections', () => {
    // No observer here: exercise the real optional dependency graph on both paths.
    const { result, source } = runStatus(['--json'], writeBucketIndex, true);
    const direct = source();
    for (const child of [result, direct]) {
      expect(child.error).toBeUndefined(); expect(child.status).toBe(0); expect(child.stderr).toBe('');
    }
    expect(JSON.parse(result.stdout)).toEqual(JSON.parse(direct.stdout));
  });
  it.each(['fixture status failure', 'fixture not implemented'])(
    'keeps shared CLI error formatting for %s', failure => {
      const { result } = runStatus([], () => {}, true, failure);
      expect(result.error).toBeUndefined(); expect(result.status).toBe(1); expect(result.stdout).toBe('');
      const detail = failure.includes('not implemented')
        ? `Module not yet implemented: ${failure}\nThis command depends on a core module that hasn't been built yet.`
        : failure;
      expect(stripAnsi(result.stderr)).toBe(`error: ${detail}\n`);
    });
});
