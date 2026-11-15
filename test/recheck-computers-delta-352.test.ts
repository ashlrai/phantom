/** RQ-PHX-RECHECKCOMPUTERSDELTA352 — the retained recheck row keeps bounded
 * tailnet computer evidence (counts over every peer seen, up to
 * RECHECK_TAILNET_PEERS_MAX {name, online} peers; never addresses, OS,
 * lastSeen, self or reasons) so computersDelta can name which fleet
 * computers went offline or came back online between two rows. Pre-352 rows
 * read back with tailnet null; a wrong-typed tailnet counts skipped, never
 * thrown. Every root is a fresh temp dir; all names are fake. */
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetRecheckRecord } from '../src/cli/fleet-recheck-record.js';
import type { FleetRecheck, FleetRecheckTailnet } from '../src/core/fleet/fleet-recheck.js';
import { computersDelta } from '../src/core/fleet/recheck-computers-delta.js';
import {
  appendRecheckRecord, projectRecheck, readRecheckRecords, recheckLogPath,
  RECHECK_REASON_MAX, RECHECK_RECORD_SCHEMA, RECHECK_TAILNET_PEERS_MAX,
  type RecheckRecord, type RecheckTailnet,
} from '../src/core/fleet/recheck-record.js';

const HOME = '/home/fakeuser';
const ISO = '2026-11-14T09:00:00.000Z';
const iso = (n: number) => new Date(Date.UTC(2026, 10, 14, 9, 0, n)).toISOString();

const dirs: string[] = [];
const tempRoot = (): string => { const d = mkdtempSync(join(tmpdir(), 'recheck-352-')); dirs.push(d); return d; };
afterEach(() => { vi.restoreAllMocks(); for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function peer(name: string, online: boolean | 'unknown') {
  return { name, online, ageSeconds: 5 as const };
}
function tailnet(peers: { name: string; online: boolean | 'unknown' }[], over: Record<string, unknown> = {}): FleetRecheckTailnet {
  return {
    source: 'tailscale-status', asOf: ISO, self: 'fake-self',
    online: peers.filter(p => p.online === true).length,
    offline: peers.filter(p => p.online === false).length,
    unknown: peers.filter(p => p.online === 'unknown').length,
    peers: peers.map(p => peer(p.name, p.online)),
    reasons: ['fake tailnet reason'],
    ...over,
  };
}
function fake(asOf: string, tail: FleetRecheck['tailnet'] = null): FleetRecheck {
  return {
    schema: 'fleet.recheck.v1', asOf, tailnet: tail,
    sections: {
      runtime: { state: 'VERIFIED', source: 'runtime-identity', asOf, host: 'fake-host', tailnetName: 'fake.ts.net', installedVersion: '1.2.3', sourceVersion: '1.2.3', fleetState: { ageSeconds: 3, stale: false }, missing: [] },
      claims: { state: 'VERIFIED', source: 'coordination', asOf, active: 0, expiredClaims: 0, top: [], missing: [] },
      bridge: { state: 'VERIFIED', source: 'channel-health', asOf, channels: [], missingBridge: null, missing: [] },
      task: { state: 'VERIFIED', source: 'work-board', asOf, task: null, unowned: 0, unclaimed: 0, missing: [] },
    },
    overall: { state: 'VERIFIED', missing: [] },
  };
}
/** Record builder through the real projector; peers default to one fake online mac. */
function record(asOf: string, peers: { name: string; online: boolean | 'unknown' }[] | null = [{ name: 'fake-mac-a', online: true }]): RecheckRecord {
  return projectRecheck(fake(asOf, peers === null ? null : tailnet(peers)));
}
function legacyRow(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: RECHECK_RECORD_SCHEMA, asOf: '2026-11-12T00:00:00.000Z', overall: 'VERIFIED',
    sections: {
      runtime: { state: 'VERIFIED', host: 'fake-host', installedVersion: '1.2.3', asOf: '2026-11-12T00:00:00.000Z' },
      claims: { state: 'VERIFIED', active: 1, asOf: '2026-11-12T00:00:00.000Z' },
      bridge: { state: 'VERIFIED', missingBridge: null, asOf: '2026-11-12T00:00:00.000Z' },
      task: { state: 'VERIFIED', id: 'T-1', owner: 'fake-agent', claimReceipt: 'rcpt-1', asOf: '2026-11-12T00:00:00.000Z' },
      ...over,
    },
  });
}

