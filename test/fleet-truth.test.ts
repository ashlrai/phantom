import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { composeBrief, gatherBriefFacts } from '../src/core/comms/leader-brief.js';
import { getFleetTruth, getFleetTruthToday, resetFleetTruthCache, startOfDayInZone } from '../src/core/fleet/fleet-truth.js';
import { buildFleetPulseMessage } from '../src/core/comms/fleet-pulse.js';

// 2026-11-02 evening in New York (EST, UTC-5 after the Nov 1 fall-back).
const NOW = Date.parse('2026-11-02T23:30:00Z');
const ET_MIDNIGHT = Date.parse('2026-11-02T05:00:00Z');

function ghRows(n: number, firstAtMs = ET_MIDNIGHT + 60_000): string {
  return JSON.stringify(Array.from({ length: n }, (_, i) => ({
    repository: { nameWithOwner: `ashlrai/repo-${i % 5}` },
    number: 1000 + i,
    title: `change ${i}`,
    url: `https://github.com/ashlrai/repo-${i % 5}/pull/${1000 + i}`,
    closedAt: new Date(firstAtMs + i * 60_000).toISOString(),
  })));
}

const emptyDigest = { ledger: async () => [] };
const noRunsDir = join(mkdtempSync(join(tmpdir(), 'fleet-truth-')), 'none');

beforeEach(() => resetFleetTruthCache());

describe('startOfDayInZone', () => {
  it('uses the America/New_York midnight, not UTC midnight', () => {
    expect(new Date(startOfDayInZone(NOW)).toISOString()).toBe('2026-11-02T05:00:00.000Z');
  });

  it('puts 23:59:59 ET and 00:00:00 ET on opposite sides of the boundary', () => {
    const before = Date.parse('2026-11-03T04:59:59Z'); // 23:59:59 ET Nov 2
    const after = Date.parse('2026-11-03T05:00:00Z'); // 00:00:00 ET Nov 3
    expect(startOfDayInZone(before)).toBe(ET_MIDNIGHT);
    expect(startOfDayInZone(after)).toBe(Date.parse('2026-11-03T05:00:00Z'));
  });

  it('follows the DST change (EDT midnight is UTC-4)', () => {
    expect(new Date(startOfDayInZone(Date.parse('2026-10-15T12:00:00Z'))).toISOString()).toBe('2026-10-15T04:00:00.000Z');
    // Nov 1 2026 is the fall-back day: midnight is still EDT, the day is 25h long.
    expect(new Date(startOfDayInZone(Date.parse('2026-11-01T12:00:00Z'))).toISOString()).toBe('2026-11-01T04:00:00.000Z');
  });
});

describe('getFleetTruth', () => {
  it('excludes a merge one second before ET midnight and includes one at midnight', async () => {
    const rows = JSON.stringify([
      { repository: { nameWithOwner: 'ashlrai/a' }, number: 1, title: 'late yesterday', url: 'u1', closedAt: new Date(ET_MIDNIGHT - 1000).toISOString() },
      { repository: { nameWithOwner: 'ashlrai/a' }, number: 2, title: 'first today', url: 'u2', closedAt: new Date(ET_MIDNIGHT).toISOString() },
    ]);
    const truth = await getFleetTruthToday({ nowMs: NOW, gh: async () => rows, ledgerMerges: () => [], runsDir: noRunsDir });
    expect(truth.mergeCountState).toBe('ok');
    expect(truth.merged.map((m) => m.number)).toEqual([2]);
  });

  it('unions gh with ledger merges and dedupes by repo#number', async () => {
    const truth = await getFleetTruth(ET_MIDNIGHT, {
      nowMs: NOW,
      gh: async () => ghRows(3),
      ledgerMerges: () => [
        { repo: 'ashlrai/repo-0', number: 1000, atMs: ET_MIDNIGHT + 60_000 }, // same PR as gh row 0
        { repo: 'ashlrai/phantom', number: 7, atMs: ET_MIDNIGHT + 5_000_000 }, // ledger only
      ],
      runsDir: noRunsDir,
    });
    expect(truth.merged).toHaveLength(4);
    expect(truth.merged.find((m) => m.number === 1000)?.source).toBe('both');
    expect(truth.merged.find((m) => m.number === 7)?.source).toBe('ledger');
  });

  it('caches the gh read for 120s', async () => {
    let calls = 0;
    const gh = async (): Promise<string> => { calls++; return ghRows(2); };
    const opts = { gh, ledgerMerges: () => [], runsDir: noRunsDir };
    await getFleetTruth(ET_MIDNIGHT, { ...opts, nowMs: NOW });
    await getFleetTruth(ET_MIDNIGHT, { ...opts, nowMs: NOW + 119_000 });
    expect(calls).toBe(1);
    await getFleetTruth(ET_MIDNIGHT, { ...opts, nowMs: NOW + 121_000 });
    expect(calls).toBe(2);
  });

  it('reports unavailable when gh fails, keeping ledger merges', async () => {
    const truth = await getFleetTruth(ET_MIDNIGHT, {
      nowMs: NOW,
      gh: async () => { throw new Error('gh unavailable'); },
      ledgerMerges: () => [{ repo: 'ashlrai/phantom', number: 7, atMs: ET_MIDNIGHT + 1000 }],
      runsDir: noRunsDir,
    });
    expect(truth.mergeCountState).toBe('unavailable');
    expect(truth.merged).toHaveLength(1);
  });

  it('reads queued from ready.tsv and running from a fresh admission.json', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fleet-truth-runs-'));
    mkdirSync(join(root, 'queue'));
    writeFileSync(join(root, 'queue', 'ready.tsv'), 'READY\tclaude\tphantom\twork\tP0\tone\nREADY\tcodex-cmp\tphantom\twork\tP1\ttwo\n');
    writeFileSync(join(root, 'queue', 'admission.json'), JSON.stringify({ schema: 'dispatchd.admission.v1', ts: new Date(NOW - 30_000).toISOString(), running: 6 }));
    const truth = await getFleetTruth(ET_MIDNIGHT, { nowMs: NOW, gh: async () => '[]', ledgerMerges: () => [], runsDir: root, liveWorkers: async () => 99 });
    expect(truth.running).toBe(6);
    expect(truth.queued).toBe(2);
  });

  it('falls back to live job pids when admission.json is stale', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fleet-truth-runs-'));
    mkdirSync(join(root, 'queue'));
    writeFileSync(join(root, 'queue', 'admission.json'), JSON.stringify({ ts: new Date(NOW - 3_600_000).toISOString(), running: 6 }));
    const truth = await getFleetTruth(ET_MIDNIGHT, { nowMs: NOW, gh: async () => '[]', ledgerMerges: () => [], runsDir: root, liveWorkers: async () => 3 });
    expect(truth.running).toBe(3);
    expect(truth.queued).toBeNull();
  });
});

