import { beforeEach, describe, expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), lock: vi.fn(), release: vi.fn() }));
vi.mock('node:fs', () => ({ readFileSync: io.read }));
vi.mock('../src/core/fleet/local-store-lock.js', () => ({ acquireLocalStoreLock: io.lock, releaseLocalStoreLock: io.release }));
vi.mock('../src/core/util/private-file-write.js', () => ({ writePrivateFileAtomically: io.write }));
import { addFleetUsage, fleetUsageReport, readFleetUsage, usagePacing } from '../src/core/fleet/usage-pacing.js';
import { cmdFleetUsage } from '../src/cli/fleet-usage.js';
const now = Date.parse('2026-10-26T13:15:00Z');
const pool = () => ({ resetAt: '2026-10-28T13:15:00Z', readings: [
  { pct: 49, at: '2026-10-26T01:30:00Z' }, { pct: 63, at: '2026-10-26T13:15:00Z' },
] });
beforeEach(() => {
  vi.restoreAllMocks();
  io.read.mockReset().mockImplementation(() => JSON.stringify({ retained: true, usage: { 'grok-ultra-weekly': pool() } }));
  io.write.mockReset(); io.lock.mockReset().mockReturnValue({}); io.release.mockReset();
});
describe('manual fleet pacing', () => {
  it('measures the acceptance fixture and publishes the same router/parity numbers', () => {
    const result = usagePacing(pool(), now);
    expect(result.pointsPerHour).toBeCloseTo(1.19149, 4);
    expect(result.pointsPerHour12h).toBe(result.pointsPerHour);
    expect(result.paceNeeded).toBeCloseTo(35 / 48);
    expect(result).toMatchObject({ throttle: true, preferMacPools: true, boxAgentTurnMultiplier: 0.5 });
    expect(Date.parse(result.projectedRunOutAt!)).toBeCloseTo(now + 37 / (14 / 11.75) * 3600000, 0);
    expect(fleetUsageReport(readFleetUsage(), now).pools['grok-ultra-weekly']).toEqual(result);
  });
  it('does not invent a 12h rate from old samples', () => {
    expect(usagePacing(pool(), now + 3600000).pointsPerHour12h).toBeNull();
  });
  it('handles flat use, missing samples, expired reset, future samples and a quota decrease', () => {
    const flat = pool(); flat.readings[1].pct = 49;
    expect(usagePacing(flat, now)).toMatchObject({ pointsPerHour: 0, throttle: false, projectedRunOutAt: null });
    expect(usagePacing({ ...pool(), readings: [] }, now).status).toBe('no-readings');
    expect(usagePacing(pool(), Date.parse(pool().resetAt))).toMatchObject({ status: 'reset-expired', throttle: false, paceNeeded: null });
    expect(usagePacing(pool(), now - 1).pointsPerHour).toBeNull();
    flat.readings[1].pct = 2;
    expect(usagePacing(flat, now).pointsPerHour).toBeNull();
  });
  it('throttles at the target even with one observation', () => {
    expect(usagePacing({ ...pool(), readings: [{ pct: 98, at: pool().readings[1].at }] }, now).throttle).toBe(true);
  });
  it('appends under a lock and preserves unrelated fleet fields', () => {
    addFleetUsage('grok-ultra-weekly', 64, '2026-10-26T14:15:00Z', '/tmp/fleet.json', now + 3600000);
    const saved = JSON.parse(io.write.mock.calls[0][2]);
    expect(saved.retained).toBe(true);
    expect(saved.usage['grok-ultra-weekly'].readings).toHaveLength(3);
    expect(io.release).toHaveBeenCalledOnce();
  });
  it.each([NaN, -1, 101])('rejects invalid percentage %s before accessing storage', pct => {
    expect(() => addFleetUsage('grok-ultra-weekly', pct, pool().readings[1].at, '/tmp/fleet.json', now)).toThrow();
    expect(io.write).not.toHaveBeenCalled();
  });
  it('refuses duplicate, future, unknown and ambiguous readings without writing', () => {
    expect(() => addFleetUsage('grok-ultra-weekly', 63, pool().readings[1].at, '/tmp/fleet.json', now)).toThrow('increasing');
    expect(() => addFleetUsage('grok-ultra-weekly', 63, '2026-10-26T13:16:00Z', '/tmp/fleet.json', now)).toThrow('future');
    expect(() => addFleetUsage('unknown', 63, pool().readings[1].at, '/tmp/fleet.json', now)).toThrow('Unknown');
    expect(() => addFleetUsage('grok-ultra-weekly', 63, '2026-10-26T13:16:00', '/tmp/fleet.json', now)).toThrow('timezone');
    expect(io.write).not.toHaveBeenCalled();
  });
  it('fails closed on corruption or lock contention', () => {
    io.read.mockReturnValue('{');
    expect(() => readFleetUsage()).toThrow();
    io.lock.mockReturnValue(null);
    expect(() => addFleetUsage('grok-ultra-weekly', 64, pool().readings[1].at, '/tmp/fleet.json', now)).toThrow('busy');
    expect(io.write).not.toHaveBeenCalled();
  });
  it('CLI emits one JSON contract and rejects invalid arguments', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdFleetUsage(['--json'])).toBe(0);
    expect(JSON.parse(log.mock.calls[0][0]).schemaVersion).toBe(1);
    expect(await cmdFleetUsage(['add', 'grok-ultra-weekly', 'bad', '--at', pool().readings[1].at])).toBe(2);
    expect(await cmdFleetUsage(['--typo'])).toBe(2);
  });
});
