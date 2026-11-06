import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetGlance } from '../src/cli/fleet-glance.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { readOperatorGlance } from '../src/core/fleet/operator-glance-read.js';
import { formatOperatorGlance, isOperatorGlance } from '../src/core/fleet/operator-glance.js';

const dirs: string[] = [];
const now = () => new Date('2026-10-31T12:00:00Z');
function tempDir(): string { const dir = mkdtempSync(join(tmpdir(), 'glance-')); dirs.push(dir); return dir; }
afterEach(() => { vi.restoreAllMocks(); for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('fleet glance', () => {
  it('prints the shared text and JSON for a fixture, even when main is down', async () => {
    const runsDir = tempDir();
    mkdirSync(join(runsDir, 'supervisor'));
    writeFileSync(join(runsDir, 'supervisor', 'status-test.md'), 'main: down\n');
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const expected = await readOperatorGlance({ runsDir, now });
    expect(expected.main).toBe('down');
    expect(await cmdFleetGlance(['--root', runsDir], { now })).toBe(0);
    expect(log).toHaveBeenLastCalledWith(formatOperatorGlance(expected, now().getTime()));
    expect(await cmdFleetGlance(['--json'], { runsDir, now })).toBe(0);
    expect(isOperatorGlance(JSON.parse(log.mock.lastCall![0] as string))).toBe(true);
  });
  it('reports unknown readings for an empty root', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetGlance([], { runsDir: tempDir(), now })).toBe(0);
    expect(log.mock.lastCall![0]).toContain('unknown');
  });
  it('rejects invalid flags and displays help', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    for (const args of [['--bad'], ['--json', '--json'], ['--root'], ['--root', '-x'], ['--root', 'a', '--root', 'b'], ['--help', '--json']]) {
      expect(await cmdFleetGlance(args)).toBe(2);
      expect(error.mock.lastCall![0]).toContain('Usage:');
    }
    expect(await cmdFleetGlance(['--help'])).toBe(0);
    expect(log.mock.lastCall![0]).toContain('Usage:');
  });
  it('registers the loader', async () => {
    expect((await FLEET_SUBCOMMAND_LOADERS.glance!()).cmdFleetGlance).toBe(cmdFleetGlance);
  });
  it('hides errors from the reader', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdFleetGlance([], { now: () => { throw new Error('/private/path'); } })).toBe(1);
    expect(error.mock.lastCall![0]).toBe('Unable to read fleet glance.');
  });
});
