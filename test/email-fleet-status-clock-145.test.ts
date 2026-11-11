import { describe, expect, it } from 'vitest';
import { emailFleetStatus, type EmailFleetStatusReaders } from '../src/core/comms/email-fleet-status.js';

const readers: EmailFleetStatusReaders = {
  runs: async () => ({
    sources: { status: 'healthy' }, paused: false,
    lanes: [{ lane: '/private/message', running: 2, target: 3, queued: 1, held: true }],
  }) as Awaited<ReturnType<NonNullable<EmailFleetStatusReaders['runs']>>>,
  workers: async () => { throw new Error('/private/worker message contents'); },
  supply: async () => ({
    v: 1, sourceState: 'healthy', lanes: [{ lane: 'devin', phxReady: 4, fillerReady: 1 }],
    planner: { status: 'unknown', lastGoodPassAt: null, reason: '/private/arbitrary' },
  }),
  readQuota: () => { throw new Error('/private/quota'); },
};

describe('email fleet status clock failures', () => {
  it.each([
    ['invalid date', () => new Date(NaN)],
    ['throwing clock', () => { throw new Error('/private/clock message contents'); }],
  ])('preserves safe independent evidence with an %s', async (_name, clock) => {
    const body = await emailFleetStatus(undefined, clock, readers);
    expect(body).toContain('Phantom fleet status (unavailable)');
    expect(body).toContain('running: 2');
    expect(body).toContain('Supply: devin 4 phantom / 1 filler');
    expect(body).toContain('Live workers: unavailable');
    expect(body).toContain('Quota: unavailable');
    expect(body).toContain('Planner: unknown (unavailable)');
    expect(body.length).toBeLessThan(2000);
    expect(body).not.toMatch(/private|message contents|arbitrary|RangeError/);
  });

  it('marks default time-dependent readers unavailable without a clock', async () => {
    const body = await emailFleetStatus(undefined, () => new Date(NaN));
    expect(body).toContain('Runs status: unavailable');
    expect(body).toContain('Live workers: unavailable');
    expect(body).toContain('Quota: unavailable');
    expect(body).toContain('Supply: unavailable');
  });

  it('retains the fixed timestamp and the same projections for a valid clock', async () => {
    const body = await emailFleetStatus(undefined, () => new Date('2026-11-11T12:00:00.000Z'), readers);
    expect(body).toContain('Phantom fleet status (2026-11-11T12:00:00.000Z)');
    expect(body).toContain('running: 2');
    expect(body).toContain('Live workers: unavailable');
    expect(body).toContain('Supply: devin 4 phantom / 1 filler');
  });
});
