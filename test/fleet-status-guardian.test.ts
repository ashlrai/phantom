import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cmdFleet, formatFleetStatus } from '../src/cli/fleet.js';
import { readGuardianStatus } from '../src/core/fleet/guardian-doctor.js';
import { readGuardianServiceHealth } from '../src/core/fleet/health-age.js';
import { fleetStatusApi } from '../src/core/fleet/status-api.js';
import { buildFleetStatus, type FleetStatus } from '../src/core/fleet/status.js';
import { loadConfig } from '../src/core/config.js';

vi.mock('../src/core/config.js', () => ({ loadConfig: () => ({
  version: 1, roots: [], models: { providerChain: [] }, tools: {},
}) }));
vi.mock('../src/core/fleet/health-age.js', async original => ({
  ...await original<typeof import('../src/core/fleet/health-age.js')>(), readGuardianServiceHealth: vi.fn(),
}));
let root: string;
const now = () => new Date(2026, 10, 3, 12).getTime();
const snapshot: FleetStatus = {
  generatedAt: '2026-11-03T12:00:00Z', daemon: { running: false, lastTickAt: null, todaySpentUsd: 0 },
  backends: [], queue: { backlogItems: 0 }, proposals: { pending: 0, frontierPending: 0, applied: 0 },
  merges: { recent: 0 }, killed: false,
};
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'status-guardian-'));
  for (const dir of ['supervisor', 'guardian', 'queue']) mkdirSync(join(root, dir));
  vi.stubEnv('ASHLR_RUNS_DIR', root);
  vi.mocked(readGuardianServiceHealth).mockResolvedValue({ state: 'loaded', lastExitCode: 0, diagnostic: 'Loaded.' });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });

it.each([
  ['fresh', '11:59:00', 'normal', 'loaded', 0, 'ok'],
  ['fresh', '11:30:00', 'normal', 'loaded', 0, 'ok'],
  ['stale', '11:29:59', 'normal', 'loaded', 0, 'red'],
  ['future timestamp', '12:01:00', 'normal', 'loaded', 0, 'warn'],
  ['malformed timestamp', 'bad', 'normal', 'loaded', 0, 'warn'],
  ['missing timestamp', '', 'normal', 'loaded', 0, 'warn'],
  ['missing file', null, 'normal', 'loaded', 0, 'warn'],
  ['fresh', '11:59:00', null, 'loaded', 0, 'warn'],
  ['fresh', '11:59:00', 'ERROR private-detail', 'loaded', 0, 'red'],
  ['fresh', '11:59:00', 'ModuleNotFoundError: private-detail', 'loaded', 0, 'red'],
  ['fresh', '11:59:00', 'Traceback (most recent call last):', 'loaded', 0, 'red'],
  ['fresh', '11:59:00', 'normal', 'not-loaded', null, 'red'],
  ['fresh', '11:59:00', 'normal', 'loaded', -9, 'red'],
  ['fresh', '11:59:00', 'normal', 'loaded', null, 'warn'],
  ['fresh', '11:59:00', 'normal', 'unknown', null, 'warn'],
] as const)('reports %s with %s, %s and launch %s/%s', async (status, stamp, log, state, lastExitCode, level) => {
  const statusPath = join(root, 'supervisor/status-main-guardian.md'), logPath = join(root, 'guardian/guardian.log');
  const text = stamp ? `# Main guardian status (2026-11-03 ${stamp})\n` : '# Missing heading\n';
  if (stamp !== null) writeFileSync(statusPath, text);
  if (log !== null) writeFileSync(logPath, `2026-11-03 11:59:00 ${log}\n`);
  writeFileSync(join(root, 'queue/ready.tsv'), 'existing guardian job\n');
  const before = readdirSync(root, { recursive: true });
  vi.mocked(readGuardianServiceHealth).mockResolvedValue({ state, lastExitCode, diagnostic: 'Check user session.' });
  const guardian = await readGuardianStatus({ now });
  expect(guardian).toMatchObject({ readOnly: true, level, age: { status }, service: { state, lastExitCode } });
  const output = formatFleetStatus({ ...snapshot, guardian });
  expect(output).toContain(`Guardian: ${status}; age:`);
  expect(output).toContain(`Launch service: ${state}; last exit code: ${lastExitCode ?? 'unknown'}`);
  expect(output).toContain(`Next: ${guardian.nextStep}`);
  expect(output + JSON.stringify(guardian)).not.toContain('private-detail');
  expect(readdirSync(root, { recursive: true })).toEqual(before);
  expect(readFileSync(join(root, 'queue/ready.tsv'), 'utf8')).toBe('existing guardian job\n');
  if (stamp !== null) expect(readFileSync(statusPath, 'utf8')).toBe(text);
  if (log !== null) expect(readFileSync(logPath, 'utf8')).toBe(`2026-11-03 11:59:00 ${log}\n`);
});

it('keeps unreadable evidence unknown and supports legacy snapshots', async () => {
  mkdirSync(join(root, 'supervisor/status-main-guardian.md'));
  mkdirSync(join(root, 'guardian/guardian.log'));
  expect(await readGuardianStatus({ now })).toMatchObject({ level: 'warn',
    age: { status: 'unreadable file', ageSeconds: null }, log: { source: 'degraded', recentErrors: null } });
  expect(formatFleetStatus(snapshot)).toContain('Guardian: unavailable. Next: phm fleet health-age --diagnose --json');
});

it('exposes guardian evidence through fleet status text, JSON and the status API', async () => {
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await cmdFleet(['status', '--json'])).toBe(0);
  const report = JSON.parse(stdout.mock.lastCall![0] as string);
  expect(report.guardian).toMatchObject({ readOnly: true, age: { status: 'missing file' }, service: { state: 'loaded', lastExitCode: 0 } });
  expect((await buildFleetStatus(loadConfig())).guardian).toEqual(report.guardian);
  expect(await cmdFleet(['status'])).toBe(0);
  expect(log.mock.calls.flat().join('\n')).toContain('Guardian: missing file; age: unknown');
  expect((await fleetStatusApi(root, now)).guardian).toEqual(report.guardian);
});
