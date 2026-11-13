/**
 * fleet-appearance-cli-119 — `ashlr fleet appearance` reads and writes the
 * shared appearance record under a temp ASHLR_RUNS_DIR: get, set, --json and
 * the exit-2 usage errors.
 */
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetAppearance } from '../src/cli/fleet-appearance.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

let runs = '';
let saved: string | undefined;
let log: ReturnType<typeof vi.spyOn>;
let err: ReturnType<typeof vi.spyOn>;

function file() {
  return JSON.parse(readFileSync(join(runs, 'ui', 'appearance.json'), 'utf8')) as {
    revision: number;
    updatedBy: string;
    appearance: Record<string, unknown>;
  };
}

beforeEach(() => {
  runs = mkdtempSync(join(tmpdir(), 'fleet-appearance-119-'));
  saved = process.env['ASHLR_RUNS_DIR'];
  process.env['ASHLR_RUNS_DIR'] = runs;
  log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  if (saved === undefined) delete process.env['ASHLR_RUNS_DIR']; else process.env['ASHLR_RUNS_DIR'] = saved;
  rmSync(runs, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('ashlr fleet appearance', () => {
  it('loads through the generated fleet registry', async () => {
    expect((await FLEET_SUBCOMMAND_LOADERS['appearance']!()).cmdFleetAppearance).toBe(cmdFleetAppearance);
  });

  it('prints the empty record, then what a set wrote', async () => {
    expect(await cmdFleetAppearance(['--json'])).toBe(0);
    expect(JSON.parse(String(log.mock.calls.at(-1)![0]))).toEqual({ revision: 0, appearance: null });
    expect(await cmdFleetAppearance([])).toBe(0);
    expect(String(log.mock.calls.at(-1)![0])).toContain('No appearance recorded yet');

    expect(await cmdFleetAppearance(['set', '--theme', 'dark', '--density', 'compact', '--accent-hue', '370', '--by', 'test-agent'])).toBe(0);
    const stored = file();
    expect(stored.revision).toBe(1);
    expect(stored.updatedBy).toBe('test-agent');
    expect(stored.appearance).toMatchObject({ theme: 'dark', density: 'compact', accentH: 10 });

    expect(await cmdFleetAppearance(['--json'])).toBe(0);
    expect(JSON.parse(String(log.mock.calls.at(-1)![0]))).toMatchObject({
      revision: 1, updatedBy: 'test-agent',
      appearance: { theme: 'dark', density: 'compact', accentH: 10 },
    });
  });

  it('merges a patch over the stored record (a bare --theme keeps the accent)', async () => {
    expect(await cmdFleetAppearance(['set', '--accent-hue', '42', '--accent-light', '60'])).toBe(0);
    expect(await cmdFleetAppearance(['set', '--theme', 'light'])).toBe(0);
    expect(file().appearance).toMatchObject({ theme: 'light', accentH: 42, accentL: 60 });
  });

  it('exits 2 with a clear message on invalid values and unknown flags', async () => {
    for (const args of [
      ['set', '--theme', 'neon'],
      ['set', '--density', 'spacious'],
      ['set', '--motion', 'sometimes'],
      ['set', '--accent-hue', 'abc'],
      ['set', '--accent-sat'],
      ['set'],
      ['set', '--bogus', 'x'],
      ['bogus'],
      ['--json', '--json'],
    ]) {
      expect(await cmdFleetAppearance(args), args.join(' ')).toBe(2);
      expect(String(err.mock.calls.at(-1)![0])).toMatch(/must be|needs|Unknown|Usage/);
    }
    // Nothing was ever written.
    expect(await cmdFleetAppearance(['--json'])).toBe(0);
    expect(JSON.parse(String(log.mock.calls.at(-1)![0]))).toEqual({ revision: 0, appearance: null });
  });

  it('prints usage on --help and -h without touching the record', async () => {
    expect(await cmdFleetAppearance(['--help'])).toBe(0);
    expect(await cmdFleetAppearance(['-h'])).toBe(0);
    expect(String(log.mock.calls[0]![0])).toContain('Usage: ashlr fleet appearance');
    expect(existsSync(join(runs, 'ui', 'appearance.json'))).toBe(false);
  });
});
