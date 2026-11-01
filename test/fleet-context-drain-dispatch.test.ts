import * as childProcess from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleet } from '../src/cli/fleet.js';
import { inspectBusInbox } from '../src/core/fleet/bus-inbox.js';
import { ashlrHome } from '../src/core/cloud/store.js';

// Wrap (not replace) the child-runner surfaces: a dispatched drain may never
// launch a worker, while spawnSync-based ACL checks keep working untouched.
vi.mock('node:child_process', async importOriginal => {
  const mod = await importOriginal<typeof import('node:child_process')>();
  return { ...mod, spawn: vi.fn(mod.spawn), execFile: vi.fn(mod.execFile), exec: vi.fn(mod.exec), fork: vi.fn(mod.fork) };
});

let root: string, spoolDir: string;

beforeEach(() => {
  vi.clearAllMocks();
  root = mkdtempSync(join(tmpdir(), 'context-drain-dispatch-'));
  vi.stubEnv('HOME', root); vi.stubEnv('ASHLR_HOME', join(root, '.ashlr')); vi.stubEnv('ASHLR_RUNS_DIR', join(root, '.ashlr-runs'));
  spoolDir = join(root, 'spool');
  mkdirSync(spoolDir, { mode: 0o700 });
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

// cmdFleet passes no io object to convention handlers, so capture process
// streams directly — the real dispatch path is what acceptance exercises.
async function captureFleet(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  let stdout = '', stderr = '';
  const out = vi.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => { stdout += String(chunk); return true; });
  const err = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => { stderr += String(chunk); return true; });
  try { return { code: await cmdFleet(args), stdout, stderr }; }
  finally { out.mockRestore(); err.mockRestore(); }
}

describe('fleet context-drain dispatch', () => {
  it('resolves context-drain --help through cmdFleet to the convention handler', async () => {
    const { code, stdout, stderr } = await captureFleet(['context-drain', '--help']);
    expect(code).toBe(0);
    expect(stderr).toBe('');
    // The handler's own usage line proves dispatch; the generic fallback help
    // would still exit 0 but never names --spool-dir.
    expect(stdout).toContain('fleet context-drain --spool-dir');
    expect(childProcess.spawn).not.toHaveBeenCalled();
    expect(childProcess.execFile).not.toHaveBeenCalled();
    expect(childProcess.exec).not.toHaveBeenCalled();
    expect(childProcess.fork).not.toHaveBeenCalled();
  });

  it('previews a private empty spool through cmdFleet with no worker and no bus post', async () => {
    const { code, stdout, stderr } = await captureFleet(['context-drain', '--spool-dir', spoolDir, '--json']);
    expect(code).toBe(0);
    expect(stderr).toBe('');
    const report = JSON.parse(stdout) as Record<string, unknown>;
    expect(report).toMatchObject({
      status: 'ok', mode: 'preview',
      scanned: 0, matched: 0, selected: 0,
      truncated: false, overflow: false,
      records: [], counts: {}, retained: [], exitCode: 0,
    });
    expect(childProcess.spawn).not.toHaveBeenCalled();
    expect(childProcess.execFile).not.toHaveBeenCalled();
    expect(childProcess.exec).not.toHaveBeenCalled();
    expect(childProcess.fork).not.toHaveBeenCalled();
    // The default bus store under the isolated ASHLR_HOME was never created.
    expect(inspectBusInbox().source).toBe('missing');
    expect(existsSync(join(ashlrHome(), 'fleet'))).toBe(false);
  });
});
