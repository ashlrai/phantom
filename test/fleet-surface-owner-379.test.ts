import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetSurfaceOwner } from '../src/cli/fleet-surface-owner.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { readFleetBoard } from '../src/core/fleet/coordination.js';
import { SURFACES, type SurfaceOwnerDeps } from '../src/core/fleet/surface-owner.js';

const ROOT = join(__dirname, '..');
const NOW = Date.parse('2026-11-13T14:00:00.000Z');
const TASK_TEXT = 'watch the slack-bridge surface for fake work';
let home: string;
let ledger: string;
let output: string[];
let errors: string[];
let deps: SurfaceOwnerDeps;

const claim = (task: string, agent: string, expiresAt = NOW + 60_000) => ({
  id: `fake-claim-${agent}`, repo: 'fake/repo', task, agent,
  claimedAt: NOW - 60_000, expiresAt, leaseHash: 'a'.repeat(64),
});
const claimEvent = (c: ReturnType<typeof claim>) => ({ version: 1, kind: 'claim' as const, at: c.claimedAt, claim: c });
const writeLedger = (events: unknown[]) =>
  writeFileSync(ledger, events.map(row => JSON.stringify(row) + '\n').join(''), { mode: 0o600 });
const gitLog: NonNullable<SurfaceOwnerDeps['log']> = async path =>
  path === 'src/core/agents/slack-transport.ts'
    ? [{ sha: 'abc1234', date: '2026-11-13T12:00:00.000Z', subject: 'bridge(RQ-PHX-FAKE1): surface work (#4242)', filesChanged: 3 }]
    : [];
const board: NonNullable<SurfaceOwnerDeps['board']> = options => readFleetBoard({ ...options, path: ledger });

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'fleet-surface-owner-'));
  vi.stubEnv('HOME', home);
  ledger = join(home, 'coordination.jsonl');
  writeLedger([claimEvent(claim(TASK_TEXT, 'fake-agent'))]);
  deps = { now: () => NOW, board, log: gitLog };
  output = [];
  errors = [];
  vi.spyOn(console, 'log').mockImplementation(value => { output.push(String(value)); });
  vi.spyOn(console, 'error').mockImplementation(value => { errors.push(String(value)); });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); rmSync(home, { recursive: true, force: true }); });

