/**
 * RQ-PHX-RUNTIMESUMMARYFRESH426S — the runtime summary qualifies the
 * execution report's own asOf at the post-read completion clock before
 * adopting it: a missing, invalid, future or over-age
 * (PROCESS_SNAPSHOT_MAX_AGE_MS) report instant is rejected with a fixed
 * sanitized reason, execution answers UNKNOWN with no affirmative counts,
 * and the advertised asOf stays at the completion clock — never moved
 * backward to a retained report or forward to an untrusted one. Synthetic
 * fixtures and deterministic clocks only; no real process or network reads.
 */
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PROCESS_SNAPSHOT_MAX_AGE_MS, type ClaimExecutionReport } from '../src/core/fleet/claim-execution-evidence.js';
import type { FleetBoard, FleetClaim } from '../src/core/fleet/coordination.js';
import * as workers from '../src/core/fleet/runs-live-workers.js';
import { defaults, readRuntimeSnapshot, type FleetRuntimeDeps } from '../src/core/fleet/runtime-snapshot.js';

const NOW = Date.parse('2026-11-15T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();
const claim = (id: string, expiresInMs = 3_600_000): FleetClaim => ({
  id, repo: 'fake/repo', task: 'fake task', agent: 'fake-agent',
  claimedAt: NOW - 60_000, expiresAt: NOW + expiresInMs,
});
const board = (...claims: FleetClaim[]): FleetBoard => ({
  schema: 'fleet.coordination.v1', state: 'known', expiredClaims: 0, messages: [], proposals: [], claims,
});
const counts = { running: 2, claimedNoWorker: 1, unknown: 0 };
/** A nominally healthy report; only its asOf stamp varies per case. */
const report = (asOf: string, countValues = counts): ClaimExecutionReport => ({
  schema: 'fleet.claim-execution.v1', authority: 'none', asOf,
  ledger: 'known', processes: 'healthy', rows: [], counts: countValues, reasons: [],
});
const UNKNOWN_EXECUTION = { state: 'UNKNOWN', running: 0, claimedNoWorker: 0, unknown: 0 };

let root: string;
let now: number;
function deps(over: Partial<FleetRuntimeDeps> = {}): FleetRuntimeDeps {
  return {
    now: () => now, home: () => root, stateRoot: () => root,
    host: () => 'fake-host', tailnet: () => 'fake-tailnet',
    installedVersion: () => '1.0.0', sourceVersion: () => '1.0.0',
    pid: () => 123, uptime: () => 10, platform: () => 'fake-os', arch: () => 'fake-arch',
    board: () => board(claim('RQ-FAKE-ONE'), claim('RQ-FAKE-TWO')),
    ...over,
  };
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'runtime-summary-freshness-426s-'));
  const state = join(root, 'fake-state');
  await writeFile(state, 'fake');
  await utimes(state, (NOW - 30_000) / 1000, (NOW - 30_000) / 1000);
  now = NOW;
});
afterEach(async () => { vi.restoreAllMocks(); await rm(root, { recursive: true, force: true }); });

