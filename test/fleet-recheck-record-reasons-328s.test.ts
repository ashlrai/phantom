import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetRecheckRecord } from '../src/cli/fleet-recheck-record.js';
import { readFleetRecheck, type FleetRecheck, type FleetRecheckDeps } from '../src/core/fleet/fleet-recheck.js';
import { appendRecheckRecord, RECHECK_MISSING_MAX, RECHECK_REASON_MAX, recheckLogPath, type RecheckRecord } from '../src/core/fleet/recheck-record.js';
import type { ChannelHealth, ChannelHealthReport } from '../src/core/fleet/channel-health.js';
import type { FleetBoard } from '../src/core/fleet/coordination.js';
import type { RuntimeIdentity } from '../src/core/fleet/runtime-identity.js';
import type { WorkBoardResult } from '../src/core/comms/work-board.js';

const dirs: string[] = [];
const tempRoot = (): string => { const d = mkdtempSync(join(tmpdir(), 'rr-')); dirs.push(d); return d; };
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const NOW_MS = Date.UTC(2026, 10, 13, 12);
const ISO = new Date(NOW_MS).toISOString();
const REASON = 'task: no coordination-claim field associates a claim with board item T-328; owner match is not task identity';
const spy = () => vi.spyOn(console, 'log').mockImplementation(() => {});

// Injected readers for one real readFleetRecheck: all sections verify but task — UNKNOWN per #5497,
// no claim field binds the owner's unrelated live lease to the item.
function deps(): Required<FleetRecheckDeps> {
  const runtime: RuntimeIdentity = { host: 'fake-host', platform: 'darwin', asOf: ISO, installedVersion: '1.2.3', sourceVersion: '1.2.3', versionDrift: false, tailnetName: 'fake.ts.net', reasons: [], fleetState: { path: 's', mtime: ISO, ageSeconds: 3, stale: false } };
  const board: FleetBoard = { schema: 'fleet.coordination.v1', state: 'known', expiredClaims: 0, messages: [], proposals: [], claims: [{ id: 'lease-x9f8e7d', repo: 'fake/repo', task: 'UNRELATED-LEASE-TEXT at 192.0.2.9', agent: 'fake-agent', claimedAt: NOW_MS - 60_000, expiresAt: NOW_MS + 60_000 }] };
  const live = (channel: 'slack' | 'imessage'): ChannelHealth => ({ channel, configured: true, processAlive: true, runtimeHost: 'fake-host', lastInboundAt: null, lastReplyAt: null, unansweredCount: 0, proof: { requestCoverage: 'idle', futureDatedCount: 0 }, state: 'LIVE', missing: [], asOf: ISO });
  const health: ChannelHealthReport = { schemaVersion: 1, asOf: ISO, channels: [live('slack'), live('imessage')] };
  const work: WorkBoardResult = { inbox: 'ok', truncated: false, claims: 'available', items: [{ id: 'T-328', channel: 'bus', channelRef: null, receivedAt: ISO, state: 'RUNNING', asOf: ISO, source: 'work-board', missing: [], owner: 'fake-agent', claimReceipt: 'bus-claim:req-1:7:rcpt' }] };
  return { now: () => new Date(NOW_MS), homeDir: () => '/Users/fakehome', readRuntimeIdentity: () => runtime, readChannelHealth: () => health, readFleetBoard: () => board, listWorkBoard: () => work, listCoordination: () => ({ source: 'unavailable' as const, claims: [] }), listLiveWorkers: () => { throw new Error('absent'); } };
}

const MISSING = ['slack: bridge down', 'imessage: bridge stale'];
function fake(asOf: string): FleetRecheck {
  return { schema: 'fleet.recheck.v1', asOf, overall: { state: 'BLOCKED', missing: [...MISSING] }, sections: {
    runtime: { state: 'VERIFIED', source: 'runtime-identity', asOf, host: 'fake-host', tailnetName: 't', installedVersion: '1.2.3', sourceVersion: '1.2.3', fleetState: { ageSeconds: 3, stale: false }, missing: [] },
    claims: { state: 'VERIFIED', source: 'coordination', asOf, active: 0, expiredClaims: 0, top: [], missing: [] },
    bridge: { state: 'BLOCKED', source: 'channel-health', asOf, channels: [], missingBridge: 'slack: bridge down', missing: [...MISSING] },
    task: { state: 'VERIFIED', source: 'work-board', asOf, task: null, unowned: 0, unclaimed: 0, missing: [] } } };
}
const LEGACY = JSON.stringify({ schema: 'fleet.recheck-record.v1', asOf: '2026-11-12T00:00:00.000Z', overall: 'BLOCKED', sections: {
  runtime: { state: 'VERIFIED', host: 'fake-host', installedVersion: '1.2.3', asOf: '2026-11-12T00:00:00.000Z' },
  claims: { state: 'VERIFIED', active: 1, asOf: '2026-11-12T00:00:00.000Z' },
  bridge: { state: 'BLOCKED', missingBridge: 'slack: bridge down', asOf: '2026-11-12T00:00:00.000Z' },
  task: { state: 'VERIFIED', id: 'T-1', owner: 'fake-agent', claimReceipt: 'rcpt-1', asOf: '2026-11-12T00:00:00.000Z' } } });

