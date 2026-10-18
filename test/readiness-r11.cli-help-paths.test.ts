/**
 * Readiness round 11: commands that acted on --help or on input they could
 * not use.
 *   - `ship <missing path>` skipped every check and printed GATE PASSED, exit 0.
 *   - `steward disk --apply --help` deleted files; unknown flags ran silently.
 *   - `pulse-test --help` sent the probe span instead of printing usage.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const runSteward = vi.fn(() => ({
  applied: false, roots: [], reclaimableBytes: 0,
  deleted: { files: 0, bytes: 0 }, archived: { files: 0, bytes: 0 },
}));
vi.mock('../src/core/steward/disk.js', () => ({
  defaultStewardPolicy: () => ({}),
  runSteward: (...a: unknown[]) => runSteward(...(a as [])),
}));

const postProbeSpan = vi.fn(async () => ({ ok: true, status: 200, label: 'ok', exitCode: 0 }));
vi.mock('../src/core/fleet/pulse-export.js', async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  postProbeSpan: (...a: unknown[]) => postProbeSpan(...(a as [])),
}));

let dir: string;
let out: string[];
let err: string[];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'r11-'));
  out = []; err = [];
  vi.spyOn(console, 'log').mockImplementation((...a) => { out.push(a.join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...a) => { err.push(a.join(' ')); });
  vi.spyOn(process.stdout, 'write').mockImplementation((c) => { out.push(String(c)); return true; });
  vi.spyOn(process.stderr, 'write').mockImplementation((c) => { err.push(String(c)); return true; });
  runSteward.mockClear();
  postProbeSpan.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(dir, { recursive: true, force: true });
});

describe('ship refuses a path that is not a project directory', () => {
  it('missing path exits 2 without printing GATE PASSED', async () => {
    const { cmdShip } = await import('../src/cli/ship.js');
    const code = await cmdShip([join(dir, 'nope')]);
    expect(code).toBe(2);
    expect(err.join('')).toContain('project path is not a directory');
    expect(out.join('')).not.toContain('GATE PASSED');
  });

  it('a file path exits 2', async () => {
    const { cmdShip } = await import('../src/cli/ship.js');
    const file = join(dir, 'f.txt');
    writeFileSync(file, 'x');
    expect(await cmdShip([file, '--json'])).toBe(2);
    expect(out.join('')).toBe('');
  });

  it('an existing directory still runs the gate', async () => {
    const { cmdShip } = await import('../src/cli/ship.js');
    expect(await cmdShip([dir])).toBe(0);
    expect(out.join('')).toContain('GATE PASSED');
  });
});

describe('steward prints usage on --help and refuses unknown flags', () => {
  it.each([[['--help']], [['disk', '--help']], [['disk', '--apply', '--help']], [['-h']]])('%j exits 0 without scanning', async (args) => {
    const { cmdSteward } = await import('../src/cli/steward.js');
    expect(await cmdSteward(args)).toBe(0);
    expect(out.join('')).toContain('Usage: phm steward disk');
    expect(runSteward).not.toHaveBeenCalled();
  });

  it('unknown flag exits 2 before scanning', async () => {
    const { cmdSteward } = await import('../src/cli/steward.js');
    expect(await cmdSteward(['disk', '--aply'])).toBe(2);
    expect(err.join('')).toContain('unknown argument: --aply');
    expect(runSteward).not.toHaveBeenCalled();
  });

  it('disk --json still scans', async () => {
    const { cmdSteward } = await import('../src/cli/steward.js');
    expect(await cmdSteward(['disk', '--json'])).toBe(0);
    expect(runSteward).toHaveBeenCalledWith({}, { apply: false });
  });
});

describe('pulse-test prints usage on --help and sends no probe', () => {
  it('--help exits 0 without the probe', async () => {
    const { cmdPulseTest } = await import('../src/cli/pulse.js');
    expect(await cmdPulseTest(['--help'])).toBe(0);
    expect(out.join('')).toContain('Usage: phm pulse-test');
    expect(postProbeSpan).not.toHaveBeenCalled();
  });

  it('pulse test --help routes the same way', async () => {
    const { cmdPulse } = await import('../src/cli/pulse.js');
    expect(await cmdPulse(['test', '--help'])).toBe(0);
    expect(postProbeSpan).not.toHaveBeenCalled();
  });

  it('a stray argument exits 2 without the probe', async () => {
    const { cmdPulseTest } = await import('../src/cli/pulse.js');
    expect(await cmdPulseTest(['--bogus'])).toBe(2);
    expect(err.join('')).toContain('unknown argument: --bogus');
    expect(postProbeSpan).not.toHaveBeenCalled();
  });

  it('no arguments still probes', async () => {
    const { cmdPulseTest } = await import('../src/cli/pulse.js');
    await cmdPulseTest([]);
    expect(postProbeSpan).toHaveBeenCalledTimes(1);
  });
});