describe('runtime summary execution report freshness', () => {
  it('keeps fresh healthy evidence known at the report join instant', async () => {
    const snapshot = await readRuntimeSnapshot(deps({
      execution: async () => { now += 2_000; return report(iso(now)); },
    }));
    expect(snapshot.asOf).toBe(iso(NOW + 2_000));
    expect(snapshot.execution).toEqual({ state: 'known', ...counts });
    expect(snapshot.coordination.activeClaims).toBe(2);
  });

  it('accepts a report stamped exactly at the freshness bound', async () => {
    const settle = NOW + 90_000;
    const snapshot = await readRuntimeSnapshot(deps({
      execution: async () => { now = settle; return report(iso(settle - PROCESS_SNAPSHOT_MAX_AGE_MS)); },
    }));
    expect(snapshot.asOf).toBe(iso(settle - PROCESS_SNAPSHOT_MAX_AGE_MS));
    expect(snapshot.execution).toEqual({ state: 'known', ...counts });
  });

  it('rejects a report one millisecond past the freshness bound', async () => {
    const settle = NOW + 120_000;
    const snapshot = await readRuntimeSnapshot(deps({
      execution: async () => { now = settle; return report(iso(settle - PROCESS_SNAPSHOT_MAX_AGE_MS - 1)); },
    }));
    // The advertised instant is the completion clock, not the retained report's.
    expect(snapshot.asOf).toBe(iso(settle));
    expect(snapshot.execution).toEqual({ ...UNKNOWN_EXECUTION,
      reason: 'execution: report asOf older than freshness bound' });
  });

  it('rejects a retained report the reader outlived and never counts it RUNNING', async () => {
    // The report was stamped at entry; the read itself ran past the freshness
    // bound, so at the completion clock it is retained evidence.
    const snapshot = await readRuntimeSnapshot(deps({
      execution: async () => { now += PROCESS_SNAPSHOT_MAX_AGE_MS + 1; return report(iso(NOW)); },
    }));
    expect(snapshot.asOf).toBe(iso(NOW + PROCESS_SNAPSHOT_MAX_AGE_MS + 1));
    expect(snapshot.execution).toEqual({ ...UNKNOWN_EXECUTION,
      reason: 'execution: report asOf older than freshness bound' });
    expect(snapshot.coordination.activeClaims).toBe(2);
  });

  it('rejects a future-dated report without moving asOf forward', async () => {
    const snapshot = await readRuntimeSnapshot(deps({
      execution: async () => report(iso(NOW + 30_000)),
    }));
    expect(snapshot.asOf).toBe(iso(NOW));
    expect(snapshot.execution).toEqual({ ...UNKNOWN_EXECUTION,
      reason: 'execution: report asOf ahead of observation clock' });
  });

  it.each(['not-a-timestamp', ''])('rejects an unparseable report asOf %j', async bad => {
    const snapshot = await readRuntimeSnapshot(deps({ execution: async () => report(bad) }));
    expect(snapshot.asOf).toBe(iso(NOW));
    expect(snapshot.execution).toEqual({ ...UNKNOWN_EXECUTION,
      reason: 'execution: report asOf missing or invalid' });
  });

  it('rejects a report carrying no asOf instant at all', async () => {
    const malformed = { ...report(iso(NOW)), asOf: undefined } as unknown as ClaimExecutionReport;
    const snapshot = await readRuntimeSnapshot(deps({ execution: async () => malformed }));
    expect(snapshot.execution).toEqual({ ...UNKNOWN_EXECUTION,
      reason: 'execution: report asOf missing or invalid' });
  });

  it('evaluates coordination at the completion clock when the report is rejected', async () => {
    // RQ-FAKE-TWO expires while the execution reader is in flight; the
    // retained report is rejected, so claim liveness and ages are measured
    // at the completion instant — the dead claim is neither live nor RUNNING.
    const completion = NOW + PROCESS_SNAPSHOT_MAX_AGE_MS + 10_000;
    const snapshot = await readRuntimeSnapshot(deps({
      board: () => board(claim('RQ-FAKE-ONE'), claim('RQ-FAKE-TWO', 30_000)),
      execution: async () => { now = completion; return report(iso(NOW), { running: 2, claimedNoWorker: 0, unknown: 0 }); },
    }));
    expect(snapshot.asOf).toBe(iso(completion));
    expect(snapshot.coordination.activeClaims).toBe(1);
    expect(snapshot.execution).toEqual({ ...UNKNOWN_EXECUTION,
      reason: 'execution: report asOf older than freshness bound' });
  });

  it('re-evaluates claim liveness at a qualified report join instant', async () => {
    // The report is fresh, so its join instant is the observation instant:
    // RQ-FAKE-TWO died inside the read window and is not counted live.
    const snapshot = await readRuntimeSnapshot(deps({
      board: () => board(claim('RQ-FAKE-ONE'), claim('RQ-FAKE-TWO', 5_000)),
      execution: async () => { now += 10_000; return report(iso(now), { running: 1, claimedNoWorker: 0, unknown: 0 }); },
    }));
    expect(snapshot.asOf).toBe(iso(NOW + 10_000));
    expect(snapshot.coordination.activeClaims).toBe(1);
    expect(snapshot.execution).toEqual({ state: 'known', running: 1, claimedNoWorker: 0, unknown: 0 });
  });

  it('preserves source failure reasons on a qualified report', async () => {
    const snapshot = await readRuntimeSnapshot(deps({
      execution: async () => ({ ...report(iso(NOW)), ledger: 'unavailable' as const,
        processes: 'unavailable' as const, counts: { running: 0, claimedNoWorker: 0, unknown: 0 } }),
    }));
    expect(snapshot.asOf).toBe(iso(NOW));
    expect(snapshot.execution).toEqual({ ...UNKNOWN_EXECUTION, reason: 'execution: ledger unavailable' });
  });

  it('never exposes arbitrary report stamp or reason text', async () => {
    const hostile = 'PRIVATE-STAMP-7f3a /fake/private-path sk-live-123';
    const snapshot = await readRuntimeSnapshot(deps({
      execution: async () => ({ ...report(hostile), reasons: ['private reader detail'] }),
    }));
    const serialized = JSON.stringify(snapshot);
    for (const privateText of ['PRIVATE-STAMP', '/fake/private-path', 'sk-live-123', 'private reader detail']) {
      expect(serialized).not.toContain(privateText);
    }
    expect(snapshot.execution).toEqual({ ...UNKNOWN_EXECUTION,
      reason: 'execution: report asOf missing or invalid' });
  });

  it('qualifies the captured-board join without an extra clock sample', async () => {
    // The default reader's own post-worker clock sample is the completion
    // clock: the injected clock is still sampled exactly twice per request.
    vi.spyOn(workers, 'listLiveWorkers').mockImplementation(async () => {
      const generatedAt = now;
      now += 2_000;
      return { v: 1, generatedAt: iso(generatedAt), sourceState: 'healthy' as const,
        leaders: [], orchestratorAgents: 0,
        workers: [{ job: 'RQ-FAKE-ONE', pid: 100, repo: 'repo', lane: 'fake', tier: 'work', ageSeconds: 1 }] };
    });
    vi.spyOn(defaults, 'board').mockImplementation(() => { throw new Error('wrong board'); });
    const clock = vi.fn(() => now);
    const snapshot = await readRuntimeSnapshot({
      ...deps(() => board(claim('RQ-FAKE-ONE'), claim('RQ-FAKE-TWO'))), now: clock,
    });
    expect(clock).toHaveBeenCalledTimes(2);
    expect(snapshot.asOf).toBe(iso(NOW + 2_000));
    expect(snapshot.execution).toEqual({ state: 'known', running: 1, claimedNoWorker: 1, unknown: 0 });
    expect(snapshot.coordination.activeClaims).toBe(2);
  });
});
