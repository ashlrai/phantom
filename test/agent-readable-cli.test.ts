/**
 * Agent-readable CLI surfaces: `status --json`, `help <command>`, and the MCP
 * gateway's serverInfo version. Agents (including Phantom's own) drive `phm`
 * non-interactively, so these must be machine-readable and honest.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { cmdHelp } from '../src/cli/help.js';
import { gatewayVersion } from '../src/core/mcp-gateway.js';
import { parsePort, serverStartErrorMessage } from '../src/cli/args.js';
import { parseVerseArgs } from '../src/cli/verse.js';

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function cli(home: string, args: string[]): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, ['--import', 'tsx', resolve('src/cli/index.ts'), ...args], {
    cwd: resolve('.'), env: { ...process.env, HOME: home, NO_COLOR: '' }, encoding: 'utf8', timeout: 60_000,
  });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

describe('phm status --json', () => {
  it('prints one ANSI-free JSON document with the attention buckets', () => {
    const root = mkdtempSync(join(tmpdir(), 'phm-status-json-'));
    dirs.push(root);
    const home = join(root, 'home');
    const repo = join(root, 'code', 'repo1');
    mkdirSync(home, { recursive: true });
    mkdirSync(repo, { recursive: true });
    const git = (...a: string[]) => execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'core.hooksPath=/dev/null', ...a], { cwd: repo });
    git('init', '-q');
    git('commit', '-q', '--allow-empty', '-m', 'init');
    writeFileSync(join(repo, 'dirty.txt'), 'x');

    expect(cli(home, ['config', 'set', 'roots', '--json', JSON.stringify([join(root, 'code')])]).status).toBe(0);
    const r = cli(home, ['status', '--json']);
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).not.toContain('\u001b[');
    const doc = JSON.parse(r.stdout) as Record<string, any>;
    expect(doc.schemaVersion).toBe(1);
    expect(doc.reposTracked).toBe(1);
    expect(doc.counts).toEqual({ clean: 0, dirty: 1, offSync: 0, stale: 0 });
    expect(doc.dirty[0]).toMatchObject({ name: 'repo1', dirty: 1, ahead: 0, behind: 0 });
    expect(doc.hint).toBeUndefined();
  }, 120_000);

  it('gives a setup hint, still as JSON, when no repos are tracked', () => {
    const root = mkdtempSync(join(tmpdir(), 'phm-status-json-empty-'));
    dirs.push(root);
    const home = join(root, 'home');
    mkdirSync(join(root, 'empty'), { recursive: true });
    mkdirSync(home, { recursive: true });
    expect(cli(home, ['config', 'set', 'roots', '--json', JSON.stringify([join(root, 'empty')])]).status).toBe(0);
    const r = cli(home, ['status', '--json']);
    expect(r.status, r.stderr).toBe(0);
    const doc = JSON.parse(r.stdout) as Record<string, any>;
    expect(doc.reposTracked).toBe(0);
    expect(doc.hint).toContain('phm index --refresh');
  }, 120_000);
});

describe('phm help <command>', () => {
  let captured: string[] = [];
  const origLog = console.log;
  afterEach(() => { console.log = origLog; });
  const capture = (): void => { captured = []; console.log = (...a: unknown[]) => { captured.push(a.map(String).join(' ')); }; };

  it('shows the rows for a command name instead of "unknown topic"', async () => {
    capture();
    expect(await cmdHelp(['doctor'])).toBe(0);
    const text = captured.join('\n');
    expect(text).toContain('One-glance health check');
    expect(text).not.toContain('unknown topic');
    expect(text).toContain('phm help core');
  });

  it('topics still win over command names', async () => {
    capture();
    expect(await cmdHelp(['run'])).toBe(0);
    expect(captured.join('\n')).toContain('--estimate');
  });
});

describe('MCP gateway serverInfo', () => {
  it('reports the package version, not a placeholder', () => {
    const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { version: string };
    expect(gatewayVersion()).toBe(process.env.ASHLR_VERSION?.trim() || pkg.version);
    expect(gatewayVersion()).not.toBe('0.1.0');
  });
});

describe('--port and listen errors', () => {
  it('accepts 1..65535 and refuses the rest with a usage error', () => {
    expect(parsePort('8080')).toEqual({ n: 8080 });
    expect(parsePort('65535')).toEqual({ n: 65535 });
    for (const bad of ['0', '65536', '99999', '-1', '80x', '1.5', undefined]) {
      expect(parsePort(bad)).toHaveProperty('error');
    }
    expect(parseVerseArgs(['--port', '99999'])).toMatchObject({ code: 2 });
  });

  it('turns EADDRINUSE and EACCES into one actionable line', () => {
    const inUse = Object.assign(new Error('listen EADDRINUSE: address already in use'), { code: 'EADDRINUSE' });
    expect(serverStartErrorMessage(inUse, 7777)).toBe('port 7777 is already in use; pick another with --port N or stop the process using it.');
    const denied = Object.assign(new Error('listen EACCES'), { code: 'EACCES' });
    expect(serverStartErrorMessage(denied, 80)).toContain('above 1023');
    expect(serverStartErrorMessage(new Error('boom'), 1)).toBe('Failed to start server: Error: boom');
  });
});
