/**
 * `phm help <unknown-topic>` must fail (exit 2, like an unknown command) so agents
 * can tell a typo from success; known topics keep exit 0. The top-level summary
 * points first-run users at init, doctor and verse.
 */

import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
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

  function run(args: string[]) {
    return spawnSync(process.execPath, ['--import', 'tsx', resolve('src/cli/index.ts'), ...args], {
      cwd: resolve('.'),
      env: { ...process.env, HOME: home, NO_COLOR: '1' },
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
});
