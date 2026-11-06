import { describe, expect, it } from 'vitest';
import { LANE_BREAKER_STREAK, laneBreakers } from '../src/core/drive/lane-breaker.js';
import { RECOVERY_PROBE_MS } from '../src/core/drive/lane-health.js';
import type { DriveJob } from '../src/core/drive/supervisor.js';

const now = 10_000_000;
const finish = (id: string, pool: string, at: number, exitCode: number, emptyFinish: boolean): DriveJob =>
  ({ id, pool, state: 'FAILED', priority: 1, completedAtMs: at, exitCode, emptyFinish });
const bad = (id: string, pool: string, at: number): DriveJob => finish(id, pool, at, 1, true);
const good = (id: string, pool: string, at: number): DriveJob => finish(id, pool, at, 0, false);
const ready = (id: string, pool: string): DriveJob => ({ id, pool, state: 'READY', priority: 1 });
const streak = (pool: string, end: number, count = LANE_BREAKER_STREAK, tag = ''): DriveJob[] =>
  Array.from({ length: count }, (_, i) => bad(`${pool}-${tag}${i}`, pool, end - (count - 1 - i) * 1000));
const breaker = (jobs: DriveJob[], at: number, pool: string) =>
  laneBreakers(jobs, at).find(entry => entry.pool === pool)!;

describe('drive lane breakers', () => {
  it('opens after five consecutive empty nonzero finishes, one pool only', () => {
    const jobs = [...streak('claude-api', now - 1000), ...streak('devin', now - 1000, 4), ready('d1', 'devin')];
    const breakers = laneBreakers(jobs, now);
    expect(breakers.map(entry => entry.pool)).toEqual(['claude-api', 'devin']);
    expect(breaker(jobs, now, 'claude-api')).toEqual({ pool: 'claude-api', state: 'open',
      reason: 'empty-nonzero-streak', probeAtMs: now - 1000 + RECOVERY_PROBE_MS });
    expect(breaker(jobs, now, 'devin')).toEqual({ pool: 'devin', state: 'closed', reason: null, probeAtMs: null });
  });
  it('stays closed at four consecutive empty nonzero finishes', () => {
    expect(breaker(streak('api', now - 1000, 4), now, 'api'))
      .toEqual({ pool: 'api', state: 'closed', reason: null, probeAtMs: null });
  });
  it('resets the streak on one good finish inside the run', () => {
    const jobs = [...streak('api', now - 6000, 4, 'a'), good('mid', 'api', now - 5000),
      ...streak('api', now - 1000, 4, 'b')];
    expect(breaker(jobs, now, 'api').state).toBe('closed');
  });
  it('does not close on a quiet hour', () => {
    const jobs = streak('api', now - 3_700_000);
    const entry = breaker(jobs, now, 'api');
    expect(entry.state).not.toBe('closed');
    expect(entry.state).toBe('probing');
    expect(entry.reason).toBe('empty-nonzero-streak');
  });
  it('moves from open to probing at probeAtMs', () => {
    const jobs = streak('api', now - 1000);
    const probeAt = now - 1000 + RECOVERY_PROBE_MS;
    expect(breaker(jobs, probeAt - 1, 'api').state).toBe('open');
    expect(breaker(jobs, probeAt, 'api').state).toBe('probing');
    expect(breaker(jobs, probeAt, 'api').probeAtMs).toBe(probeAt);
  });
  it('backs the probe off again when the probing finish is also bad', () => {
    const firstProbe = now - 1000 + RECOVERY_PROBE_MS;
    const jobs = [...streak('api', now - 1000), bad('probe', 'api', firstProbe)];
    expect(breaker(jobs, firstProbe + 1, 'api').state).toBe('open');
    expect(breaker(jobs, firstProbe + RECOVERY_PROBE_MS, 'api').state).toBe('probing');
  });
  it('closes on the first non-empty finish with exit code 0', () => {
    const jobs = [...streak('api', now - 2000), good('probe', 'api', now - 1000)];
    expect(breaker(jobs, now, 'api'))
      .toEqual({ pool: 'api', state: 'closed', reason: null, probeAtMs: null });
  });
  it('replays finishes by time, not input order', () => {
    const jobs = [good('late', 'api', now - 100), ...streak('api', now - 2000)];
    expect(breaker(jobs, now, 'api').state).toBe('closed');
    expect(breaker([...jobs].reverse(), now, 'api').state).toBe('closed');
  });
  it('breaks the streak on finishes that are neither empty-nonzero nor good', () => {
    const jobs = [...streak('api', now - 6000, 4, 'a'), finish('ne', 'api', now - 5000, 1, false),
      ...streak('api', now - 1000, 4, 'b')];
    expect(breaker(jobs, now, 'api').state).toBe('closed');
  });
  it('excludes future finishes and reports pools without finishes as closed', () => {
    const jobs = [...streak('api', now + 1000), ready('r', 'docs')];
    const breakers = laneBreakers(jobs, now);
    expect(breaker(jobs, now, 'api').state).toBe('closed');
    expect(breaker(jobs, now, 'docs')).toEqual({ pool: 'docs', state: 'closed', reason: null, probeAtMs: null });
    expect(breakers).toHaveLength(2);
  });
});