describe('fleet recheck-record missing reasons', () => {
  it('keeps the exact task association limitation end to end without lease leakage', async () => {
    const root = tempRoot();
    const log = spy();
    const readRecheck = vi.fn(() => readFleetRecheck(deps()));
    expect(await cmdFleetRecheckRecord([], { root, homeDir: () => '/Users/fakehome', readRecheck })).toBe(0);
    expect(log).toHaveBeenLastCalledWith(`recorded UNKNOWN as-of=${ISO}`);
    const line = readFileSync(recheckLogPath(root), 'utf8'); // raw lease material never reaches the row
    for (const raw of ['UNRELATED-LEASE-TEXT', 'lease-x9f8e7d']) expect(line).not.toContain(raw);
    log.mockClear();
    expect(await cmdFleetRecheckRecord(['--last', '1', '--json'], { root })).toBe(0);
    const row = (JSON.parse(log.mock.lastCall![0] as string) as RecheckRecord[])[0]!;
    expect(row.overall).toBe('UNKNOWN');
    expect(row.sections.missing!.task).toEqual([REASON]);
    expect(row.sections.missing!.overall).toEqual([REASON]);
    log.mockClear();
    expect(await cmdFleetRecheckRecord(['--last', '1'], { root })).toBe(0);
    expect(log.mock.lastCall![0]).toBe(`${ISO} UNKNOWN runtime=VERIFIED claims=VERIFIED bridge=VERIFIED task=UNKNOWN missing=${REASON}`);
  });

  it('keeps BLOCKED bridge reasons; plain shows the first not already named', async () => {
    const root = tempRoot();
    const log = spy();
    expect(await cmdFleetRecheckRecord([], { root, readRecheck: () => fake(ISO) })).toBe(0);
    log.mockClear();
    expect(await cmdFleetRecheckRecord(['--last', '1', '--json'], { root })).toBe(0);
    const m = (JSON.parse(log.mock.lastCall![0] as string) as RecheckRecord[])[0]!.sections.missing!;
    expect(m.bridge).toEqual(MISSING);
    expect(m.overall).toEqual(MISSING);
    log.mockClear();
    expect(await cmdFleetRecheckRecord(['--last', '1'], { root })).toBe(0);
    expect(log.mock.lastCall![0]).toBe(`${ISO} BLOCKED runtime=VERIFIED claims=VERIFIED bridge=BLOCKED task=VERIFIED missing=imessage: bridge stale`);
  });

  it('reads pre-reason rows with missing null and prints missing=unrecorded', async () => {
    const root = tempRoot();
    mkdirSync(join(root, 'fleet'), { recursive: true });
    appendFileSync(recheckLogPath(root), `${LEGACY}\n`);
    expect(appendRecheckRecord(root, fake(ISO), '/nohome').ok).toBe(true);
    const log = spy();
    expect(await cmdFleetRecheckRecord(['--last', '2', '--json'], { root })).toBe(0);
    const rows = JSON.parse(log.mock.lastCall![0] as string) as RecheckRecord[];
    expect(rows[0]!.sections.missing).not.toBeNull();
    expect(rows[1]!.sections.missing).toBeNull();
    log.mockClear();
    expect(await cmdFleetRecheckRecord(['--last', '2'], { root })).toBe(0);
    expect(log.mock.calls.map(c => c[0])).toEqual([
      `${ISO} BLOCKED runtime=VERIFIED claims=VERIFIED bridge=BLOCKED task=VERIFIED missing=imessage: bridge stale`,
      '2026-11-12T00:00:00.000Z BLOCKED runtime=VERIFIED claims=VERIFIED bridge=BLOCKED task=VERIFIED missing=unrecorded' ]);
  });

  it('bounds oversized reason lists and drops non-string entries', () => {
    const root = tempRoot();
    const verdict = fake(ISO);
    verdict.overall.missing = ['x'.repeat(RECHECK_REASON_MAX + 100), ...Array.from({ length: 20 }, (_, i) => `r${i}`), { bad: 1 } as unknown as string, ''];
    verdict.sections.task.missing = ['only-task-reason'];
    const res = appendRecheckRecord(root, verdict, '/nohome');
    if (!res.ok) throw new Error('append failed');
    const m = res.record.sections.missing!;
    expect(m.overall).toHaveLength(RECHECK_MISSING_MAX);
    expect(m.overall[0]).toHaveLength(RECHECK_REASON_MAX);
    expect(m.task).toEqual(['only-task-reason']);
    expect((JSON.parse(readFileSync(recheckLogPath(root), 'utf8')) as RecheckRecord).sections.missing!.overall).toHaveLength(RECHECK_MISSING_MAX);
  });

  it('sanitizes home paths and IPs inside recorded reasons', () => {
    const root = tempRoot();
    const verdict = fake(ISO);
    verdict.overall.missing = ['receipt under /Users/fakehome/fleet from 10.0.0.5 via fd00:1111:2222:3333:4444:5555:6666:7777'];
    verdict.sections.bridge.missing = verdict.overall.missing;
    expect(appendRecheckRecord(root, verdict, '/Users/fakehome').ok).toBe(true);
    const line = readFileSync(recheckLogPath(root), 'utf8');
    for (const raw of ['/Users/fakehome', '10.0.0.5', 'fd00:1111']) expect(line).not.toContain(raw);
    expect((JSON.parse(line) as RecheckRecord).sections.missing!.bridge[0]).toBe('receipt under ~/fleet from [ip] via [ip]');
  });

  it('append and --last touch only the log file and never a live reader', async () => {
    const root = tempRoot();
    spy();
    const readRecheck = vi.fn(() => fake(ISO));
    expect(await cmdFleetRecheckRecord([], { root, readRecheck })).toBe(0);
    expect(await cmdFleetRecheckRecord(['--last', '5'], { root, readRecheck })).toBe(0);
    expect(readRecheck).toHaveBeenCalledTimes(1); // --last invokes no reader; record used only the injected one
    expect([readdirSync(root), readdirSync(join(root, 'fleet'))]).toEqual([['fleet'], ['recheck-log.jsonl']]);
  });
});
