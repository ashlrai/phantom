/**
 * fleet-runs-fixtures.test.ts — smoke-verify the shared FleetRunsV1 fixture.
 */
import { describe, it, expect } from 'vitest';
import type { FleetRunsV1 } from '../../../../core/verse/fleet-runs-types.js';
import { fleetRunsFixture, withLane, withWorker, degraded } from './fleet-runs-fixtures.test-support.js';

describe('fleetRunsFixture', () => {
  it('base fixture is a valid FleetRunsV1 (type-level)', () => {
    const s: FleetRunsV1 = fleetRunsFixture();
    expect(s.v).toBe(1);
  });

  it('has v: 1 and five healthy sources', () => {
    const s = fleetRunsFixture();
    expect(s.v).toBe(1);
    expect(Object.keys(s.sources)).toHaveLength(5);
    expect(Object.values(s.sources)).toEqual(['healthy', 'healthy', 'healthy', 'healthy', 'healthy']);
  });

  it('withLane replaces an existing lane and adds a new one', () => {
    const base = fleetRunsFixture();
    const patched = withLane(base, { lane: 'codex-personal', running: 5 });
    const replaced = patched.lanes.find(l => l.lane === 'codex-personal');
    expect(replaced!.running).toBe(5);
    expect(base.lanes.find(l => l.lane === 'codex-personal')!.running).toBe(3);

    const added = withLane(base, { lane: 'new-lane', running: 0, target: 3, queued: 0, held: false, heldReason: null, tokensLastHour: null, merged24h: 0, mergeRate24h: 0 });
    expect(added.lanes).toHaveLength(3);
    expect(added.lanes[2].lane).toBe('new-lane');
  });

  it('withWorker appends without mutating the original', () => {
    const base = fleetRunsFixture();
    const patched = withWorker(base, { job: 'RQ-NEW-JOB', repo: 'fake/x', lane: 'devin', tier: 'low', ageSeconds: 30 });
    expect(patched.workers).toHaveLength(2);
    expect(patched.workers[1].job).toBe('RQ-NEW-JOB');
    expect(base.workers).toHaveLength(1);
  });

  it('degraded changes exactly one source', () => {
    const base = fleetRunsFixture();
    const d = degraded(base, 'codex');
    expect(d.sources.codex).toBe('degraded');
    expect(d.sources.runsDir).toBe('healthy');
    expect(base.sources.codex).toBe('healthy');
  });

  it('fleetRunsFixture({ paused: true }).paused === true', () => {
    expect(fleetRunsFixture({ paused: true }).paused).toBe(true);
  });
});
