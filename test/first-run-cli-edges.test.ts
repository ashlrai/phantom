/**
 * first-run-cli-edges.test.ts — commands a new user or an agent runs first
 * must not report success for something they did not do.
 *
 *  - `backlog <typo>` exits 2 instead of silently listing.
 *  - MCP `ashlr_orient` refuses a relative or missing repo instead of
 *    orienting on a directory that does not exist.
 *
 * The `enroll remove` / `enroll kill` --json cases live in
 * cli-json-first-run.test.ts, beside the other enroll --json cases.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cmdBacklog } from '../src/cli/backlog.js';
import { callNativeTool } from '../src/core/mcp-native.js';
import { scrubSecrets } from '../src/core/knowledge/index.js';

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
  const home = tmp('phantom-first-run-home-');
  process.env['HOME'] = home;
  process.env['USERPROFILE'] = home;
});

afterEach(() => {
  if (origHome === undefined) delete process.env['HOME']; else process.env['HOME'] = origHome;
  if (origUserProfile === undefined) delete process.env['USERPROFILE']; else process.env['USERPROFILE'] = origUserProfile;
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
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
    // Tool text is secret-scrubbed before it ships: a ≥40-char run of
    // letters/digits/slashes (every absolute tmpdir path on macOS) collapses
    // to [REDACTED], so pin the dir's pipeline-emitted form, not the raw path.
    const parsed = JSON.parse(text(r)) as { repo?: unknown };
    expect(parsed.repo).toBe(scrubSecrets(dir));
  });
});
