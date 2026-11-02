import { describe, expect, it } from 'vitest';
import { fixture, now } from './fleet-digest.test.js';
import { fleetDigest } from './fleet-digest.js';

describe('fleetDigest leaders', () => {
  it('shows the newest leader pass and its next ETA', () => {
    const digest = fleetDigest({ ...fixture, leaders: [
      { label: 'first', ageSeconds: 480 },
      { label: 'second', ageSeconds: 2400 },
      { label: 'unknown', ageSeconds: null },
      { label: 'invalid', ageSeconds: Infinity },
    ] }, now);
    expect(digest).toContain('Leaders: newest pass 8 min ago · next pass in ~7 min');
  });

  it('preserves the existing lines when leaders are missing', () => {
    const { leaders: _leaders, ...withoutLeaders } = fixture;
    const lines = fleetDigest(withoutLeaders, now).split('\n');
    expect(lines[0]).toContain('tick 40 s ago · HOLD on / paused');
    expect(lines.slice(1)).toEqual(['Lanes: codex-personal 8/24 (+4 q, held: reason)', 'Workers: 1 · oldest 38 min', 'Merged last hour: 3 · publishes: 1', 'Personal Codex: 46 % used, resets in 3 h', 'Claude lane: down token rejected', 'Inbox: last "hello" (Phantom desktop, 12 min ago)']);
    expect(lines.some((line) => line.startsWith('Leaders:'))).toBe(false);
  });

  it('omits leaders without a finite age', () => {
    expect(fleetDigest({ ...fixture, leaders: [{ label: 'unknown', ageSeconds: null }, { label: 'invalid', ageSeconds: NaN }] }, now)).not.toContain('Leaders:');
  });
});
