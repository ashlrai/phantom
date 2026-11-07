import { describe, expect, it } from 'vitest';
import { claudeLaneNote, dropRows, formatPulseAge, leaderRows, pulseHeadline, readLeaderPulse, STALE_LEADER_MS, type LeaderPulseInput } from './leader-pulse-model.js';

const now = Date.parse('2026-10-31T12:00:00Z');
const fixture: LeaderPulseInput = {
  v: 1, generatedAt: '2026-10-31T12:00:00Z', lastTick: '2026-10-31T11:59:00Z', paused: false,
  claudeLane: null, leaders: [{ label: 'one', ageSeconds: 240 }, { label: 'unknown', ageSeconds: null }],
  orchestratorAgents: 12, drop: { pending: [], done: 12 }, sources: { runsDir: 'healthy' },
};

describe('leader pulse model', () => {
  it('strictly narrows the snapshot and preserves nulls', () => {
    expect(readLeaderPulse(fixture)).toEqual(fixture);
    expect(readLeaderPulse({ ...fixture, lastTick: null, paused: null, orchestratorAgents: null, drop: null })).not.toBeNull();
    for (const bad of [null, {}, { ...fixture, v: 2 }, { ...fixture, generatedAt: 'bad' },
      { ...fixture, lastTick: 'bad' }, { ...fixture, paused: 0 }, { ...fixture, claudeLane: 1 },
      { ...fixture, leaders: [{ label: 'x', ageSeconds: -1 }] }, { ...fixture, leaders: [{ label: 'x' }] },
      { ...fixture, orchestratorAgents: 1.5 }, { ...fixture, drop: { pending: [{ lane: 'x' }], done: 0 } },
      { ...fixture, sources: { runsDir: 'other' } }]) expect(readLeaderPulse(bad)).toBeNull();
  });

  it('ages passes from the snapshot and marks the exact threshold stale', () => {
    const input = { ...fixture, leaders: [{ label: 'near', ageSeconds: 1199 }, { label: 'at', ageSeconds: 1200 }, { label: 'none', ageSeconds: null }] };
    expect(leaderRows(input, now)).toEqual([
      { label: 'near', ageMs: STALE_LEADER_MS - 1000, tone: 'good' },
      { label: 'at', ageMs: STALE_LEADER_MS, tone: 'warn' },
      { label: 'none', ageMs: null, tone: 'unknown' },
    ]);
    expect(leaderRows(input, now + 1000)[0].tone).toBe('warn');
    expect(formatPulseAge(null)).toBe('—');
  });

  it('groups sorted lanes and strips both kinds of directory separators', () => {
    const input = { ...fixture, drop: { done: 2, pending: [
      { lane: 'z', file: '/private/path/one.json' }, { lane: 'a', file: 'C:\\jobs\\two.json' }, { lane: 'a', file: 'three.json' },
    ] } };
    expect(dropRows(input)).toEqual([{ lane: 'a', pending: 2, files: ['two.json', 'three.json'] }, { lane: 'z', pending: 1, files: ['one.json'] }]);
  });

  it('only returns down lane notes', () => {
    expect(claudeLaneNote('Down for repair')).toBe('Down for repair');
    expect(claudeLaneNote('up, previously down')).toBeNull();
    expect(claudeLaneNote(null)).toBeNull();
  });

  it('omits unknown headline parts and prefixes a paused dispatcher', () => {
    expect(pulseHeadline(fixture, now)).toBe('2 leaders, newest pass 4 min ago · 12 agents · tick 1 min ago');
    expect(pulseHeadline({ ...fixture, paused: true, leaders: [{ label: 'x', ageSeconds: null }], orchestratorAgents: null, lastTick: null }, now)).toBe('Dispatcher paused · 1 leader');
  });
});
