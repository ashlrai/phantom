/**
 * Verbs that used to ignore an unknown or mistyped option and then do their
 * normal (sometimes destructive or paid) work now refuse it first: exit 2, the
 * option named on stderr (or one JSON refusal on stdout under --json), and no
 * state written. `sandbox gc --dry-run` reclaimed for real, `comms cycle
 * --dry-run` sent, `enroll add <repo> --locus-frm` enrolled without firm mode,
 * and `devin message` / `leader say` glued stray flags into the sent text.
 *
 * Every CLI case runs in its own fresh HOME with failing shims for the external
 * tools first on PATH, so a regression cannot reach a real account.
 */

import { describe, it, expect, afterAll } from 'vitest';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';

import { looksLikeOption, rejectUnknownOptions } from '../src/cli/args.js';

describe('rejectUnknownOptions', () => {
  const allowed = { flags: ['--json', '--yes'], values: ['--team', '-o'] };

  it('accepts known flags, value flags with their values, and positionals', () => {
    expect(rejectUnknownOptions(['repo', '--json', '--team', 't1', '-o', 'a', '--yes'], allowed)).toBeNull();
    expect(rejectUnknownOptions([], {})).toBeNull();
  });

  it('reports the first unknown option', () => {
    expect(rejectUnknownOptions(['repo', '--jsn', '--bad'], allowed)).toEqual({
      token: '--jsn', kind: 'unknown', message: 'unknown option: --jsn',
    });
    expect(rejectUnknownOptions(['-x'], {})?.token).toBe('-x');
  });

  it('reports a value flag at the end as missing its value', () => {
    expect(rejectUnknownOptions(['--json', '--team'], allowed)).toEqual({
      token: '--team', kind: 'missing-value', message: 'option --team requires a value',
    });
  });

  it('lets a value flag consume a dash-led value, as the callers read args[i + 1]', () => {
    expect(rejectUnknownOptions(['--team', '--odd-name'], allowed)).toBeNull();
  });

  it('stops checking at a -- separator', () => {
    expect(rejectUnknownOptions(['hello', '--', '--bogus', '-x'], {})).toBeNull();
    expect(rejectUnknownOptions(['--bogus', '--', 'x'], {})?.token).toBe('--bogus');
  });

  it('treats a bare dash and whitespace-bearing prose as positionals', () => {
    expect(looksLikeOption('-')).toBe(false);
    expect(looksLikeOption('- fix the header')).toBe(false);
    expect(looksLikeOption('-x')).toBe(true);
    expect(rejectUnknownOptions(['-', '- a note'], {})).toBeNull();
  });
});