describe('recheck record tailnet computer evidence', () => {
  it('projects counts and capped {name, online} peers, nothing else', () => {
    const peers = Array.from({ length: 9 }, (_, i) => ({ name: `fake-mac-${i}`, online: i < 5 }));
    const r = projectRecheck(fake(ISO, tailnet(peers)));
    const t = r.sections.tailnet!;
    expect(t).toMatchObject({ online: 5, offline: 4, unknown: 0 });
    expect(t.peers).toHaveLength(RECHECK_TAILNET_PEERS_MAX);
    for (const p of t.peers) expect(Object.keys(p).sort()).toEqual(['name', 'online']);
    expect(JSON.stringify(r.sections.tailnet)).not.toMatch(/ageSeconds|fake-self|lastSeen|fake tailnet reason/);
  });

  it('caps a long peer name at RECHECK_REASON_MAX', () => {
    const r = projectRecheck(fake(ISO, tailnet([{ name: 'n'.repeat(300), online: true }])));
    expect(r.sections.tailnet!.peers).toEqual([{ name: 'n'.repeat(RECHECK_REASON_MAX), online: true }]);
  });

  it('collapses absent or malformed tailnet to null', () => {
    expect(projectRecheck(fake(ISO)).sections.tailnet).toBeNull();
    expect(projectRecheck(fake(ISO, null)).sections.tailnet).toBeNull();
    expect(projectRecheck(fake(ISO, tailnet([], { online: 1.5 }))).sections.tailnet).toBeNull();
    expect(projectRecheck(fake(ISO, tailnet([], { offline: 'many' }))).sections.tailnet).toBeNull();
    expect(projectRecheck(fake(ISO, tailnet([], { peers: 'nope' }))).sections.tailnet).toBeNull();
    expect(projectRecheck(fake(ISO, 'garbage' as never)).sections.tailnet).toBeNull();
  });

  it('drops a malformed peer entry and keeps the readable ones', () => {
    const t = tailnet([{ name: 'fake-mac-a', online: true }]);
    t.peers.push({ name: 7, online: true } as never, { name: 'fake-mac-b', online: 'yes' } as never);
    expect(projectRecheck(fake(ISO, t)).sections.tailnet!.peers).toEqual([{ name: 'fake-mac-a', online: true }]);
  });

  it('round trips through appendRecheckRecord and readRecheckRecords', () => {
    const root = tempRoot();
    const verdict = fake(ISO, tailnet([
      { name: 'fake-mac-a', online: true }, { name: 'fake-mac-b', online: false }, { name: 'fake-mac-c', online: 'unknown' },
    ]));
    const res = appendRecheckRecord(root, verdict, HOME);
    if (!res.ok) throw new Error('append failed');
    const expected: RecheckTailnet = {
      online: 1, offline: 1, unknown: 1,
      peers: [
        { name: 'fake-mac-a', online: true },
        { name: 'fake-mac-b', online: false },
        { name: 'fake-mac-c', online: 'unknown' },
      ],
    };
    expect(res.record.sections.tailnet).toEqual(expected);
    const line = readFileSync(recheckLogPath(root), 'utf8');
    expect(line).not.toMatch(/ageSeconds|fake-self|fake tailnet reason/);
    const rows = readRecheckRecords(root, 5);
    expect(rows.skipped).toBe(0);
    expect(rows.rows[0]!.sections.tailnet).toEqual(expected);
  });

  it('reads a pre-352 row without the key back as tailnet null with skipped 0', () => {
    const root = tempRoot();
    mkdirSync(join(root, 'fleet'), { recursive: true });
    appendFileSync(recheckLogPath(root), `${legacyRow()}\n`);
    const res = readRecheckRecords(root, 5);
    expect(res.skipped).toBe(0);
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]!.sections.tailnet).toBeNull();
  });

  it('counts a wrong-typed tailnet as skipped, never thrown', () => {
    const root = tempRoot();
    mkdirSync(join(root, 'fleet'), { recursive: true });
    appendFileSync(recheckLogPath(root),
      `${legacyRow({ tailnet: 'yes' })}\n${legacyRow({ tailnet: { online: 'many', offline: 0, unknown: 0, peers: [] } })}\n${legacyRow()}\n`);
    const res = readRecheckRecords(root, 5);
    expect(res.skipped).toBe(2);
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]!.sections.tailnet).toBeNull();
  });
});

