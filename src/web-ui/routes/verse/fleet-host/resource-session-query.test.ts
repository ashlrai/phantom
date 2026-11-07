import { describe, expect, it } from 'vitest';
import { memoryView } from '../../../../core/fleet/memory-view.js';
import { narrowFleetMemory } from './memory-guard-query.js';

const now = Date.parse('2026-11-06T12:00:00Z');
const payload = () => ({ v: 1, generatedAt: new Date(now).toISOString(), memory: memoryView(null, null, now, {
  schemaVersion: 1, observedAt: '2026-11-06T11:59:59Z', pressure: { state: 'normal', level: 1 }, censusState: 'known', sessionsState: 'known',
  sessions: [{ jobId: 'RQ-1', state: 'known', processCount: 2, rssBytes: 1024, cpuPercentOneCore: 250, cpuPercentHost: 25, swapBytes: null, privateValue: 'discard' }],
  disk: { state: 'stale', allocatedBytes: 500, ageSeconds: 300, provenance: 'synthetic fixture' },
}) });
describe('session transport', () => {
  it('retains stale disk history and strips unrecognized process data', () => {
    const data = narrowFleetMemory(payload());
    expect(data?.memory.resource_session?.disk.state).toBe('stale');
    expect(data?.memory.resource_session?.sessions[0]).not.toHaveProperty('privateValue');
  });
  it('rejects malformed session transport', () => {
    const data = payload();
    (data.memory.resource_session!.sessions[0] as unknown as { cpuPercentOneCore: unknown }).cpuPercentOneCore = 'bad';
    expect(narrowFleetMemory(data)).toBeNull();
  });
});


it('rejects primitive-enum coercion, null known metrics, duplicates and invalid disk values', () => {
  const mutate = (change: (value: ReturnType<typeof payload>) => void) => { const value = payload(); change(value); expect(narrowFleetMemory(value)).toBeNull(); };
  mutate(value => { Object.assign(value.memory.resource_session!, { pressure: ['normal'] }); });
  mutate(value => { Object.assign(value.memory.resource_session!, { censusState: ['known'] }); });
  mutate(value => { Object.assign(value.memory.resource_session!.sessions[0]!, { state: ['known'] }); });
  mutate(value => { value.memory.resource_session!.sessions[0]!.rssBytes = null; });
  mutate(value => { value.memory.resource_session!.sessions[0]!.cpuPercentOneCore = null; });
  mutate(value => { value.memory.resource_session!.sessions[0]!.processCount = 0; });
  mutate(value => { value.memory.resource_session!.sessions[0]!.processCount = 1.5; });
  mutate(value => { value.memory.resource_session!.sessions[0]!.state = 'unknown'; });
  mutate(value => { value.memory.resource_session!.sessions.push({ ...value.memory.resource_session!.sessions[0]! }); });
  mutate(value => { value.memory.resource_session!.disk.allocatedBytes = null; });
  mutate(value => { value.memory.resource_session!.disk.ageSeconds = -1; });
  mutate(value => { Object.assign(value.memory.resource_session!.disk, { state: ['stale'] }); });
});

it('requires stale/future transport to contain no current process or pressure claim', () => {
  for (const state of ['stale', 'future']) {
    const data = payload();
    Object.assign(data.memory.resource_session!, { state, age_ms: state === 'stale' ? 61000 : -1000 });
    expect(narrowFleetMemory(data)).toBeNull();
  }
});