describe('CLI verbs refuse unknown options before side effects', () => {
  const root = mkdtempSync(join(tmpdir(), 'phm-unknown-option-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  for (const tool of ['claude', 'gh', 'codex', 'curl', 'devin', 'vercel']) {
    const shim = join(bin, tool);
    writeFileSync(shim, '#!/bin/sh\necho "test shim: $0 must not run" >&2\nexit 97\n');
    chmodSync(shim, 0o755);
  }
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  let n = 0;
  function run(args: string[]) {
    const home = join(root, `home-${n++}`);
    mkdirSync(home);
    const r = spawnSync(process.execPath, ['--import', 'tsx', resolve('src/cli/index.ts'), ...args], {
      cwd: resolve('.'),
      env: { ...process.env, HOME: home, NO_COLOR: '1', PATH: `${bin}${delimiter}${process.env['PATH'] ?? ''}` },
      encoding: 'utf8',
      timeout: 30_000,
    });
    return { ...r, homeEntries: readdirSync(home) };
  }

  it('control: an already-strict command refuses and leaves HOME empty', () => {
    const r = run(['run', '--definitely-not-a-flag']);
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toContain('--definitely-not-a-flag');
    expect(r.homeEntries).toEqual([]);
  });

  const refused: Array<{ args: string[]; flag: string }> = [
    { args: ['sandbox', 'gc', '--definitely-not-a-flag'], flag: '--definitely-not-a-flag' },
    { args: ['sandbox', 'gc', '--dry-run'], flag: '--dry-run' },
    { args: ['sandbox', 'cleanup', 'sb-1', '--dry-run'], flag: '--dry-run' },
    { args: ['enroll', 'add', 'some-repo', '--locus-frm'], flag: '--locus-frm' },
    { args: ['enroll', 'remove', '--definitely-not-a-flag'], flag: '--definitely-not-a-flag' },
    { args: ['comms', 'cycle', '--dry-run'], flag: '--dry-run' },
    { args: ['comms', 'send-test', '--definitely-not-a-flag'], flag: '--definitely-not-a-flag' },
    { args: ['comms', 'ask', 'question', '-o', 'a', '--definitely-not-a-flag'], flag: '--definitely-not-a-flag' },
    { args: ['comms', 'digest', '--forc'], flag: '--forc' },
    { args: ['comms', 'ask-vision', '--definitely-not-a-flag'], flag: '--definitely-not-a-flag' },
    { args: ['comms', 'ask-merges', '--definitely-not-a-flag'], flag: '--definitely-not-a-flag' },
    { args: ['release-articles', 'sync', '--dryrun'], flag: '--dryrun' },
    { args: ['devin', 'message', 'task-1', 'hello', '--bogus'], flag: '--bogus' },
    { args: ['leader', 'say', 'hello', '--bogus'], flag: '--bogus' },
    { args: ['leader', 'answer', 'q-1', 'yes', '--bogus'], flag: '--bogus' },
    { args: ['leader', 'directives', 'add', 'focus', '--bogus'], flag: '--bogus' },
    { args: ['improve', 'propose', '--definitely-not-a-flag'], flag: '--definitely-not-a-flag' },
    { args: ['manager', '--definitely-not-a-flag'], flag: '--definitely-not-a-flag' },
    ...['status', 'watch', 'direction', 'init', 'doctor', 'scorecard', 'oversight', 'judge-traces', 'judge-health'].map((verb) => ({
      args: ['fleet', verb, '--definitely-not-a-flag'], flag: '--definitely-not-a-flag',
    })),
    { args: ['fleet', 'scorecard', '--window'], flag: '--window' },
  ];

  for (const { args, flag } of refused) {
    it(`phm ${args.join(' ')} -> exit 2, names ${flag}, writes nothing`, () => {
      const r = run(args);
      expect(r.status, r.stderr).toBe(2);
      expect(r.stderr).toContain(flag);
      expect(r.stderr).not.toContain('test shim');
      expect(r.homeEntries).toEqual([]);
    });
  }

  it('enroll add --json refuses with one JSON object on stdout', () => {
    const r = run(['enroll', 'add', 'some-repo', '--locus-frm', '--json']);
    expect(r.status, r.stderr).toBe(2);
    expect(JSON.parse(r.stdout)).toEqual({ ok: false, error: 'unknown option: --locus-frm', repo: 'some-repo' });
    expect(r.homeEntries).toEqual([]);
  });

  it('release-articles sync --json refuses with one JSON object on stdout', () => {
    const r = run(['release-articles', 'sync', '--dryrun', '--json']);
    expect(r.status, r.stderr).toBe(2);
    expect(JSON.parse(r.stdout)).toEqual({ ok: false, reason: 'unknown option: --dryrun' });
    expect(r.homeEntries).toEqual([]);
  });

  // Valid forms still parse: help paths keep exit 0, and accepted flags pass the check.
  const valid: Array<{ args: string[]; status: number; out: RegExp }> = [
    { args: ['sandbox', 'gc', '--help'], status: 0, out: /ashlr sandbox gc/ },
    { args: ['enroll', 'add', '--help'], status: 0, out: /--locus-firm/ },
    { args: ['comms', 'digest', '--help'], status: 0, out: /digest \[--force\]/ },
    { args: ['release-articles', 'status', '--json'], status: 0, out: /"enabled":false/ },
    { args: ['leader', 'say', '--help'], status: 0, out: /phm leader say/ },
    { args: ['manager', '--help'], status: 0, out: /--apply-rejects/ },
    { args: ['fleet', 'scorecard', '--window', '7d', '--by-engine', '--json'], status: 0, out: /"window": "7d"/ },
  ];

  for (const { args, status, out } of valid) {
    it(`phm ${args.join(' ')} still parses (exit ${status})`, () => {
      const r = run(args);
      expect(r.status, r.stderr).toBe(status);
      expect(r.stdout).toMatch(out);
      expect(r.stderr).not.toContain('unknown option');
    });
  }

  it('improve propose --auto-merge passes the option check and keeps its own refusal', () => {
    const r = run(['improve', 'propose', '--auto-merge', '--json']);
    expect(r.status, r.stderr).toBe(2);
    expect(r.stderr).toContain('auto-merge lacks protected-policy admission');
    expect(r.homeEntries).toEqual([]);
  });

  it('devin message accepts dash-led text after a -- separator', () => {
    const r = run(['devin', 'message', 'task-1', '--', '--literal', 'text']);
    expect(r.stderr).not.toContain('Unknown option');
    expect(r.stderr).not.toContain('test shim');
    expect(r.stderr).toContain('No Devin task with that id');
  });
});
