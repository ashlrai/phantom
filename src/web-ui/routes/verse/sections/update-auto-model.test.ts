import { beforeEach, expect, it } from 'vitest';
import { decideAutoUpdate, readAutoUpdatePolicy, writeAutoUpdatePolicy, describeAutoDecision } from './update-auto-model.js';
import type { UpdateServerStatus } from './update-status-queries.js';
import type { Workers } from '../fleet/workers-card-model.js';
const facts: UpdateServerStatus = { v: 1, sourceState: 'healthy', installedVersion: null, headSha: 'aaaaaaa', headAt: null, originSha: 'bbbbbbb', branch: 'master', behind: 3, ahead: 0, dirty: false, lastFetchAt: null, processStartedAt: null, uptimeSeconds: 0, canFastForward: true };
const fleet: Workers = { v: 1, generatedAt: '', workers: [{ job: 'job123', repo: 'phantom', lane: 'work', tier: '1', ageSeconds: 900 }], publishesLastHour: [], sources: { workers: 'healthy' }, switches: [], paused: false, runsDir: '' };
const input = { policy: { enabled: true, quietMinutes: 10 }, status: facts, workers: fleet, nativePhase: undefined, lastAttempt: null, nowMs: 2_000_000 };
beforeEach(() => localStorage.clear());
it.each([
  ['off', { policy: { enabled: false, quietMinutes: 10 } }],
  ['no-status', { status: null }], ['no-status', { status: { ...facts, sourceState: 'degraded' } }],
  ['current', { status: { ...facts, behind: 0 } }],
  ['cannot-fast-forward', { status: { ...facts, canFastForward: false } }],
  ['dirty', { status: { ...facts, dirty: true } }], ['applying', { status: { ...facts, applying: { startedAt: '2026-01-01T00:00:00Z' } } }],
  ['native-busy', { nativePhase: 'downloading' }], ['native-busy', { nativePhase: 'installing' }],
  ['workers-unknown', { workers: null }], ['workers-unknown', { workers: { ...fleet, sources: { workers: 'missing' } } }],
  ['workers-unknown', { workers: { ...fleet, workers: [{ ...fleet.workers[0]!, ageSeconds: null }] } }],
  ['workers-active', { workers: { ...fleet, workers: [{ ...fleet.workers[0]!, ageSeconds: 120 }] } }],
  ['recent-attempt', { lastAttempt: { originSha: 'bbbbbbb', at: 1_999_999, outcome: 'failed' } }],
] satisfies Array<[string, Partial<Parameters<typeof decideAutoUpdate>[0]>]>)('waits: %s', (reason, changes) => {
  expect(decideAutoUpdate({ ...input, ...changes })).toMatchObject({ apply: false, reason });
});
it('accepts quiet, empty and boundary fleets, and expires attempts', () => {
  for (const workers of [fleet, { ...fleet, workers: [] }, { ...fleet, workers: [{ ...fleet.workers[0]!, ageSeconds: 600 }] }]) {
    expect(decideAutoUpdate({ ...input, workers }).apply).toBe(true);
  }
  expect(decideAutoUpdate({ ...input, lastAttempt: { originSha: 'bbbbbbb', at: 200_000, outcome: 'failed' } }).apply).toBe(true);
  expect(decideAutoUpdate({ ...input, lastAttempt: { originSha: 'ccccccc', at: input.nowMs, outcome: 'updated' } }).apply).toBe(true);
});
it('validates and persists policy', () => {
  expect(readAutoUpdatePolicy()).toEqual({ enabled: false, quietMinutes: 10 });
  localStorage.setItem('phantom.self-update.auto', '{bad');
  expect(readAutoUpdatePolicy().enabled).toBe(false);
  writeAutoUpdatePolicy({ enabled: true, quietMinutes: 10 });
  expect(readAutoUpdatePolicy().enabled).toBe(true);
  writeAutoUpdatePolicy({ enabled: true, quietMinutes: -1 });
  expect(readAutoUpdatePolicy().quietMinutes).toBe(10);
  expect(describeAutoDecision({ apply: false, reason: 'workers-active' }, fleet, 0)).toContain('youngest 15 min');
});
it('validates attempts and describes the persisted result without reading storage', async () => {
  const { readAutoUpdateAttempt, writeAutoUpdateAttempt } = await import('./update-auto-model.js');
  localStorage.setItem('phantom.self-update.auto.last', '{"originSha":"bad","at":0,"outcome":"updated"}');
  expect(readAutoUpdateAttempt()).toBeNull();
  const lastAttempt = { originSha: 'bbbbbbb', at: input.nowMs, outcome: 'updated' };
  expect(writeAutoUpdateAttempt(lastAttempt)).toBe(true);
  expect(readAutoUpdateAttempt()).toEqual(lastAttempt);
  const decision = decideAutoUpdate({ ...input, lastAttempt });
  localStorage.clear();
  expect(describeAutoDecision(decision, fleet, input.nowMs)).toMatch(/Last auto-update .* → bbbbbbb \(updated\)/);
});
