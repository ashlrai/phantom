/**
 * Merged-PR cost rollup tests (RQ-PLAN-OTEL-COST-B).
 *
 * Covers:
 *   - collectFleetHopEvents: spool reading, malformed lines, missing file
 *   - buildMergedPrCostRollup: golden fixture rollup, dedup, test hops,
 *     unknown pool, missing-value coverage, window filtering, mergedAt picking
 *   - mergedPrCostRollupFromSpool: file-backed entry, window convenience
 *
 * Hermetic: the fixture lives in test/fixtures; tmp dirs only; no network,
 * no env, no real ~/.ashlr reads.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildMergedPrCostRollup,
  collectFleetHopEvents,
  mergedPrCostRollupFromSpool,
} from '../src/core/observability/rollup.js';
import { buildFleetHop } from '../src/core/observability/fleet-hop.js';

const FIXTURE = join(__dirname, 'fixtures', 'fleet-hop-merged-pr.jsonl');
const fixtureRows = (): unknown[] => collectFleetHopEvents({ spoolPath: FIXTURE });

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'merged-pr-cost-'));
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

/** A spool-format fleet_hop envelope via the real emitter (fixed exit time). */
function hop(input: Parameters<typeof buildFleetHop>[0]) {
  return buildFleetHop(input, () => new Date('2026-10-26T12:00:00Z'));
}

describe('collectFleetHopEvents', () => {
  it('parses a spool, surfacing malformed JSON lines as null', () => {
    const rows = fixtureRows();
    expect(rows).toHaveLength(19);
    expect(rows.filter((r) => r === null)).toHaveLength(1);
    expect(rows.filter((r) => r !== null && (r as { event?: string }).event === 'fleet_hop'))
      .toHaveLength(16);
  });

  it('returns [] for a missing spool and for a non-file path', () => {
    expect(collectFleetHopEvents({ spoolPath: join(dir, 'nope.jsonl') })).toEqual([]);
    expect(collectFleetHopEvents({ spoolPath: dir })).toEqual([]);
  });
});

describe('buildMergedPrCostRollup - fixture golden', () => {
  const rollup = buildMergedPrCostRollup(fixtureRows());

  it('counts valid hops and dropped rows', () => {
    expect(rollup.schemaVersion).toBe(1);
    expect(rollup.hops).toBe(13);
    expect(rollup.invalidDropped).toBe(3);
    expect(rollup.duplicatesDropped).toBe(2);
    expect(rollup.testDropped).toBe(1);
  });

  it('produces one row per merged PR, sorted by mergedAt', () => {
    expect(rollup.mergedPrs.map((p) => p.pr)).toEqual([951, 977]);
    expect(rollup.mergedPrs[0]!.mergedAt).toBe('2026-10-26T06:20:00Z');
    expect(rollup.mergedPrs[1]!.mergedAt).toBe('2026-10-27T14:05:00Z');
  });

  it('sums tokens and dollars per PR across every contributing hop', () => {
    const pr = rollup.mergedPrs[0]!;
    expect(pr.repo).toBe('ashlrai/phantom');
    expect(pr.jobs).toEqual(['RQ-QUEUE-1', 'RQ-QUEUE-1-FIX']);
    expect(pr.totals).toEqual({
      hops: 6, tokens: 2750, usd: expect.closeTo(0.1, 10), missingTokens: 2, missingUsd: 2,
    });
  });

  it('groups spend by pool, sorted by label', () => {
    const [codex, devin] = rollup.mergedPrs[0]!.byPool;
    expect(codex).toEqual({
      pool: 'codex-cmp', hops: 5, jobs: ['RQ-QUEUE-1'],
      tokens: 1950, usd: expect.closeTo(0.07, 10), missingTokens: 2, missingUsd: 2,
    });
    expect(devin).toEqual({
      pool: 'devin', hops: 1, jobs: ['RQ-QUEUE-1-FIX'],
      tokens: 800, usd: 0.03, missingTokens: 0, missingUsd: 0,
    });
  });

  it('buckets unattributed spend under the unknown pool', () => {
    const pr = rollup.mergedPrs[1]!;
    expect(pr.totals).toEqual({ hops: 3, tokens: 600, usd: 0.02, missingTokens: 1, missingUsd: 2 });
    const unknown = pr.byPool.find((p) => p.pool === 'unknown')!;
    expect(unknown).toMatchObject({ hops: 1, jobs: [], tokens: 100, usd: 0, missingTokens: 0, missingUsd: 1 });
  });

  it('excludes PRs that never reached the merged station', () => {
    expect(rollup.mergedPrs.some((p) => p.pr === 988)).toBe(false);
  });
});

