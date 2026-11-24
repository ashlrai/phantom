import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetRuntime, type FleetRuntimeDeps } from '../src/cli/fleet-runtime.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { readFleetBoard } from '../src/core/fleet/coordination.js';
import { readClaimExecution } from '../src/core/fleet/claim-execution-evidence.js';

const NOW = Date.parse('2026-11-13T14:00:00.000Z');
let home: string;
let root: string;
let ledger: string;
let output: string[];
let deps: FleetRuntimeDeps;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'fleet-runtime-'));
  vi.stubEnv('HOME', home);
  root = join(home, '.ashlr-runs');
  ledger = join(home, 'coordination.jsonl');
  mkdirSync(join(root, 'queue'), { recursive: true });
  for (const [name, age] of [['older.json', 120], ['queue/status.json', 30]] as const) {
    const file = join(root, name);
    writeFileSync(file, '{}');
    utimesSync(file, (NOW - age * 1000) / 1000, (NOW - age * 1000) / 1000);
  }
  const claim = { id: 'fake-claim', repo: 'fake/repo', task: 'fake task', agent: 'fake-agent',
    claimedAt: NOW - 60_000, expiresAt: NOW + 60_000, leaseHash: 'a'.repeat(64) };
  const message = { id: 'return-fake-return', from: 'fake-agent', to: 'leader', at: NOW - 45_000, expiresAt: NOW + 60_000,
    body: 'RESULT VERIFIED fake/repo claim fake-return task "fake task": tests passed' };
  writeFileSync(ledger, [
    { version: 1, kind: 'claim', at: claim.claimedAt, claim },
    { version: 1, kind: 'post', at: message.at, message },
  ].map(row => JSON.stringify(row) + '\n').join(''), { mode: 0o600 });
  deps = {
    now: () => NOW, home: () => home, stateRoot: () => root,
    host: () => 'fake-host', platform: () => 'fakeos', arch: () => 'fakearch',
    pid: () => 123, uptime: () => 120.5, installedVersion: () => '1.2.3', sourceVersion: () => '1.2.4',
    tailnet: () => 'fake-tailnet', board: options => readFleetBoard({ ...options, path: ledger }),
    execution: () => readClaimExecution({
      now: () => NOW,
      workers: async () => ({
        v: 1, generatedAt: new Date(NOW).toISOString(), sourceState: 'healthy',
        workers: [], leaders: [], orchestratorAgents: 0,
      }),
    }),
  };
  output = [];
  vi.spyOn(console, 'log').mockImplementation(value => { output.push(String(value)); });
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

describe('fleet runtime', () => {
  it('dispatches and prints a sanitized fixed-clock snapshot without changing files', async () => {
    const before = readFileSync(ledger, 'utf8');
    const files = readdirSync(home, { recursive: true });
    const mod = await FLEET_SUBCOMMAND_LOADERS.runtime!();
    expect(mod.cmdFleetRuntime).toBe(cmdFleetRuntime);
    expect(await cmdFleetRuntime(['--json'], deps)).toBe(0);
    expect(JSON.parse(output[0])).toEqual({
      host: 'fake-host', tailnetName: 'fake-tailnet', installedVersion: '1.2.3', sourceVersion: '1.2.4',
      pid: 123, uptimeSeconds: 120.5, platform: 'fakeos', arch: 'fakearch', stateRoot: '~/.ashlr-runs',
      lastFleetStateRead: { mtime: '2026-11-13T13:59:30.000Z', ageSeconds: 30 },
      coordination: { state: 'known', activeClaims: 1, newestReturnAgeSeconds: 45 },
      execution: { state: 'UNKNOWN', running: 0, claimedNoWorker: 0, unknown: 0,
        reason: 'execution: ledger unavailable' },
      asOf: '2026-11-13T14:00:00.000Z', reasons: [],
    });
    expect(output[0]).not.toContain(home);
    expect(output[0]).not.toContain('fake task');
    expect(readFileSync(ledger, 'utf8')).toBe(before);
    expect(readdirSync(home, { recursive: true })).toEqual(files);
  });

  it('reports UNKNOWN with a fixed reason for an unreadable coordination store', async () => {
    writeFileSync(ledger, 'unreadable ledger\n');
    await cmdFleetRuntime(['--json'], deps);
    expect(JSON.parse(output[0]).coordination).toEqual({ state: 'UNKNOWN', activeClaims: 'UNKNOWN',
      newestReturnAgeSeconds: 'UNKNOWN', reason: 'coordination ledger: missing or unreadable' });
    expect(output[0]).not.toContain(home);
  });

  it('prints six human lines and omits the source version when equal', async () => {
    deps.sourceVersion = () => '1.2.3';
    await cmdFleetRuntime([], deps);
    expect(output[0].split('\n')).toHaveLength(6);
    expect(output[0]).not.toContain(home);
    output = [];
    await cmdFleetRuntime(['--json'], deps);
    expect(JSON.parse(output[0])).not.toHaveProperty('sourceVersion');
  });

  it('withholds outside-home paths and reports missing state without creating it', async () => {
    const absent = join(home, 'missing');
    deps.home = () => join(home, 'other-home');
    deps.stateRoot = () => absent;
    deps.host = () => 'fake@example.invalid';
    await cmdFleetRuntime(['--json'], deps);
    const report = JSON.parse(output[0]);
    expect(report.stateRoot).toBe('[path outside home]');
    expect(report.lastFleetStateRead).toEqual({ mtime: 'UNKNOWN', ageSeconds: 'UNKNOWN' });
    expect(output[0]).not.toContain(home);
    expect(output[0]).not.toContain('@');
    expect(readdirSync(home)).not.toContain('missing');
  });
});
