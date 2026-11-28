import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleetHealthAge } from '../src/cli/fleet-health-age.js';
import { readGuardianLogHealth, readGuardianServiceHealth } from '../src/core/fleet/health-age.js';
import { readGuardianStatus } from '../src/core/fleet/guardian-doctor.js';

vi.mock('../src/core/fleet/health-age.js', async original => ({
  ...await original<typeof import('../src/core/fleet/health-age.js')>(), readGuardianServiceHealth: vi.fn(),
}));
let runsDir: string;
const now = () => new Date(2026, 10, 3, 12).getTime();
const service = () => Promise.resolve({ state: 'loaded' as const, lastExitCode: 0, diagnostic: 'OK' });
beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), 'guardian-crash-'));
  for (const dir of ['guardian', 'supervisor', 'queue']) mkdirSync(join(runsDir, dir));
  writeFileSync(join(runsDir, 'supervisor/status-main-guardian.md'), '# Main guardian status (2026-11-03 11:59:00)\n');
  writeFileSync(join(runsDir, 'queue/ready.tsv'), 'fake existing job\n');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.stubEnv('ASHLR_RUNS_DIR', runsDir);
  vi.mocked(readGuardianServiceHealth).mockImplementation(service);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(runsDir, { recursive: true, force: true }); });

it.each([
  ['Traceback (most recent call last):', 0, 1],
  ['ModuleNotFoundError: fake-detail', 0, 1],
  ['  subprocess.TimeoutExpired: fake-detail', 0, 1],
  ['2026-11-03 11:59:00 PermissionError: fake-detail', 1, 0],
  ['[2026-11-03 11:59:00] RuntimeError: fake-detail', 1, 0],
  ['2026-11-01 11:59:00 ImportError: fake-detail', 0, 0],
  ['2026-11-03 12:01:00 ValueError: fake-detail', 0, 1],
  ['2026-11-03 11:59:00 ModuleNotFoundError handler installed', 0, 0],
  ['2026-11-03 11:59:00 Traceback reporting enabled', 0, 0],
  ['2026-11-03 11:59:00 ERROR fake-detail', 1, 0],
  ['2026-11-03 11:59:00 normal\nModuleNotFoundError: fake-detail', 0, 1],
  ['2026-11-03 11:59:00 subprocess.TimeoutExpired: fake-detail', 1, 0],
  ['2026-11-03 11:59:00 Traceback (most recent call last):', 1, 0],
])('diagnoses isolated crash evidence %#', async (line, recentErrors, unparseableErrors) => {
  const log = join(runsDir, 'guardian/guardian.log');
  const fixture = `${line}\n`;
  writeFileSync(log, fixture);
  const expected = { source: 'healthy', windowSeconds: 86400, recentErrors, unparseableErrors };
  expect(await readGuardianLogHealth({ runsDir, now })).toEqual(expected);
  const healthy = recentErrors + unparseableErrors === 0;
  expect(await cmdFleetHealthAge(['--diagnose', '--json'], { runsDir, now, service })).toBe(healthy ? 0 : 1);
  const output = vi.mocked(console.log).mock.lastCall![0] as string;
  expect(JSON.parse(output)).toMatchObject({ log: expected, diagnosis: { healthy } });
  expect(output).not.toContain('fake-detail');
  expect(output).not.toContain(line);
  expect(readFileSync(log, 'utf8')).toBe(fixture);
  expect(readFileSync(join(runsDir, 'queue/ready.tsv'), 'utf8')).toBe('fake existing job\n');
});

it.each(['ModuleNotFoundError: fake-detail', 'Traceback (most recent call last):'])('marks fleet status red for %s', async line => {
  writeFileSync(join(runsDir, 'guardian/guardian.log'), `2026-11-03 11:59:00 ${line}\n`);
  const guardian = await readGuardianStatus({ now });
  expect(guardian.level).toBe('red');
  expect(JSON.stringify(guardian)).not.toContain(line);
});