describe('computersDelta', () => {
  it('is non-comparable when either row lacks tailnet evidence', () => {
    const withT = record(iso(2));
    const withoutT = record(iso(1), null);
    for (const [newer, older] of [
      [withT, null], [withT, withoutT], [withoutT, withT],
    ] as [RecheckRecord, RecheckRecord | null][]) {
      expect(computersDelta(newer, older)).toEqual({ wentOffline: [], cameOnline: [], since: null, comparable: false });
    }
  });

  it('names wentOffline and cameOnline, sorted, since the older row', () => {
    const older = record(iso(1), [
      { name: 'fake-mac-b', online: true }, { name: 'fake-mac-a', online: true },
      { name: 'fake-mac-c', online: false }, { name: 'fake-mac-d', online: false },
    ]);
    const newer = record(iso(2), [
      { name: 'fake-mac-b', online: false }, { name: 'fake-mac-c', online: true },
      { name: 'fake-mac-d', online: true },
      // fake-mac-a dropped while the newer list is under the cap: offline.
    ]);
    expect(computersDelta(newer, older)).toEqual({
      wentOffline: ['fake-mac-a', 'fake-mac-b'],
      cameOnline: ['fake-mac-c', 'fake-mac-d'],
      since: iso(1),
      comparable: true,
    });
  });

  it('treats absence as inconclusive when the absent side listed a full cap', () => {
    // Both lists sit at RECHECK_TAILNET_PEERS_MAX: fake-mac-0 falling out of
    // the newer list and fake-mac-z rising into it are both inconclusive.
    const full = Array.from({ length: RECHECK_TAILNET_PEERS_MAX }, (_, i) => ({ name: `fake-mac-${i}`, online: true }));
    const older = record(iso(1), full);
    const newer = record(iso(2), [...full.slice(1), { name: 'fake-mac-z', online: true }]);
    expect(computersDelta(newer, older)).toEqual({
      wentOffline: [], cameOnline: [], since: iso(1), comparable: true,
    });
  });

  it('treats unknown as neither online nor offline', () => {
    const older = record(iso(1), [
      { name: 'fake-mac-a', online: true }, { name: 'fake-mac-b', online: 'unknown' }, { name: 'fake-mac-c', online: false },
    ]);
    const newer = record(iso(2), [
      { name: 'fake-mac-a', online: 'unknown' }, { name: 'fake-mac-b', online: true }, { name: 'fake-mac-c', online: 'unknown' },
    ]);
    expect(computersDelta(newer, older)).toEqual({
      wentOffline: [], cameOnline: [], since: iso(1), comparable: true,
    });
  });

  it('never throws on damaged rows', () => {
    const damaged = { asOf: iso(2) } as RecheckRecord;
    expect(computersDelta(damaged, record(iso(1)))).toEqual({
      wentOffline: [], cameOnline: [], since: null, comparable: false,
    });
    expect(computersDelta(record(iso(2)), damaged)).toEqual({
      wentOffline: [], cameOnline: [], since: null, comparable: false,
    });
  });
});

describe('fleet recheck-record computers line', () => {
  it('prints the delta line in human output only when the newest two rows differ', async () => {
    const root = tempRoot();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(appendRecheckRecord(root, fake(iso(1), tailnet([{ name: 'fake-mac-a', online: true }])), HOME).ok).toBe(true);
    expect(appendRecheckRecord(root, fake(iso(2), tailnet([{ name: 'fake-mac-a', online: false }])), HOME).ok).toBe(true);
    log.mockClear();
    expect(await cmdFleetRecheckRecord(['--last', '2'], { root })).toBe(0);
    expect(log.mock.calls.map(c => c[0])).toEqual([
      `${iso(2)} VERIFIED runtime=VERIFIED claims=VERIFIED bridge=VERIFIED task=VERIFIED`,
      `${iso(1)} VERIFIED runtime=VERIFIED claims=VERIFIED bridge=VERIFIED task=VERIFIED`,
      `Computers changed since ${iso(1)}: offline fake-mac-a; online -`,
    ]);
    log.mockClear();
    expect(await cmdFleetRecheckRecord(['--last', '2', '--json'], { root })).toBe(0);
    expect(log.mock.calls.map(c => String(c[0])).join('\n')).not.toContain('Computers changed');
    const rows = JSON.parse(log.mock.lastCall![0] as string) as RecheckRecord[];
    expect(rows[0]!.sections.tailnet!.peers).toEqual([{ name: 'fake-mac-a', online: false }]);
  });

  it('prints no computers line when nothing changed or rows are not comparable', async () => {
    const same = tailnet([{ name: 'fake-mac-a', online: true }]);
    // Identical evidence on the newest two rows: comparable but empty delta.
    const unchanged = tempRoot();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    for (const n of [1, 2]) expect(appendRecheckRecord(unchanged, fake(iso(n), same), HOME).ok).toBe(true);
    expect(await cmdFleetRecheckRecord(['--last', '2'], { root: unchanged })).toBe(0);
    expect(log.mock.calls.map(c => String(c[0])).join('\n')).not.toContain('Computers changed');
    // Newest row has no tailnet evidence: not comparable.
    const preTailnet = tempRoot();
    expect(appendRecheckRecord(preTailnet, fake(iso(1), same), HOME).ok).toBe(true);
    expect(appendRecheckRecord(preTailnet, fake(iso(2), null), HOME).ok).toBe(true);
    log.mockClear();
    expect(await cmdFleetRecheckRecord(['--last', '2'], { root: preTailnet })).toBe(0);
    expect(log.mock.calls.map(c => String(c[0])).join('\n')).not.toContain('Computers changed');
  });
});
