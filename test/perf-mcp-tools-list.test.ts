/**
 * Tests for scripts/perf-mcp-tools-list.mjs — the MCP tools/list latency
 * harness used by the phm-mcp-tools-list perf target.
 *
 * Hermetic: HOME and ASHLR_HOME point at a temp dir, the gateway is spawned
 * as a real subprocess, and no network or credentials are involved. When
 * dist/ is not built the end-to-end case is skipped — a missing build is an
 * environment issue (the perf target's requires_files reports it as an
 * error), never a silent pass.
 */

import { describe, it, expect } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const SCRIPT = join(REPO, 'scripts', 'perf-mcp-tools-list.mjs');
const BUILT_CLI = join(REPO, 'dist', 'cli', 'index.js');
const distBuilt = existsSync(BUILT_CLI);

function runHarness(env: NodeJS.ProcessEnv): { status: number | null; stderr: string } {
  const r = spawnSync(process.execPath, [SCRIPT], {
    encoding: 'utf8',
    timeout: 60_000,
    env: { ...process.env, ...env },
  });
  return { status: r.status, stderr: r.stderr ?? '' };
}

describe('perf-mcp-tools-list harness', () => {
  it('completes the initialize → tools/list handshake on a scratch HOME', () => {
    if (!distBuilt) return; // no build — preflight covers this on the real check
    const home = mkdtempSync(join(tmpdir(), 'perf-mcp-home-'));
    try {
      const r = runHarness({ HOME: home, ASHLR_HOME: join(home, '.ashlr'), ASHLR_PERF_MCP_TIMEOUT_MS: '30000' });
      expect(r.status).toBe(0);
      // stderr reports the breakdown; the tool count must be a real number.
      expect(r.stderr).toMatch(/perf-mcp-tools-list: \d+(\.\d+)?ms total/);
      expect(r.stderr).toMatch(/tools\/list \d+(\.\d+)?ms, \d+ tools\)/);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('exits non-zero when the gateway cannot answer (missing dist)', () => {
    if (distBuilt) return;
    const home = mkdtempSync(join(tmpdir(), 'perf-mcp-home-'));
    try {
      const r = runHarness({ HOME: home, ASHLR_HOME: join(home, '.ashlr'), ASHLR_PERF_MCP_TIMEOUT_MS: '20000' });
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('perf-mcp-tools-list:');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
