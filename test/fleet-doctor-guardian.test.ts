import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleet } from '../src/cli/fleet.js';
import { cmdFleetDoctor } from '../src/cli/fleet-doctor.js';
import { readGuardianServiceHealth } from '../src/core/fleet/health-age.js';
import { readGuardianDoctorCheck } from '../src/core/fleet/guardian-doctor.js';

vi.mock('../src/core/config.js', () => ({ loadConfig: () => ({}) }));
vi.mock('../src/core/fleet/engine-readiness.js', () => ({ fleetReadiness: () => [] }));
vi.mock('../src/core/fleet/health-age.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/core/fleet/health-age.js')>(), readGuardianServiceHealth: vi.fn(),
}));
let root: string;
const now = new Date(2026, 10, 3, 12).getTime();
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'doctor-guardian-'));
  for (const dir of ['supervisor', 'guardian']) mkdirSync(join(root, dir));
  vi.stubEnv('ASHLR_RUNS_DIR', root);
  vi.spyOn(Date, 'now').mockReturnValue(now);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

it.each([
  ['healthy', '11:59:00', 'loaded', 0, '2026-11-03 11:00:00 normal', 'ok', 'No action needed.'],
  ['30 minute boundary', '11:30:00', 'loaded', 0, '', 'ok', 'No action needed.'],
  ['stale', '11:29:59', 'loaded', 0, '', 'red', 'Confirm the guardian service'],
  ['unloaded', '11:59:00', 'not-loaded', null, '', 'red', 'Reinstall or bootstrap'],
  ['unloaded and stale', '11:00:00', 'not-loaded', null, '', 'red', 'Reinstall or bootstrap'],
  ['recent errors', '11:59:00', 'loaded', 0, '2026-11-03 11:00:00 ERROR private-detail', 'red', 'Open guardian/guardian.log'],
  ['old errors', '11:59:00', 'loaded', 0, '2026-11-01 11:00:00 ERROR private-detail', 'ok', 'No action needed.'],
  ['unknown service', '11:59:00', 'unknown', null, '', 'warn', 'Check user session.'],
  ['failed exit', '11:59:00', 'loaded', -9, '', 'red', 'Read the tail'],
  ['undated errors', '11:59:00', 'loaded', 0, 'ERROR private-detail', 'warn', 'Inspect those lines'],
  ['missing status', null, 'loaded', 0, '', 'warn', 'Confirm the guardian service'],
] as const)('reports %s through the typed API and both CLI paths', async (_state, stamp, state, lastExitCode, log, level, next) => {
  const statusPath = join(root, 'supervisor/status-main-guardian.md'), logPath = join(root, 'guardian/guardian.log');
  const status = `# Main guardian status (2026-11-03 ${stamp})\n`;
  if (stamp) writeFileSync(statusPath, status);
  writeFileSync(logPath, log);
  vi.mocked(readGuardianServiceHealth).mockResolvedValue({ state, lastExitCode, diagnostic: 'Check user session.' });
  const check = await readGuardianDoctorCheck();
  expect(check).toMatchObject({ name: 'guardian', level, nextStep: expect.stringContaining(next) });
  if (_state === 'stale') expect(check.reason).toContain('Status is stale.');
  if (_state === 'recent errors') expect(check.reason).toContain('1 error lines in the last 24 hours.');
  const exit = level === 'red' ? 1 : 0;
  expect(await cmdFleet(['doctor', '--json'])).toBe(exit);
  expect(JSON.parse(vi.mocked(process.stdout.write).mock.lastCall![0] as string)).toContainEqual(check);
  expect(await cmdFleet(['doctor'])).toBe(exit);
  expect(console.log).toHaveBeenCalledWith(`${level} guardian: ${check.reason} Next: ${check.nextStep}`);
  const opts = { now: () => now, readJobs: async () => '', leader: { readEvents: async () => '' },
    heartbeat: { queueStatus: async () => JSON.stringify({ last_tick: new Date(now).toISOString() }), supervisorStatuses: async () => [] },
    readLaneStatus: async () => '{"lanes":{}}', readKeptStatus: async () => '{"kept_worktrees":[]}',
    worktreeFs: { listDirs: async () => [], mtimeMs: async () => null } };
  expect(await cmdFleetDoctor(['--json'], opts)).toBe(exit);
  expect(JSON.parse(vi.mocked(console.log).mock.lastCall![0]).checks).toContainEqual(check);
  expect(await cmdFleetDoctor([], opts)).toBe(exit);
  expect(console.log).toHaveBeenCalledWith(`${level} guardian: ${check.reason} Next: ${check.nextStep}`);
  expect(JSON.stringify(check)).not.toContain('private-detail');
  expect(readFileSync(logPath, 'utf8')).toBe(log);
  if (stamp) expect(readFileSync(statusPath, 'utf8')).toBe(status);
});