describe('fleet surface-owner', () => {
  it('is registered as a convention fleet subcommand', async () => {
    const mod = await FLEET_SUBCOMMAND_LOADERS['surface-owner']!();
    expect(mod.cmdFleetSurfaceOwner).toBe(cmdFleetSurfaceOwner);
  });

  it('names the sole live matching claimant and shows the newest landed job', async () => {
    const before = readFileSync(ledger, 'utf8');
    expect(await cmdFleetSurfaceOwner(['slack-bridge', '--json'], deps)).toBe(0);
    const report = JSON.parse(output[0]!);
    expect(report).toMatchObject({
      schemaVersion: 1, authority: 'none', surface: 'slack-bridge',
      asOf: '2026-11-13T14:00:00.000Z', owner: 'fake-agent', ownerSource: 'advisory-claim',
      liveClaims: [{ id: 'fake-claim-fake-agent', agent: 'fake-agent', expiresInSeconds: 60 }],
      lastLanded: { jobId: 'RQ-PHX-FAKE1', pr: 4242, date: '2026-11-13T12:00:00.000Z', path: 'src/core/agents/slack-transport.ts' },
      scannedPaths: SURFACES['slack-bridge'], reasons: [],
    });
    expect(output[0]).not.toContain(TASK_TEXT);
    expect(output[0]).not.toContain(home);
    expect(readFileSync(ledger, 'utf8')).toBe(before);
  });

  it('ignores claims that do not name the surface', async () => {
    writeLedger([claimEvent(claim(TASK_TEXT, 'fake-agent')), claimEvent(claim('unrelated fake work', 'other-agent'))]);
    expect(await cmdFleetSurfaceOwner(['slack-bridge', '--json'], deps)).toBe(0);
    const report = JSON.parse(output[0]!);
    expect(report.owner).toBe('fake-agent');
    expect(report.liveClaims).toHaveLength(1);
  });

  it('reports UNKNOWN with the no-live-claim reason when the only match expired, and still shows lastLanded', async () => {
    deps.board = () => ({
      schema: 'fleet.coordination.v1', state: 'known',
      claims: [{ id: 'old-claim', repo: 'fake/repo', task: TASK_TEXT, agent: 'gone-agent', claimedAt: NOW - 120_000, expiresAt: NOW - 60_000 }],
      messages: [], proposals: [], expiredClaims: 1,
    });
    expect(await cmdFleetSurfaceOwner(['slack-bridge', '--json'], deps)).toBe(0);
    const report = JSON.parse(output[0]!);
    expect(report.owner).toBe('UNKNOWN');
    expect(report.ownerSource).toBe('none');
    expect(report.liveClaims).toEqual([]);
    expect(report.reasons).toContain('no live claim names this surface; lastLanded is history, not ownership');
    expect(report.lastLanded).toMatchObject({ jobId: 'RQ-PHX-FAKE1', pr: 4242 });
  });

  it('reports UNKNOWN and lists every claim when two live claims name the surface', async () => {
    writeLedger([claimEvent(claim(TASK_TEXT, 'fake-agent')), claimEvent(claim('slack-bridge backup work', 'second-agent'))]);
    const before = readFileSync(ledger, 'utf8');
    expect(await cmdFleetSurfaceOwner(['slack-bridge', '--json'], deps)).toBe(0);
    const report = JSON.parse(output[0]!);
    expect(report.owner).toBe('UNKNOWN');
    expect(report.ownerSource).toBe('none');
    expect(report.reasons).toContain('2 live claims name this surface');
    expect(report.liveClaims).toEqual([
      { id: 'fake-claim-fake-agent', agent: 'fake-agent', expiresInSeconds: 60 },
      { id: 'fake-claim-second-agent', agent: 'second-agent', expiresInSeconds: 60 },
    ]);
    expect(output[0]).not.toContain(TASK_TEXT);
    expect(output[0]).not.toContain('slack-bridge backup work');
    expect(output[0]).not.toContain(home);
    expect(readFileSync(ledger, 'utf8')).toBe(before);
  });

  it('reports UNKNOWN with a fixed reason for an unreadable coordination ledger and exits 0', async () => {
    writeFileSync(ledger, 'unreadable ledger\n');
    expect(await cmdFleetSurfaceOwner(['slack-bridge', '--json'], deps)).toBe(0);
    const report = JSON.parse(output[0]!);
    expect(report.owner).toBe('UNKNOWN');
    expect(report.ownerSource).toBe('none');
    expect(report.liveClaims).toEqual([]);
    expect(report.reasons).toContain('coordination ledger: missing or unreadable');
    expect(report.lastLanded).toMatchObject({ jobId: 'RQ-PHX-FAKE1' });
    expect(output[0]).not.toContain(home);
  });

  it('refuses unknown surfaces and extra args with usage on stderr', async () => {
    expect(await cmdFleetSurfaceOwner(['bogus'], deps)).toBe(2);
    expect(await cmdFleetSurfaceOwner([], deps)).toBe(2);
    expect(await cmdFleetSurfaceOwner(['slack-bridge', 'extra'], deps)).toBe(2);
    expect(await cmdFleetSurfaceOwner(['slack-bridge', '--bogus'], deps)).toBe(2);
    for (const line of errors) {
      expect(line).toContain('Usage: ashlr fleet surface-owner');
      for (const surface of Object.keys(SURFACES)) expect(line).toContain(surface);
    }
    expect(output).toEqual([]);
  });

  it('prints at most five human lines without the task text or home path', async () => {
    expect(await cmdFleetSurfaceOwner(['slack-bridge'], deps)).toBe(0);
    expect(output[0]!.split('\n').length).toBeLessThanOrEqual(5);
    expect(output[0]).not.toContain(TASK_TEXT);
    expect(output[0]).not.toContain(home);
  });

  it('every SURFACES path exists in the repo so the table cannot rot silently', () => {
    for (const [surface, paths] of Object.entries(SURFACES)) {
      expect(paths.length).toBeGreaterThan(0);
      expect(paths.length).toBeLessThanOrEqual(12);
      for (const path of paths) expect(existsSync(join(ROOT, path)), `${surface}: ${path}`).toBe(true);
    }
  });
});
