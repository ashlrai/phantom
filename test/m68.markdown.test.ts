/**
 * M68 — ashlr-md rendering integration tests.
 *
 * Coverage:
 *   1. renderToTempMarkdown writes a file with the expected content, then cleans up.
 *   2. ashlrMdInstalled() returns a boolean and never throws.
 *   3. openInAshlrMd on a bogus path (or when mdopen absent) returns ok:false, never throws.
 *   4. presentMarkdown degrades gracefully (rendered:false) when ashlr-md is absent.
 *
 * CI safety contract:
 *   - No GUI is launched in CI. Tests that exercise openInAshlrMd / presentMarkdown
 *     guard the real spawn behind ashlrMdInstalled() — when mdopen is absent (all CI),
 *     these paths return ok:false / rendered:false without spawning anything.
 *   - renderToTempMarkdown writes to os.tmpdir() (the temp file is removed after each test).
 *   - node:child_process is mocked: mdopen is never really launched, even on a
 *     developer machine that has it. Resolution (PATH / fixed install paths)
 *     uses the real filesystem with temp fixtures.
 */

import type { SpawnSyncReturns } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

const { spawnSync } = vi.hoisted(() => ({ spawnSync: vi.fn() }));
vi.mock('node:child_process', () => ({ spawnSync }));

import {
  ashlrMdInstalled,
  openInAshlrMd,
  presentMarkdown,
  renderToTempMarkdown,
  resolveMdopen,
} from '../src/core/integrations/markdown.js';

function spawnResult(status: number | null, stderr = '', error?: Error): SpawnSyncReturns<string> {
  return { pid: 1, output: [], stdout: '', stderr, status, signal: null, error };
}

beforeEach(() => {
  // Default: a headless mdopen that cannot open a window.
  spawnSync.mockReset().mockReturnValue(spawnResult(1, 'mdopen: no display'));
});

/** Paths written during a test, to clean up in afterEach. */
const tempPaths: string[] = [];

