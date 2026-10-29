/**
 * `phm help <unknown-topic>` must fail (exit 2, like an unknown command) so agents
 * can tell a typo from success; known topics keep exit 0. The top-level summary
 * points first-run users at init, doctor and verse. `phm config <typo>` fails
 * the same way instead of printing the config summary.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { cmdHelp } from '../src/cli/help.js';

let out: string[] = [];
let err: string[] = [];
let origLog: typeof console.log;
let origErr: typeof console.error;

beforeEach(() => {
  out = [];
  err = [];
  origLog = console.log;
  origErr = console.error;
  console.log = (...a: unknown[]) => { out.push(a.map(String).join(' ')); };
  console.error = (...a: unknown[]) => { err.push(a.map(String).join(' ')); };
});

afterEach(() => {
  console.log = origLog;
  console.error = origErr;
});

describe('cmdHelp exit codes', () => {
  it('unknown topic -> exit 2, message + suggestion on stderr, nothing on stdout', async () => {
    expect(await cmdHelp(['autonomyy'])).toBe(2);
    const e = err.join('\n');
    expect(e).toContain('Unknown help topic "autonomyy".');
    expect(e).toContain('Did you mean');
    expect(e).toContain('phm help autonomy');
    expect(e).toContain('phm help');
    expect(out.join('\n')).toBe('');
  });

  it('prefix of a topic suggests that topic', async () => {
    expect(await cmdHelp(['obs'])).toBe(2);
    expect(err.join('\n')).toContain('phm help observability');
  });

  it('far-off topic has no suggestion but still lists topics', async () => {
    expect(await cmdHelp(['zzzzzzzz'])).toBe(2);
    const e = err.join('\n');
    expect(e).not.toContain('Did you mean');
    expect(e).toContain('core');
  });

  it('known topic -> exit 0 and stdout only', async () => {
    expect(await cmdHelp(['core'])).toBe(0);
    expect(out.join('\n')).toContain('doctor');
    expect(err).toEqual([]);
  });

  it('top-level help lists init, doctor and verse', async () => {
    expect(await cmdHelp([])).toBe(0);
    const o = out.join('\n');
    expect(o).toContain('phm init');
    expect(o).toContain('phm doctor');
    expect(o).toContain('phm verse');
  });
});

describe('CLI process exit codes', () => {
  const home = mkdtempSync(join(tmpdir(), 'phm-help-exit-'));
  afterAll(() => rmSync(home, { recursive: true, force: true }));

  function run(args: string[], executionHome = home) {
    return spawnSync(process.execPath, ['--import', 'tsx', resolve('src/cli/index.ts'), ...args], {
      cwd: resolve('.'),
      env: {
        ...process.env,
        HOME: executionHome,
        USERPROFILE: executionHome,
        ASHLR_HOME: join(executionHome, '.ashlr'),
        ASHLR_LOCUS_FIRM: '0',
        NO_COLOR: '1',
      },
      encoding: 'utf8',
      timeout: 30_000,
    });
  }

  it('phm help <unknown> exits 2 with stderr message', () => {
    const r = run(['help', 'nonsense']);
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toContain('Unknown help topic "nonsense".');
  });

  it('phm help <known> exits 0', () => {
    const r = run(['help', 'core']);
    expect(r.status, r.stderr).toBe(0);
  });

  it('phm <unknown command> exits nonzero', () => {
    const r = run(['frobnicate']);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Unknown command: frobnicate');
  });

  it('phm config <typo> exits 2 with usage instead of printing the summary', () => {
    const r = run(['config', 'gt', 'roots']);
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toContain('Unknown config subcommand: gt');
    expect(r.stderr).toContain('Usage: ashlr config');
    expect(r.stdout).not.toContain('staleDays');
  });

  it('phm config --help prints usage; list and the no-arg path keep working', () => {
    const help = run(['config', '--help']);
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain('Usage: ashlr config');
    const list = run(['config', 'list']);
    expect(list.status, list.stderr).toBe(0);
    expect(list.stdout).toContain('staleDays');
    const path = run(['config']);
    expect(path.status, path.stderr).toBe(0);
    expect(path.stdout.trim()).toMatch(/config\.json$/);
  });

  describe('enroll remove / kill JSON and flag parsing', () => {
    function fixture(enrolled = false) {
      const fixtureHome = realpathSync(mkdtempSync(join(home, 'enroll-')));
      const repo = join(fixtureHome, 'repo');
      const state = join(fixtureHome, '.ashlr');
      mkdirSync(repo);
      mkdirSync(state, { mode: 0o700 });
      const registry = join(state, 'enrollment.json');
      // Exercise the public CLI against persisted state without mocking its
      // authority layer; every case owns a separate home and actual directory.
      writeFileSync(registry, JSON.stringify({ repos: enrolled ? [repo] : [] }), { mode: 0o600 });
      return { fixtureHome, repo, state, registry };
    }

    function jsonResult(result: ReturnType<typeof run>, code = 0): Record<string, unknown> {
      expect(result.status, result.stderr).toBe(code);
      expect(result.stdout).not.toContain('\u001b');
      expect(result.stderr).toBe('');
      return JSON.parse(result.stdout) as Record<string, unknown>;
    }

    it.each(['before', 'after'])('removes the actual repo with --json %s the positional', (position) => {
      const f = fixture(true);
      const args = position === 'before' ? ['--json', f.repo] : [f.repo, '--json'];
      expect(jsonResult(run(['enroll', 'remove', ...args], f.fixtureHome))).toEqual({
        ok: true, repo: f.repo, enrolled: false, removed: true,
      });
      expect(JSON.parse(readFileSync(f.registry, 'utf8'))).toEqual({ repos: [] });
      expect(jsonResult(run(['enroll', 'remove', ...args], f.fixtureHome))).toEqual({
        ok: true, repo: f.repo, enrolled: false, removed: false,
      });
    });

    it.each(['before', 'after'])('toggles the real kill sentinel with --json %s the positional', (position) => {
      const f = fixture();
      for (const value of ['on', 'off']) {
        const args = position === 'before' ? ['--json', value] : [value, '--json'];
        expect(jsonResult(run(['enroll', 'kill', ...args], f.fixtureHome))).toEqual({
          ok: true, killSwitchOn: value === 'on',
        });
        expect(existsSync(join(f.state, 'KILL'))).toBe(value === 'on');
      }
    });

    it.each([
      ['remove', '--json'],
      ['kill', '--json'],
      ['kill', '--json', 'maybe'],
    ])('returns one JSON usage error for %j', (...args) => {
      const f = fixture();
      expect(jsonResult(run(['enroll', ...args], f.fixtureHome), 2)).toMatchObject({
        ok: false, error: expect.stringContaining(`Usage: ashlr enroll ${args[0]}`),
      });
      expect(existsSync(join(f.state, 'KILL'))).toBe(false);
    });

    it.each(['remove', 'kill'])('rejects unknown %s flags before changing persisted state', (sub) => {
      const f = fixture(true);
      const before = readFileSync(f.registry, 'utf8');
      const target = sub === 'remove' ? f.repo : 'on';
      expect(jsonResult(run(['enroll', sub, target, '--json', '--typo'], f.fixtureHome), 2)).toMatchObject({
        ok: false, error: expect.stringContaining('unknown option: --typo'),
      });
      expect(readFileSync(f.registry, 'utf8')).toBe(before);
      expect(existsSync(join(f.state, 'KILL'))).toBe(false);
    });

    it('returns a JSON failure when the registry cannot be parsed, preserving the bytes', () => {
      const f = fixture();
      writeFileSync(f.registry, '{broken');
      expect(jsonResult(run(['enroll', 'remove', '--json', f.repo], f.fixtureHome), 1)).toMatchObject({
        ok: false, repo: f.repo, error: expect.stringContaining('Unenrollment refused'),
      });
      expect(readFileSync(f.registry, 'utf8')).toBe('{broken');
    });

    it('returns a JSON failure when kill resume cannot safely remove the sentinel', () => {
      const f = fixture();
      const sentinel = join(f.state, 'KILL');
      mkdirSync(sentinel);
      expect(jsonResult(run(['enroll', 'kill', '--json', 'off'], f.fixtureHome), 1)).toMatchObject({
        ok: false, error: expect.stringContaining('Kill switch resume refused'),
      });
      expect(existsSync(sentinel)).toBe(true);
    });

    it('keeps human output and reports an already absent repo truthfully', () => {
      const f = fixture(true);
      const removed = run(['enroll', 'remove', f.repo], f.fixtureHome);
      expect(removed.status, removed.stderr).toBe(0);
      expect(removed.stdout).toContain(`Removed: ${f.repo}`);
      const absent = run(['enroll', 'remove', f.repo], f.fixtureHome);
      expect(absent.status, absent.stderr).toBe(0);
      expect(absent.stdout).toContain(`Not enrolled, nothing removed: ${f.repo}`);
      const paused = run(['enroll', 'kill', 'on'], f.fixtureHome);
      expect(paused.status, paused.stderr).toBe(0);
      expect(paused.stdout).toContain('Kill switch ON');
      const resumed = run(['enroll', 'kill', 'off'], f.fixtureHome);
      expect(resumed.status, resumed.stderr).toBe(0);
      expect(resumed.stdout).toContain('Kill switch OFF');
    });
  });
});

it('the sweep fixture suite runs through the CLI', () => {
  const result = spawnSync(process.execPath, ['--test', resolve('test/deletion-sweep.test.mjs')], {
    cwd: resolve('.'), encoding: 'utf8', timeout: 60_000,
  });
  expect(result.status, result.stdout + result.stderr).toBe(0);
});
