import { describe, expect, it } from 'vitest';
import { dailyCiLine } from '../src/web-ui/routes/verse/fleet-releases/daily-ci-line.js';
import type { CiRunFactsV1 } from '../src/web-ui/routes/verse/fleet-releases/fleet-releases-queries.js';

const now = Date.parse('2026-11-01T12:00:00Z');
const facts = (): CiRunFactsV1 => ({
  v: 1, generatedAt: '2026-11-01T12:00:00Z', repo: 'ashlrai/phantom', windowHours: 48, available: true, reason: null, total: 1,
  byEvent: { pull_request: 0, push: 0, schedule: 1, merge_group: 0, workflow_dispatch: 0, other: 0 },
  byWorkflow: [], failures: { total: 0, bindArtifact: 0, code: 0, unclassified: 0 }, recent: [],
  daily: { runId: 1, conclusion: 'success', createdAt: '2026-11-01T06:00:00Z', failedJobs: [], url: 'https://github.com/ashlrai/phantom/actions/runs/1' },
});

describe('daily CI line', () => {
  it('reports a green run with its age and link', () => {
    expect(dailyCiLine(facts(), now)).toEqual({ tone: 'ok', text: 'Daily CI green, ran 6 h ago', detail: null, url: 'https://github.com/ashlrai/phantom/actions/runs/1' });
  });
  it('limits failing jobs to six and counts the rest', () => {
    const value = facts();
    value.daily!.conclusion = 'failure';
    value.daily!.failedJobs = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'];
    expect(dailyCiLine(value, now)).toMatchObject({ tone: 'bad', text: 'Daily CI red, ran 6 h ago', detail: 'Failing: A, B, C, D, E, F, +2 more' });
  });
  it('marks a run older than 36 hours stale', () => {
    const value = facts();
    value.daily!.createdAt = '2026-10-30T12:00:00Z';
    expect(dailyCiLine(value, now)).toMatchObject({ tone: 'stale', text: 'Daily CI has not run for 2 days', detail: null });
    value.daily!.createdAt = '2026-10-31T00:00:00Z';
    expect(dailyCiLine(value, now).tone).toBe('ok');
  });
  it('does not claim a result when facts or a completed result are unavailable', () => {
    const value = facts();
    expect(dailyCiLine(undefined, now).tone).toBe('none');
    value.available = false;
    expect(dailyCiLine(value, now).tone).toBe('none');
    value.available = true;
    value.daily = null;
    expect(dailyCiLine(value, now).tone).toBe('none');
    value.daily = facts().daily;
    value.daily!.conclusion = null;
    expect(dailyCiLine(value, now).tone).toBe('none');
  });
});