// gatherBriefFacts cold-imports the leader/cloud modules; give the first call room.
describe('evening brief', { timeout: 60_000 }, () => {
  const sources = (gh: () => Promise<string>) => ({
    digest: {
      ...emptyDigest,
      fleetTruth: (since: number) => getFleetTruth(since, { nowMs: NOW, gh, ledgerMerges: () => [], runsDir: noRunsDir }),
    },
  });

  it('empty ledger + 52 gh merges reads "Shipped: 52", never "nothing merged"', async () => {
    const facts = await gatherBriefFacts(ET_MIDNIGHT, NOW, sources(async () => ghRows(52)));
    const text = composeBrief('evening', facts);
    expect(facts.shipped).toHaveLength(52);
    expect(text).toContain('Shipped: 52');
    expect(text).not.toContain('nothing merged');
    expect(text).not.toContain('unavailable');
  });

  it('says "merge count unavailable" when gh is unreachable, never "nothing merged"', async () => {
    const facts = await gatherBriefFacts(ET_MIDNIGHT, NOW, sources(async () => { throw new Error('gh unavailable'); }));
    const text = composeBrief('evening', facts);
    expect(text).toContain('Shipped: merge count unavailable');
    expect(text).not.toContain('nothing merged');
  });

  it('still says "nothing merged today" when gh answered with zero', async () => {
    const facts = await gatherBriefFacts(ET_MIDNIGHT, NOW, sources(async () => '[]'));
    expect(composeBrief('evening', facts)).toContain('Shipped: nothing merged today');
  });

  it('shows fleet running/queued when known', () => {
    const text = composeBrief('evening', {
      nowMs: NOW, sinceMs: ET_MIDNIGHT, shipped: [], prsOpened: 0, mergeCountUnavailable: false,
      fleet: { running: 4, queued: 11 }, running: [], blockers: [], next: [], question: null, pendingActionIds: [],
    });
    expect(text).toContain('Fleet: 4 running, 11 queued');
  });
});

describe('fleet pulse', () => {
  it('says merge count unavailable instead of a zero', () => {
    const snap = {
      generatedAt: new Date(NOW).toISOString(),
      director: { topGoalObjective: null, escalationCount: 0, resourcePosture: 'normal' },
      fleetActivity: { totalDispatches: 3, byBackend: [], mergedToday: 0, mergeCountUnavailable: true, rejectedToday: 0, proposalsPending: 1, proposalsApplied: 0, queueBacklog: 0, recentMergeTitles: [] },
      resourceGrid: [],
      costSavings: { todaySpendUsd: 0 },
    } as unknown as Parameters<typeof buildFleetPulseMessage>[0];
    const msg = buildFleetPulseMessage(snap);
    expect(msg).toContain('merge count unavailable');
    expect(msg).not.toMatch(/0 merged/);
  });
});
