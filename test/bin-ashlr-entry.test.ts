/**
 * Tests for bin/ashlr's compile-cache startup path.
 *
 * The shim calls module.enableCompileCache() before importing the CLI so the
 * dist/ module graph skips V8 recompilation on warm runs. The safety contract:
 * a missing, unwritable or bogus cache location must NEVER break startup —
 * the shim falls back to an uncached run.
 *
 * Hermetic: HOME/ASHLR_HOME and NODE_COMPILE_CACHE point at temp dirs; no
 * network, no credentials. Skipped when dist/ is absent (environment issue,
 * not a regression — mirrors the perf target's requires_files preflight).
 */

import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const SHIM = join(REPO, 'bin', 'ashlr');
const distBuilt = existsSync(join(REPO, 'dist', 'cli', 'index.js'));

function runShim(env: NodeJS.ProcessEnv): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [SHIM, '--version'], {
    encoding: 'utf8',
    timeout: 30_000,
    env: { ...process.env, ...env },
  });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

describe('bin/ashlr compile-cache entry', () => {
  it('prints the version with a writable NODE_COMPILE_CACHE dir', () => {
    if (!distBuilt) return;
    const home = mkdtempSync(join(tmpdir(), 'bin-ashlr-home-'));
    try {
      const r = runShim({
        HOME: home,
        ASHLR_HOME: join(home, '.ashlr'),
        NODE_COMPILE_CACHE: join(home, 'compile-cache'),
      });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('still starts when the cache path is a regular file (cache unusable)', () => {
    if (!distBuilt) return;
    const home = mkdtempSync(join(tmpdir(), 'bin-ashlr-home-'));
    try {
      const notADir = join(home, 'not-a-dir');
      writeFileSync(notADir, 'x');
      const r = runShim({
        HOME: home,
        ASHLR_HOME: join(home, '.ashlr'),
        NODE_COMPILE_CACHE: notADir,
      });
      expect(r.status).toBe(0);
      expect(r.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
