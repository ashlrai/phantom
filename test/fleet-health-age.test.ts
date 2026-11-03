import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetHealthAge } from '../src/cli/fleet-health-age.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

describe('fleet health-age', () => {
  let runsDir: string;
  const now = () => new Date(2026, 10, 3, 12, 0, 0).getTime();
  beforeEach(() => {
    runsDir = mkdtempSync(join(tmpdir(), 'health-age-'));
    mkdirSync(join(runsDir, 'supervisor'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => { vi.restoreAllMocks(); rmSync(runsDir, { recursive: true, force: true }); });
  it.each([
    ['2026-11-03 11:59:00', 'fresh', 60, 0],
    ['2026-11-03 11:30:00', 'fresh', 1800, 0],
    ['2026-11-03 11:29:59', 'stale', 1801, 1],
    ['2026-11-03 12:01:00', 'future timestamp', -60, 1],
    ['2026-02-30 11:59:00', 'malformed timestamp', null, 1],
    ['bad', 'malformed timestamp', null, 1],
  ])('reports %s as %s', async (stamp, status, ageSeconds, exit) => {
    const file = join(runsDir, 'supervisor/status-main-guardian.md');
    const text = `# Main guardian status (${stamp})\n`;
    writeFileSync(file, text);
    expect(await cmdFleetHealthAge(['--json'], { runsDir, now })).toBe(exit);
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0]![0])).toMatchObject({
      v: 1, readOnly: true, status, ageSeconds, maxAgeSeconds: 1800,
    });
    expect(readFileSync(file, 'utf8')).toBe(text);
  });
  it.each([false, true])('reports absent evidence (file present: %s)', async present => {
    if (present) writeFileSync(join(runsDir, 'supervisor/status-main-guardian.md'), '# No timestamp\n');
    expect(await cmdFleetHealthAge(['--json'], { runsDir, now })).toBe(1);
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0]![0])).toMatchObject({
      status: present ? 'missing timestamp' : 'missing file', statusAt: null, ageSeconds: null,
    });
  });
  it('prints plain words and rejects invalid arguments', async () => {
    expect(await cmdFleetHealthAge([], { runsDir, now })).toBe(1);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('Guardian status: missing file; age: unknown'));
    expect(await cmdFleetHealthAge(['--unknown'], { runsDir, now })).toBe(2);
    expect(await cmdFleetHealthAge(['--json', '--json'], { runsDir, now })).toBe(2);
    expect(await cmdFleetHealthAge(['--help'], { runsDir, now })).toBe(0);
  });
  it('registers the typed CLI handler', async () => {
    expect((await FLEET_SUBCOMMAND_LOADERS['health-age']!()).cmdFleetHealthAge).toBe(cmdFleetHealthAge);
  });
  it('reports an unreadable source without guessing its age', async () => {
    mkdirSync(join(runsDir, 'supervisor/status-main-guardian.md'));
    expect(await cmdFleetHealthAge(['--json'], { runsDir, now })).toBe(1);
    expect(JSON.parse(vi.mocked(console.log).mock.calls[0]![0])).toMatchObject({
      status: 'unreadable file', statusAt: null, ageSeconds: null,
    });
  });
});
