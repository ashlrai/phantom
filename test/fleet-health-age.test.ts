import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetHealthAge } from '../src/cli/fleet-health-age.js';
import { readGuardianServiceHealth } from '../src/core/fleet/health-age.js';
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
  it.each([
    [true, 'last exit code = 0', 'loaded', 0],
    [true, 'last exit code = 42', 'loaded', 42],
    [true, 'last exit code = -9', 'loaded', -9],
    [true, 'last exit code = 999999999999999999999999', 'loaded', null],
    [true, 'no exit recorded', 'loaded', null],
    [false, 'Could not find service', 'not-loaded', null],
    [false, 'permission denied', 'unknown', null],
  ])('classifies launchd evidence without exposing it', async (ok, output, state, code) => {
    const probe = vi.fn().mockResolvedValue({ ok, output });
    const service = await readGuardianServiceHealth({ platform: 'darwin', uid: 123, probe });
    expect(probe).toHaveBeenCalledWith('gui/123/ai.ashlr.main-guardian');
    expect(service).toMatchObject({ state, lastExitCode: code });
    expect(JSON.stringify(service)).not.toContain(output);
  });
  it('combines fresh status and service evidence into a health verdict', async () => {
    writeFileSync(join(runsDir, 'supervisor/status-main-guardian.md'), '# Main guardian status (2026-11-03 11:59:00)\n');
    for (const [state, lastExitCode, exit] of [['loaded', 0, 0], ['loaded', 1, 1], ['loaded', null, 1], ['not-loaded', null, 1], ['unknown', null, 1]] as const) {
      const service = vi.fn().mockResolvedValue({ state, lastExitCode, diagnostic: 'Check service.' });
      expect(await cmdFleetHealthAge(['--service', '--json'], { runsDir, now, service })).toBe(exit);
      expect(JSON.parse(vi.mocked(console.log).mock.lastCall![0])).toMatchObject({ status: 'fresh', service: { state, lastExitCode } });
    }
    const service = vi.fn().mockResolvedValue({ state: 'loaded', lastExitCode: 0, diagnostic: 'OK' });
    expect(await cmdFleetHealthAge(['--service'], { runsDir, now: () => now() + 3600_000, service })).toBe(1);
  });
  it('reports unsupported systems and failed probes as unknown', async () => {
    expect((await readGuardianServiceHealth({ platform: 'linux' })).state).toBe('unknown');
    expect((await readGuardianServiceHealth({ platform: 'darwin', uid: 1, probe: async () => { throw new Error('private'); } })).state).toBe('unknown');
  });
  it('reports a signal exit as unhealthy without creating repair jobs', async () => {
    writeFileSync(join(runsDir, 'supervisor/status-main-guardian.md'), '# Main guardian status (2026-11-03 11:59:00)\n');
    const service = () => readGuardianServiceHealth({ platform: 'darwin', uid: 123,
      probe: async () => ({ ok: true, output: 'last exit code = -9' }) });
    expect(await cmdFleetHealthAge(['--service', '--json'], { runsDir, now, service })).toBe(1);
    expect(JSON.parse(vi.mocked(console.log).mock.lastCall![0])).toMatchObject({ service: { lastExitCode: -9, diagnostic: expect.stringContaining('error') } });
    expect(() => readFileSync(join(runsDir, 'queue', 'ready.tsv'))).toThrow();
  });
});
