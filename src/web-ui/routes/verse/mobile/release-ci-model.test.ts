import { describe, expect, it } from 'vitest';
import type { CiRunFactsV1 } from '../fleet-releases/fleet-releases-queries.js';
import { releaseCiRow } from './release-ci-model.js';

const now = Date.parse('2026-11-01T12:00:00Z');
function facts(daily: Partial<NonNullable<CiRunFactsV1['daily']>> = {}): CiRunFactsV1 {
  return {
    v: 1, generatedAt: '2026-11-01T12:00:00Z', repo: 'example/phantom', windowHours: 48, available: true, reason: null, total: 1,
    byEvent: { pull_request: 0, push: 0, schedule: 1, merge_group: 0, workflow_dispatch: 0, other: 0 },
    byWorkflow: [], failures: { total: 0, bindArtifact: 0, code: 0, unclassified: 0 }, recent: [],
    daily: { runId: 1, conclusion: 'success', createdAt: '2026-11-01T06:00:00Z', failedJobs: [], url: 'https://github.com/example/phantom/actions/runs/1', ...daily },
  };
}

describe('releaseCiRow', () => {
  it('maps a successful run', () => {
    expect(releaseCiRow(facts(), now)).toEqual({ title: 'Daily CI green, ran 6 h ago', tone: 'ok', href: 'https://github.com/example/phantom/actions/runs/1' });
  });
  it('includes failed jobs', () => {
    expect(releaseCiRow(facts({ conclusion: 'failure', failedJobs: ['build', 'test'] }), now)).toMatchObject({ title: 'Daily CI red, ran 6 h ago · Failing: build, test', tone: 'bad' });
  });
  it('mutes a stale run', () => {
    expect(releaseCiRow(facts({ createdAt: '2026-10-30T12:00:00Z' }), now)).toMatchObject({ title: 'Daily CI has not run for 2 days', tone: 'muted' });
  });
  it('omits missing and unfinished runs', () => {
    expect(releaseCiRow(undefined, now)).toBeNull();
    expect(releaseCiRow(facts({ conclusion: null }), now)).toBeNull();
  });
  it('rejects a non-GitHub host', () => {
    expect(releaseCiRow(facts({ url: 'https://example.com/run/1' }), now)?.href).toBeNull();
  });
});