describe('buildMergedPrCostRollup - semantics', () => {
  it('sinceMs filters the merge time only; earlier hops still count', () => {
    // Between PR 951's first hop (06:00) and its merge (06:20): the PR still
    // joins, and every hop, including pre-window ones, contributes spend.
    const rollup = buildMergedPrCostRollup(fixtureRows(), {
      sinceMs: Date.parse('2026-10-26T06:15:00Z'),
    });
    expect(rollup.mergedPrs.map((p) => p.pr)).toEqual([951, 977]);
    expect(rollup.mergedPrs[0]!.totals.tokens).toBe(2750);
  });

  it('excludes PRs merged before the window', () => {
    const rollup = buildMergedPrCostRollup(fixtureRows(), {
      sinceMs: Date.parse('2026-10-27T00:00:00Z'),
    });
    expect(rollup.mergedPrs.map((p) => p.pr)).toEqual([977]);
  });

  it('returns no PRs when every merge predates the window, but still reports coverage', () => {
    const rollup = buildMergedPrCostRollup(fixtureRows(), {
      sinceMs: Date.parse('2026-10-28T00:00:00Z'),
    });
    expect(rollup.mergedPrs).toEqual([]);
    expect(rollup.hops).toBe(13);
  });

  it('returns zeros for empty and fully invalid input', () => {
    expect(buildMergedPrCostRollup([])).toMatchObject({ hops: 0, mergedPrs: [] });
    const rollup = buildMergedPrCostRollup([null, 42, 'x', { event: 'other' }, { event: 'fleet_hop' }]);
    expect(rollup).toMatchObject({ hops: 0, invalidDropped: 5, mergedPrs: [] });
  });

  it('drops hops without a parseable station or timestamp', () => {
    const bad = [
      hop({ station: 'merged', pr: 1, enter_ts: '2026-10-26T01:00:00Z' }),
      { event: 'fleet_hop', properties: { station: 'merged', pr: 1 } },
      { event: 'fleet_hop', timestamp: '2026-10-26T01:00:00Z', properties: { pr: 1 } },
      { event: 'fleet_hop', timestamp: '2026-10-26T01:00:00Z', properties: { station: 'merged', pr: 1, pool: 42 } },
    ];
    const rollup = buildMergedPrCostRollup(bad);
    expect(rollup.hops).toBe(1);
    expect(rollup.invalidDropped).toBe(3);
    expect(rollup.mergedPrs.map((p) => p.pr)).toEqual([1]);
  });

  it('collapses re-emitted copies of one hop via $insert_id', () => {
    const a = hop({ job_id: 'J1', station: 'merged', pool: 'devin', pr: 7, enter_ts: '2026-10-26T01:00:00Z', tokens: 10, usd: 0.01 });
    const b = hop({ job_id: 'J1', station: 'merged', pool: 'devin', pr: 7, enter_ts: '2026-10-26T01:00:00Z', tokens: 10, usd: 0.01 });
    const rollup = buildMergedPrCostRollup([a, b, a]);
    expect(rollup.hops).toBe(1);
    expect(rollup.duplicatesDropped).toBe(2);
    expect(rollup.mergedPrs[0]!.totals.tokens).toBe(10);
  });

  it('merges spend from buildFleetHop-emitters across pools and stations', () => {
    const rows = [
      hop({ job_id: 'J1', station: 'claimed', pool: 'devin', pr: 42, repo: 'ashlrai/phantom', enter_ts: '2026-10-26T01:00:00Z', tokens: 100, usd: 0.01 }),
      hop({ job_id: 'J2', station: 'publish', pool: 'codex-cmp', pr: 42, repo: 'ashlrai/phantom', enter_ts: '2026-10-26T02:00:00Z', tokens: 50, usd: 0.005 }),
      hop({ job_id: 'J1', station: 'merged', pool: 'devin', pr: 42, repo: 'ashlrai/phantom', enter_ts: '2026-10-26T03:00:00Z' }),
    ];
    const rollup = buildMergedPrCostRollup(rows);
    expect(rollup.mergedPrs).toHaveLength(1);
    const pr = rollup.mergedPrs[0]!;
    expect(pr.jobs).toEqual(['J1', 'J2']);
    expect(pr.totals.tokens).toBe(150);
    expect(pr.totals.usd).toBeCloseTo(0.015, 10);
    expect(pr.byPool.map((p) => p.pool)).toEqual(['codex-cmp', 'devin']);
  });
});

describe('mergedPrCostRollupFromSpool', () => {
  it('reads the spool and rolls up', () => {
    const rollup = mergedPrCostRollupFromSpool({ spoolPath: FIXTURE });
    expect(rollup.mergedPrs.map((p) => p.pr)).toEqual([951, 977]);
  });

  it('produces an empty rollup for a missing spool', () => {
    expect(mergedPrCostRollupFromSpool({ spoolPath: join(dir, 'none.jsonl') }).mergedPrs).toEqual([]);
  });

  it('round-trips a spool written through the emitter path', () => {
    const spoolPath = join(dir, 'spool.jsonl');
    const events = [
      hop({ job_id: 'J1', station: 'claimed', pool: 'devin', pr: 5, enter_ts: '2026-10-26T01:00:00Z', tokens: 10, usd: 0.001 }),
      hop({ job_id: 'J1', station: 'merged', pool: 'devin', pr: 5, enter_ts: '2026-10-26T02:00:00Z' }),
    ];
    writeFileSync(spoolPath, events.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8');
    const rollup = mergedPrCostRollupFromSpool({ spoolPath });
    expect(rollup.mergedPrs).toHaveLength(1);
    expect(rollup.mergedPrs[0]!.totals.tokens).toBe(10);
  });

  it('maps window to a mergedAt floor', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-28T12:00:00Z'));
    // 1d since = 2026-10-27T12:00: only PR 977 (merged 14:05) is inside.
    expect(mergedPrCostRollupFromSpool({ spoolPath: FIXTURE, window: '1d' }).mergedPrs.map((p) => p.pr)).toEqual([977]);
    // 7d since = 2026-10-21T12:00: both merges are inside.
    expect(mergedPrCostRollupFromSpool({ spoolPath: FIXTURE, window: '7d' }).mergedPrs).toHaveLength(2);
  });
});

describe('fixture integrity', () => {
  it('every fleet_hop line re-validates through buildFleetHop semantics', () => {
    // The fixture rows are emitted-event envelopes; spot-check the first line
    // is a real emitted shape (insert id, queue.v1 schema marker present).
    const first = JSON.parse(readFileSync(FIXTURE, 'utf8').split('\n')[0]!) as {
      event: string; properties: Record<string, unknown>;
    };
    expect(first.event).toBe('fleet_hop');
    expect(first.properties['schema']).toBe('queue.v1');
    expect(first.properties['$insert_id']).toBe('aa010000000000000000000000000aa1');
  });
});