afterEach(() => {
  for (const p of tempPaths.splice(0)) {
    try {
      rmSync(p, { force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

// ── renderToTempMarkdown ──────────────────────────────────────────────────────

describe('renderToTempMarkdown', () => {
  it('returns a non-null path for a valid title + body', () => {
    const path = renderToTempMarkdown('Test Title', 'Hello world');
    expect(path).not.toBeNull();
    if (path) tempPaths.push(path);
  });

  it('writes a file that physically exists on disk', () => {
    const path = renderToTempMarkdown('Disk Check', 'some body text');
    expect(path).not.toBeNull();
    if (path) {
      tempPaths.push(path);
      expect(existsSync(path)).toBe(true);
    }
  });

  it('written file begins with the title as an H1 heading', () => {
    const title = 'My Proposal Title';
    const body = 'Proposal body content here.';
    const path = renderToTempMarkdown(title, body);
    expect(path).not.toBeNull();
    if (path) {
      tempPaths.push(path);
      const content = readFileSync(path, 'utf8');
      expect(content).toContain(`# ${title}`);
    }
  });

  it('written file contains the body text', () => {
    const body = 'This is a unique body string for M68 test.';
    const path = renderToTempMarkdown('Body Check', body);
    expect(path).not.toBeNull();
    if (path) {
      tempPaths.push(path);
      const content = readFileSync(path, 'utf8');
      expect(content).toContain(body);
    }
  });

  it('generated filename has .md extension', () => {
    const path = renderToTempMarkdown('Extension Test', 'body');
    expect(path).not.toBeNull();
    if (path) {
      tempPaths.push(path);
      expect(path.endsWith('.md')).toBe(true);
    }
  });

  it('two calls with same title produce distinct files (timestamp-based names)', () => {
    const p1 = renderToTempMarkdown('Distinct', 'first');
    const p2 = renderToTempMarkdown('Distinct', 'second');
    if (p1) tempPaths.push(p1);
    if (p2) tempPaths.push(p2);
    expect(p1).not.toBeNull();
    expect(p2).not.toBeNull();
    expect(p1).not.toBe(p2);
  });

  it('handles an empty title without throwing', () => {
    expect(() => {
      const path = renderToTempMarkdown('', 'body');
      if (path) tempPaths.push(path);
    }).not.toThrow();
  });

  it('handles special characters in title without throwing', () => {
    expect(() => {
      const path = renderToTempMarkdown('Hello / World: <test> & "more"', 'body');
      if (path) tempPaths.push(path);
    }).not.toThrow();
  });
});

// ── ashlrMdInstalled ──────────────────────────────────────────────────────────

describe('ashlrMdInstalled', () => {
  it('returns a boolean (true or false) — never throws', () => {
    let result: boolean | undefined;
    expect(() => {
      result = ashlrMdInstalled();
    }).not.toThrow();
    expect(typeof result).toBe('boolean');
  });

  it('does not throw when called multiple times in succession', () => {
    expect(() => {
      ashlrMdInstalled();
      ashlrMdInstalled();
      ashlrMdInstalled();
    }).not.toThrow();
  });
});

// ── openInAshlrMd ─────────────────────────────────────────────────────────────

describe('openInAshlrMd', () => {
  it('never throws — always returns { ok, detail }', () => {
    let result: { ok: boolean; detail: string } | undefined;
    expect(() => {
      result = openInAshlrMd('/nonexistent/bogus/path/file.md');
    }).not.toThrow();
    expect(result).toBeDefined();
    expect(typeof result!.ok).toBe('boolean');
    expect(typeof result!.detail).toBe('string');
  });

  it('returns ok:false when mdopen is not installed (or bogus path in CI)', () => {
    // If mdopen is absent (all CI), this is the degrade path — ok must be false.
    // If mdopen IS installed (developer machine), we still pass a nonexistent file
    // — the spawn starts (ok:true) but the viewer handles the missing file.
    // Either way: never throws; ok is a boolean.
    const installed = ashlrMdInstalled();
    const result = openInAshlrMd('/nonexistent/bogus/m68-test-file.md');
    expect(typeof result.ok).toBe('boolean');
    expect(typeof result.detail).toBe('string');
    if (!installed) {
      // Hard guarantee when not installed: must be ok:false.
      expect(result.ok).toBe(false);
      expect(result.detail.length).toBeGreaterThan(0);
    }
  });

  it('returns a non-empty detail string in all cases', () => {
    const result = openInAshlrMd('/some/file.md');
    expect(result.detail.length).toBeGreaterThan(0);
  });
});

// ── presentMarkdown ───────────────────────────────────────────────────────────

describe('presentMarkdown', () => {
  it('never throws — always returns { rendered, detail }', () => {
    let result: { rendered: boolean; path?: string; detail: string } | undefined;
    expect(() => {
      result = presentMarkdown('Test', 'body content');
    }).not.toThrow();
    expect(result).toBeDefined();
    expect(typeof result!.rendered).toBe('boolean');
    expect(typeof result!.detail).toBe('string');
    if (result!.path) tempPaths.push(result!.path);
  });

  it('always includes a non-empty detail string', () => {
    const result = presentMarkdown('Detail Check', 'body');
    if (result.path) tempPaths.push(result.path);
    expect(result.detail.length).toBeGreaterThan(0);
  });

  it('degrades gracefully (rendered:false) when ashlr-md is absent', () => {
    if (ashlrMdInstalled()) {
      // On a machine with mdopen, rendered may be true — skip this assertion.
      const result = presentMarkdown('Skip Check', 'body');
      if (result.path) tempPaths.push(result.path);
      expect(typeof result.rendered).toBe('boolean');
      return;
    }
    const result = presentMarkdown('Degrade Test', 'body content for degrade');
    if (result.path) tempPaths.push(result.path);
    // Hard guarantee: rendered is false when mdopen is absent.
    expect(result.rendered).toBe(false);
    expect(result.detail.length).toBeGreaterThan(0);
  });

  it('still writes a temp file and includes path even when viewer is absent', () => {
    if (ashlrMdInstalled()) return; // only relevant in CI / no-mdopen machines
    const result = presentMarkdown('Path Even Without Viewer', 'body');
    if (result.path) tempPaths.push(result.path);
    // The temp file is written even when ashlr-md is not installed —
    // callers can still read it for terminal fallback.
    expect(result.path).toBeDefined();
    expect(existsSync(result.path!)).toBe(true);
  });

  it('written temp file contains the expected title and body', () => {
    const title = 'Proposal: Add Feature X';
    const body = 'This proposal adds Feature X to the system.';
    const result = presentMarkdown(title, body);
    if (result.path) {
      tempPaths.push(result.path);
      const content = readFileSync(result.path, 'utf8');
      expect(content).toContain(`# ${title}`);
      expect(content).toContain(body);
    }
    expect(result.rendered !== undefined).toBe(true);
  });
});

// ── mdopen resolution + honest open result ───────────────────────────────────

describe('resolveMdopen / openInAshlrMd with a resolved mdopen', () => {
  const dirs: string[] = [];
  let savedPath: string | undefined;

  function binDir(...names: string[]): string {
    const dir = mkdtempSync(join(tmpdir(), 'ashlr-m68-bin-'));
    dirs.push(dir);
    for (const name of names) {
      writeFileSync(join(dir, name), '#!/bin/sh\nexit 0\n', 'utf8');
      chmodSync(join(dir, name), 0o755);
    }
    return dir;
  }

  beforeEach(() => {
    savedPath = process.env['PATH'];
  });

  afterEach(() => {
    if (savedPath === undefined) delete process.env['PATH'];
    else process.env['PATH'] = savedPath;
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  // Host path syntax: the ':'-joined POSIX case cannot hold drive-letter paths.
  it.skipIf(process.platform === 'win32')('searches PATH in-process, with .exe on Windows, then fixed install paths', () => {
    const empty = binDir();
    const posix = binDir('mdopen');
    const win = binDir('mdopen.exe');
    expect(resolveMdopen({ PATH: `${empty}:${posix}` }, 'linux', [])).toBe(join(posix, 'mdopen'));
    expect(resolveMdopen({ Path: `${empty};${win}` }, 'win32', [])).toBe(join(win, 'mdopen.exe'));
    // A .cmd shim cannot be spawned without a shell (CVE-2024-27980), so it is not resolved.
    expect(resolveMdopen({ Path: `${empty};${binDir('mdopen.cmd')}` }, 'win32', [])).toBeNull();
    expect(resolveMdopen({ PATH: empty }, 'linux', [])).toBeNull();
    // Linux .deb / macOS app bundle install mdopen off PATH.
    const fixed = join(binDir('mdopen'), 'mdopen');
    expect(resolveMdopen({ PATH: empty }, 'linux', ['/nonexistent/Ashlr MD/mdopen', fixed])).toBe(fixed);
    expect(spawnSync).not.toHaveBeenCalled();
  });

  it('reports ok:false with exit code and stderr when mdopen exits non-zero', () => {
    const dir = binDir('mdopen');
    process.env['PATH'] = dir;
    const result = openInAshlrMd('/tmp/doc.md');
    expect(result).toEqual({ ok: false, detail: 'mdopen exit 1: mdopen: no display' });
    expect(spawnSync).toHaveBeenCalledWith(join(dir, 'mdopen'), ['/tmp/doc.md'], expect.objectContaining({
      timeout: 15_000, stdio: ['ignore', 'ignore', 'pipe'], encoding: 'utf8',
    }));
  });

  it('reports ok:true only when mdopen exits 0 (including launched-but-unconfirmed)', () => {
    process.env['PATH'] = binDir('mdopen');
    spawnSync.mockReturnValueOnce(spawnResult(0, 'mdopen: launched, not confirmed'));
    const result = openInAshlrMd('/tmp/doc.md');
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('not confirmed');
  });

  it('reports a timeout or launch error as ok:false', () => {
    process.env['PATH'] = binDir('mdopen');
    spawnSync.mockReturnValueOnce(spawnResult(null, '', Object.assign(new Error('spawnSync mdopen ETIMEDOUT'), { code: 'ETIMEDOUT' })));
    expect(openInAshlrMd('/tmp/doc.md')).toEqual({ ok: false, detail: 'mdopen failed: spawnSync mdopen ETIMEDOUT' });
  });

  it('presentMarkdown is rendered:false when mdopen fails, so callers fall back', () => {
    process.env['PATH'] = binDir('mdopen');
    const result = presentMarkdown('Headless', 'body');
    if (result.path) tempPaths.push(result.path);
    expect(result.rendered).toBe(false);
    expect(result.detail).toContain('exit 1');
    expect(result.path && existsSync(result.path)).toBe(true);
  });
});
