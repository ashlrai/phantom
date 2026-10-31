import { describe, expect, it } from 'vitest';
import { readLeaderPasses } from './leader-passes-model.js';

const now = Date.parse('2026-10-31T12:00:00Z');
const snapshot = (overrides: Record<string, unknown> = {}) => ({
  generatedAt: new Date(now).toISOString(), sources: { workers: 'healthy', runsDir: 'healthy' },
  leaders: [], orchestratorAgents: 3, lastTick: new Date(now - 120_000).toISOString(), paused: false, claudeLane: null, ...overrides,
});

describe('leader passes', () => {
  it('reads active passes and advances their ages from the snapshot', () => {
    const value = readLeaderPasses(snapshot({ leaders: [{ label: 'opus-leader', ageSeconds: 240 }, { label: 'sol-leader', ageSeconds: 60 }] }), now);
    expect(value).toMatchObject({ headline: 'Leaders active', tone: 'running', agents: 3, lastTick: { text: '2 min ago', ageMinutes: 2 },
      passes: [{ label: 'opus-leader', age: '4m 00s' }, { label: 'sol-leader', age: '1m 00s' }] });
    expect(readLeaderPasses(snapshot({ leaders: [{ label: 'opus-leader', ageSeconds: 240 }] }), now + 60_000).passes[0]?.age).toBe('5m 00s');
  });
  it('distinguishes quiet, between passes and invalid ticks', () => {
    expect(readLeaderPasses(snapshot({ lastTick: new Date(now - 35 * 60_000).toISOString() }), now)).toMatchObject({ headline: 'Leaders quiet for 35 min', tone: 'warning' });
    expect(readLeaderPasses(snapshot(), now).headline).toBe('Between passes');
    for (const lastTick of ['invalid', null, new Date(now + 60_000).toISOString()]) {
      expect(readLeaderPasses(snapshot({ lastTick }), now)).toMatchObject({ headline: '—', lastTick: { text: '—', ageMinutes: null } });
    }
  });
  it('does not infer quiet from missing or degraded workers or malformed leaders', () => {
    for (const workers of ['degraded', 'missing', undefined]) {
      expect(readLeaderPasses(snapshot({ sources: { workers }, lastTick: new Date(now - 35 * 60_000).toISOString() }), now)).toMatchObject({ headline: '—', tone: 'neutral' });
    }
    expect(readLeaderPasses(snapshot({ leaders: null }), now).headline).toBe('—');
  });
  it('reports pause and detects a down lane without exposing diagnostics in labels', () => {
    const result = readLeaderPasses(snapshot({ paused: true, claudeLane: 'down token rejected 2026-10-31 01:03', leaders: [{ label: '/private/opus-leader', ageSeconds: null }] }), now);
    expect(result).toMatchObject({ headline: 'Paused', claudeLane: { down: true }, passes: [{ label: 'opus-leader', age: '—' }] });
    expect(readLeaderPasses(snapshot({ leaders: [{ label: 'a prompt with spaces', ageSeconds: -1 }], orchestratorAgents: -1 }), now)).toMatchObject({ passes: [{ label: '—', age: '—' }], agents: null });
  });
});
