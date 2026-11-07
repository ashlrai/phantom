import { describe, expect, it } from 'vitest';
import { memoryView } from '../src/core/fleet/memory-view.js';

const now = Date.parse('2026-11-06T12:00:00Z');
const observation = { schemaVersion: 1, observedAt: '2026-11-06T11:59:59Z', pressure: { state: 'normal', level: 1 }, censusState: 'known', sessionsState: 'known', sessions: [
  { jobId: 'RQ-1', state: 'known', processCount: 2, rssBytes: 1048576, cpuPercentOneCore: 250, cpuPercentHost: 25, swapBytes: null },
] };

describe('resource session evidence', () => {
  it('reports multicore OS averages and summed RSS with freshness', () => {
    expect(memoryView(null, null, now, observation).resource_session).toMatchObject({ state: 'fresh', age_ms: 1000, sessions: [{ cpuPercentOneCore: 250, cpuPercentHost: 25, rssBytes: 1048576 }] });
  });
  it('labels stale, future, absent and malformed evidence without granting a current reading', () => {
    expect(memoryView(null, null, now + 30001, observation).resource_session?.state).toBe('stale');
    expect(memoryView(null, null, now - 2000, observation).resource_session?.state).toBe('future');
    expect(memoryView(null, null, now, null).resource_session?.state).toBe('unknown');
    expect(memoryView(null, null, now, { ...observation, sessions: [...observation.sessions, observation.sessions[0]] }).resource_session?.state).toBe('unknown');
    expect(memoryView(null, null, now, { ...observation, sessions: [{ ...observation.sessions[0], swapBytes: 0 }] }).resource_session?.state).toBe('unknown');
  });
});


describe('resource observation continuity', () => {
  it('rejects coerced enums and contradictory row metrics', () => {
    for (const mutate of [
      { pressure: { state: ['normal'] } }, { censusState: ['known'] }, { sessionsState: ['known'] },
      { sessions: [{ ...observation.sessions[0], processCount: 0 }] },
      { sessions: [{ ...observation.sessions[0], rssBytes: null }] },
      { sessions: [{ ...observation.sessions[0], state: 'unknown' }] },
    ]) expect(memoryView(null, null, now, { ...observation, ...mutate }).resource_session?.state).toBe('unknown');
  });
  it('does not carry stale or future kernel/process facts as current', () => {
    for (const instant of [now + 60000, now - 2000]) {
      expect(memoryView(null, null, instant, observation).resource_session).toMatchObject({
        pressure: 'unknown', censusState: 'unknown', sessionsState: 'unknown', sessions: [],
      });
    }
  });
  it('ages disk history by the outer observation and refuses future attribution', () => {
    const input = { ...observation, disk: { state: 'history', allocatedBytes: 2048, ageSeconds: 0, provenance: 'historical allocated bytes' } };
    expect(memoryView(null, null, now + 60000, input).resource_session?.disk).toMatchObject({ state: 'stale', allocatedBytes: 2048, ageSeconds: 61 });
    expect(memoryView(null, null, now - 2000, input).resource_session?.disk).toEqual({ state: 'unknown', allocatedBytes: null, ageSeconds: null, provenance: null });
    expect(memoryView(null, null, now, { ...input, disk: { ...input.disk, ageSeconds: 900 } }).resource_session?.disk.state).toBe('stale');
  });
  it('keeps a fresh independently known empty inventory distinct from unknown', () => {
    expect(memoryView(null, null, now, { ...observation, sessions: [] }).resource_session).toMatchObject({ state: 'fresh', sessionsState: 'known', sessions: [] });
    expect(memoryView(null, null, now, { ...observation, sessionsState: 'unknown', sessions: [] }).resource_session?.sessionsState).toBe('unknown');
  });
});
