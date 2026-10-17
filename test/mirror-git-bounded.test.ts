/**
 * Fleet mirrors: a mirror git call stopped by its deadline or the caller's
 * signal must take its whole process tree with it. `runGit` used execFile,
 * whose timeout and abort signal only the direct child: a remote helper (or
 * any grandchild) that ignores SIGTERM kept running as an orphan after the
 * sync had already reported failure.
 *
 * The trusted git executable is replaced by a script that forks exactly such
 * a grandchild, then the caller's signal aborts the sync. REAL-IO: real
 * processes, POSIX process groups.
 */
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fake = vi.hoisted(() => ({ bin: null as string | null }));

vi.mock('../src/core/sandbox/safe-git.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/sandbox/safe-git.js')>();
  return {
    ...actual,
    resolveGitExecutable: () => fake.bin ?? actual.resolveGitExecutable(),
  };
});

import { makeFixture, type H1Fixture } from './helpers/h1-fixture.js';
import { ensureMirror } from '../src/core/fleet/mirrors.js';

let fx: H1Fixture;

beforeEach(() => {
  fx = makeFixture();
});

afterEach(() => {
  fake.bin = null;
  fx.cleanup();
});

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('mirror git calls are bounded', () => {
  it.skipIf(process.platform === 'win32')('an aborted sync settles and kills a SIGTERM-ignoring grandchild that holds stderr', async () => {
    const pidFile = join(fx.home, 'grandchild.pid');
    const bin = join(fx.home, 'fake-git');
    writeFileSync(bin, [
      '#!/bin/sh',
      // The subshell ignores SIGTERM, records its pid, then becomes a sleep
      // holding the inherited stdout/stderr open.
      `( trap '' TERM; sh -c 'echo $PPID' > '${pidFile}'; exec sleep 30 ) &`,
      'exec sleep 30',
      '',
    ].join('\n'));
    chmodSync(bin, 0o755);
    fake.bin = bin;

    const controller = new AbortController();
    const abortTimer = setTimeout(() => controller.abort(), 500);
    const started = Date.now();
    const result = await ensureMirror({ nameWithOwner: 'acme/widget' }, {
      originUrlFor: () => '/nonexistent/acme/widget.git',
      allowLocalOrigin: true,
      githubToken: async () => null,
      signal: controller.signal,
    });
    clearTimeout(abortTimer);

    expect(Date.now() - started).toBeLessThan(8_000);
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/cancel|abort/i);
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    expect(pid).toBeGreaterThan(0);
    for (let i = 0; i < 40 && alive(pid); i += 1) await new Promise((r) => setTimeout(r, 50));
    expect(alive(pid)).toBe(false);
  }, 15_000);
});
