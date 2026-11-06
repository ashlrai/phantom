import { afterEach, describe, expect, it, vi } from 'vitest';
import { runFleetRegistryCheck, selectChangedFiles } from '../scripts/verify-changed.mjs';

afterEach(() => {
  process.exitCode = 0;
  vi.restoreAllMocks();
});

describe('fleet registry verification', () => {
  it('selects added, modified, and deleted fleet commands', () => {
    for (const existing of [['src/cli/fleet-x.ts'], []]) {
      expect(selectChangedFiles(['src/cli/fleet-x.ts'], existing).fleetRegistry).toBe(true);
    }
    for (const path of ['src/cli/other.ts', 'test/fleet-x.test.ts', 'src/cli/nested/fleet-x.ts']) {
      expect(selectChangedFiles([path], [path]).fleetRegistry).toBe(false);
    }
  });

  it('runs the check once and reports success through the runner', () => {
    const run = vi.fn(() => { console.log('PASS fleet registry check'); return true; });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(runFleetRegistryCheck(true, run)).toBe(true);
    expect(run).toHaveBeenCalledExactlyOnceWith('fleet registry check', 'scripts/gen-fleet-registry.mjs', ['--check']);
    expect(log).toHaveBeenCalledWith('PASS fleet registry check');
  });

  it('fails and names the fix when the runner fails', () => {
    const run = vi.fn(() => { console.log('FAIL fleet registry check'); return false; });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(runFleetRegistryCheck(true, run)).toBe(false);
    expect(log).toHaveBeenCalledWith('FAIL fleet registry check');
    expect(error).toHaveBeenCalledWith(expect.stringContaining('node scripts/gen-fleet-registry.mjs'));
    expect(process.exitCode).toBe(1);
  });

  it('skips the runner when no fleet command changed', () => {
    const run = vi.fn();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(runFleetRegistryCheck(false, run)).toBe(true);
    expect(run).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledWith(expect.stringContaining('skipped'));
  });
});
