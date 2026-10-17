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

const root = fileURLToPath(new URL('..', import.meta.url));
const homes: string[] = [];
afterEach(() => { for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true }); });

function runStatus(args: string[], writeConfig: (home: string) => void = () => {}) {
  const home = mkdtempSync(join(tmpdir(), 'phantom-status-json-')); homes.push(home);
  writeConfig(home);
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, USERPROFILE: home, PATH: dirname(process.execPath) };
  delete env.ASHLR_HOME;
  delete env.NO_COLOR;
  delete env.FORCE_COLOR;
  const result = spawnSync(process.execPath, ['--import', 'tsx', 'src/cli/index.ts', 'status', ...args], {
    cwd: root, encoding: 'utf8', timeout: 20_000, env,
  });
  return { home, result };
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
    for (const key of ['tools', 'mcpServers', 'activity7d', 'memory', 'github', 'vercel', 'identity', 'resources']) {
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
