/**
 * first-run-cli-edges.test.ts — commands a new user or an agent runs first
 * must not report success for something they did not do.
 *
 *  - `enroll remove --json <repo>` removes <repo> (it used to unenroll the
 *    literal `--json` and leave <repo> enrolled), emits one JSON object, and
 *    says when the repo was not enrolled; `enroll kill on --json` is JSON too.
 *  - `backlog <typo>` exits 2 instead of silently listing.
 *  - MCP `ashlr_orient` refuses a relative or missing repo instead of
 *    orienting on a directory that does not exist.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mocks = vi.hoisted(() => ({
  unenroll: vi.fn(),
  setKill: vi.fn(),
}));

vi.mock('../src/core/sandbox/policy.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/sandbox/policy.js')>(),
  unenroll: mocks.unenroll,
  setKill: mocks.setKill,
}));

import { cmdEnroll } from '../src/cli/sandbox.js';
import { cmdBacklog } from '../src/cli/backlog.js';
import { callNativeTool } from '../src/core/mcp-native.js';

const dirs: string[] = [];
const origHome = process.env['HOME'];
const origUserProfile = process.env['USERPROFILE'];

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(d);
  return d;
}

interface Captured { code: number; stdout: string; stderr: string }

async function capture(run: () => Promise<number>): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  vi.spyOn(console, 'log').mockImplementation((...v: unknown[]) => { out.push(v.map(String).join(' ') + '\n'); });
  vi.spyOn(console, 'error').mockImplementation((...v: unknown[]) => { err.push(v.map(String).join(' ') + '\n'); });
  vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write);
  try {
    const code = await run();
    return { code, stdout: out.join(''), stderr: err.join('') };
  } finally {
    vi.restoreAllMocks();
  }
}

beforeEach(() => {
  mocks.unenroll.mockReset();
  mocks.setKill.mockReset();
  const home = tmp('phantom-first-run-home-');
  process.env['HOME'] = home;
  process.env['USERPROFILE'] = home;
});

afterEach(() => {
  if (origHome === undefined) delete process.env['HOME']; else process.env['HOME'] = origHome;
  if (origUserProfile === undefined) delete process.env['USERPROFILE']; else process.env['USERPROFILE'] = origUserProfile;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('enroll remove / kill', () => {
  it('remove --json before the repo removes the repo, not "--json", and prints one JSON object', async () => {
    mocks.unenroll.mockReturnValue({ ok: true, changed: true, quiesced: true, reason: 'unenrolled' });
    const r = await capture(() => cmdEnroll(['remove', '--json', '/tmp/r']));
    expect(r.code).toBe(0);
    expect(mocks.unenroll).toHaveBeenCalledWith('/tmp/r');
    expect(JSON.parse(r.stdout)).toEqual({ ok: true, repo: '/tmp/r', enrolled: false, removed: true });
  });

  it('remove says when the repo was not enrolled', async () => {
    mocks.unenroll.mockReturnValue({ ok: true, changed: false, quiesced: true, reason: 'already-unenrolled' });
    const human = await capture(() => cmdEnroll(['remove', '/tmp/never']));
    expect(human.code).toBe(0);
    expect(human.stdout).toContain('Not enrolled, nothing removed');
    expect(human.stdout).not.toContain('Removed:');
    const json = await capture(() => cmdEnroll(['remove', '/tmp/never', '--json']));
    expect(JSON.parse(json.stdout)).toMatchObject({ ok: true, removed: false });
  });

  it('remove failures and usage errors are JSON under --json with unchanged exit codes', async () => {
    mocks.unenroll.mockReturnValue({ ok: false, changed: false, quiesced: false, reason: 'policy storage unsafe' });
    const failed = await capture(() => cmdEnroll(['remove', '/tmp/r', '--json']));
    expect(failed.code).toBe(1);
    expect(JSON.parse(failed.stdout)).toMatchObject({ ok: false, repo: '/tmp/r' });
    const usage = await capture(() => cmdEnroll(['remove', '--json']));
    expect(usage.code).toBe(2);
    expect(JSON.parse(usage.stdout)['error']).toMatch(/^Usage: ashlr enroll remove/);
    expect(mocks.unenroll).toHaveBeenCalledTimes(1);
  });

  it('kill accepts --json in any position and prints one JSON object', async () => {
    mocks.setKill.mockReturnValue({ ok: true, changed: true, quiesced: true, reason: 'ok' });
    const on = await capture(() => cmdEnroll(['kill', '--json', 'on']));
    expect(on.code).toBe(0);
    expect(mocks.setKill).toHaveBeenCalledWith(true);
    expect(JSON.parse(on.stdout)).toEqual({ ok: true, killSwitchOn: true });
    const bad = await capture(() => cmdEnroll(['kill', 'maybe', '--json']));
    expect(bad.code).toBe(2);
    expect(JSON.parse(bad.stdout)['error']).toMatch(/^Usage: ashlr enroll kill/);
  });

  it('keeps the human lines without --json', async () => {
    mocks.unenroll.mockReturnValue({ ok: true, changed: true, quiesced: true, reason: 'unenrolled' });
    mocks.setKill.mockReturnValue({ ok: true, changed: true, quiesced: true, reason: 'ok' });
    expect((await capture(() => cmdEnroll(['remove', '/tmp/r']))).stdout).toContain('Removed:');
    expect((await capture(() => cmdEnroll(['kill', 'off']))).stdout).toContain('Kill switch OFF');
  });
});

describe('backlog', () => {
  it('rejects an unknown subcommand instead of listing', async () => {
    const r = await capture(() => cmdBacklog(['refesh']));
    expect(r.code).toBe(2);
    expect(r.stderr).toContain('Unknown backlog subcommand: refesh');
  });
});

describe('MCP ashlr_orient repo argument', () => {
  function text(r: { content: { type: 'text'; text: string }[] }): string {
    return r.content.map((c) => c.text).join('\n');
  }

  it('refuses a relative path', async () => {
    const r = await callNativeTool('ashlr_orient', { repo: 'relative/path' });
    expect(text(r)).toContain('repo must be an absolute path');
    expect(text(r)).not.toContain('generatedAt');
  });

  it('refuses a missing directory and a file', async () => {
    const dir = tmp('phantom-first-run-repo-');
    const file = join(dir, 'README.md');
    writeFileSync(file, 'x');
    for (const repo of [join(dir, 'nope'), file]) {
      const r = await callNativeTool('ashlr_orient', { repo });
      expect(text(r), repo).toContain('is not a directory');
    }
  });

  it('still orients on an existing absolute directory', async () => {
    const dir = tmp('phantom-first-run-repo-');
    const r = await callNativeTool('ashlr_orient', { repo: dir });
    expect(r.isError).toBeUndefined();
    expect(JSON.parse(text(r))).toMatchObject({ repo: dir });
  });
});
