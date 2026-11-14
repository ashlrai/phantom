import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetRecheckRecord } from '../src/cli/fleet-recheck-record.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import type { FleetRecheck } from '../src/core/fleet/fleet-recheck.js';
import { recheckLogPath } from '../src/core/fleet/recheck-record.js';

const dirs: string[] = [];
function tempRoot(): string { const d = mkdtempSync(join(tmpdir(), 'recheck-record-')); dirs.push(d); return d; }
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function fake(asOf: string): FleetRecheck {
  return {
    schema: 'fleet.recheck.v1', asOf,
    sections: {
      runtime: { state: 'VERIFIED', source: 'runtime-identity', asOf, host: 'fake-host', tailnetName: 'fake.ts.net', installedVersion: '1.2.3', sourceVersion: '1.2.3', fleetState: { ageSeconds: 3, stale: false }, missing: [] },
      claims: { state: 'VERIFIED', source: 'coordination', asOf, active: 2, expiredClaims: 0, top: [{ agent: 'fake-agent', repo: 'fake/repo', task: 'SECRET-TASK-TEXT at /Users/fake/x', expiresAt: asOf }], missing: [] },
      bridge: { state: 'BLOCKED', source: 'channel-health', asOf, channels: [], missingBridge: 'slack: bridge down', missing: ['slack: bridge down'] },
      task: { state: 'VERIFIED', source: 'work-board', asOf, task: { id: 'T-1', state: 'RUNNING', owner: 'fake-agent', claimReceipt: 'rcpt-1', ledgerClaim: null, asOf, source: 'work-board' }, unowned: 0, unclaimed: 0, missing: [] },
    },
    overall: { state: 'BLOCKED', missing: ['slack: bridge down'] },
  };
}
const iso = (n: number) => new Date(Date.UTC(2026, 10, 13, 0, 0, n)).toISOString();

describe('fleet recheck-record', () => {
  it('appends one projected 0600 line', async () => {
    const root = tempRoot();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetRecheckRecord([], { root, homeDir: () => '/Users/fake', readRecheck: () => fake(iso(1)) })).toBe(0);
    expect(log).toHaveBeenLastCalledWith(`recorded BLOCKED as-of=${iso(1)}`);
    const file = recheckLogPath(root);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(root, 'fleet')).mode & 0o777).toBe(0o700);
    const text = readFileSync(file, 'utf8');
    expect(text.split('\n').filter(Boolean)).toHaveLength(1);
    expect(text).not.toContain('SECRET-TASK-TEXT');
    expect(text).not.toContain('/Users/');
    const row = JSON.parse(text);
    expect(Object.keys(row).sort()).toEqual(['asOf', 'overall', 'schema', 'sections']);
    expect(row.sections.task).toEqual({ state: 'VERIFIED', id: 'T-1', owner: 'fake-agent', claimReceipt: 'rcpt-1', asOf: iso(1) });
    expect(row.sections.claims).toEqual({ state: 'VERIFIED', active: 2, asOf: iso(1) });
  });

  it('trims to the newest 500 on the 501st record', async () => {
    const root = tempRoot();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    for (let i = 0; i < 501; i++) {
      expect(await cmdFleetRecheckRecord([], { root, readRecheck: () => fake(iso(i)) })).toBe(0);
    }
    const lines = readFileSync(recheckLogPath(root), 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(500);
    expect(JSON.parse(lines[0]!).asOf).toBe(iso(1));
    expect(JSON.parse(lines[499]!).asOf).toBe(iso(500));
    expect(statSync(recheckLogPath(root)).mode & 0o777).toBe(0o600);
  });

  it('--last prints newest first and counts malformed lines', async () => {
    const root = tempRoot();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetRecheckRecord(['--last', '2'], { root })).toBe(0);
    expect(log).toHaveBeenLastCalledWith('no recheck records');
    for (let i = 0; i < 3; i++) await cmdFleetRecheckRecord([], { root, readRecheck: () => fake(iso(i)) });
    appendFileSync(recheckLogPath(root), 'not json\n');
    log.mockClear();
    expect(await cmdFleetRecheckRecord(['--last', '2'], { root })).toBe(0);
    expect(log.mock.calls.map(c => c[0])).toEqual([
      `${iso(2)} BLOCKED runtime=VERIFIED claims=VERIFIED bridge=BLOCKED task=VERIFIED`,
      `${iso(1)} BLOCKED runtime=VERIFIED claims=VERIFIED bridge=BLOCKED task=VERIFIED`,
      'skipped=1',
    ]);
    log.mockClear();
    expect(await cmdFleetRecheckRecord(['--last', '1', '--json'], { root })).toBe(0);
    const rows = JSON.parse(log.mock.lastCall![0] as string);
    expect(rows).toHaveLength(1);
    expect(rows[0].asOf).toBe(iso(2));
  });

  it('exits 1 without a path when the root is a file', async () => {
    const root = tempRoot();
    const blocker = join(root, 'file');
    writeFileSync(blocker, 'x');
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdFleetRecheckRecord([], { root: blocker, readRecheck: () => fake(iso(0)) })).toBe(1);
    const msg = err.mock.lastCall![0] as string;
    expect(msg).toMatch(/^record failed: /);
    expect(msg).not.toContain(root);
    expect(msg).not.toContain('/');
  });

  it('handles help and bad arguments', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetRecheckRecord(['--help'])).toBe(0);
    expect(log.mock.lastCall![0]).toContain('Usage:');
    for (const a of [['--bad'], ['--last', '0'], ['--last', '51'], ['--last'], ['--json']]) {
      expect(await cmdFleetRecheckRecord(a)).toBe(2);
    }
    expect(err).toHaveBeenCalled();
  });

  it('is registered', async () => {
    const mod = await FLEET_SUBCOMMAND_LOADERS['recheck-record']!();
    expect(mod.cmdFleetRecheckRecord).toBe(cmdFleetRecheckRecord);
  });
});
