import { describe, expect, it } from 'vitest';
import { deriveFleetRunsNotifications as derive, usageHeldReason } from './deriveFleetRunsNotifications.js';

const now = Date.parse('2026-10-31T12:00:00Z');
const snapshot = (overrides: Record<string, unknown> = {}) => ({
  generatedAt: new Date(now).toISOString(), paused: false, claudeLane: 'healthy',
  lanes: [], workers: [{ ageSeconds: 60 }], mergesLastHour: { count: 0 },
  drop: null, events: [], ...overrides,
});
const heldLane = (lane: string, heldReason: string) => ({
  lane, heldReason, held: true, running: 0, target: 1, queued: 2,
});

describe('usage-held fleet lanes', () => {
  it('shows the personal Codex reset in Eastern time', () => {
    const out = derive(snapshot({ lanes: [heldLane('codex-personal', 'usage_limit')],
      codexPersonal: { resetsAt: '2026-11-04T06:41:00Z' } }), now);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'fleet-lane-usage-codex-personal', severity: 'high',
      title: 'codex-personal is out of usage', detail: 'Resumes Nov 4 01:41 ET',
      actionLabel: 'Open lanes', actionHref: expect.stringContaining('fleet-lanes') });
  });

  it('shows the scrubbed reason when a different provider runs out', () => {
    const out = derive(snapshot({ lanes: [heldLane('devin', `quota exceeded ${'x'.repeat(40)}`)] }), now);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'fleet-lane-usage-devin', severity: 'high',
      title: 'devin is out of usage', detail: 'Held: quota exceeded …' });
  });

  it.each([undefined, null, {}, { resetsAt: null }, { resetsAt: 'invalid' }])(
    'falls back to the reason when reset data is unavailable: %j', (codexPersonal) => {
      const out = derive(snapshot({ lanes: [heldLane('codex-personal', 'usage_limit')], codexPersonal }), now);
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ id: 'fleet-lane-usage-codex-personal', detail: 'Held: usage_limit' });
    },
  );

  it('preserves the existing incident for other holds', () => {
    const out = derive(snapshot({ lanes: [heldLane('devin', 'operator pause')] }), now);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ id: 'fleet-lane-held-devin', severity: 'medium',
      title: 'devin lane is held', detail: 'operator pause' });
  });

  it.each(['usage_limit', 'Usage Limit', 'usage-limit', 'usagelimit', 'out of usage',
    'quota exceeded', 'rate limit', 'rate-limit', 'ratelimit', 'weekly limit'])(
    'recognizes usage reason %s', (reason) => expect(usageHeldReason(reason)).toBe(true),
  );
  it.each([null, '', 'operator pause', 'waiting for credits'])(
    'does not classify %s as a usage reason', (reason) => expect(usageHeldReason(reason)).toBe(false),
  );
});
