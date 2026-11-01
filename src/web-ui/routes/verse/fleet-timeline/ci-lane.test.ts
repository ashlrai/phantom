import { describe, expect, it, vi, afterEach } from 'vitest';
import { ciLane, ciRunUrl } from './ci-lane.js';
import { ciRunsQuery } from './ci-runs-query.js';

const from = Date.parse('2026-11-01T01:00:00Z');
const to = Date.parse('2026-11-01T02:00:00Z');
const run = (runId: number, changes: Record<string, unknown> = {}) => ({
  runId, workflow: 'Checks', event: 'pull_request', headBranch: 'fake', prNumber: 12,
  conclusion: 'failure', status: 'completed', failureClass: 'bind-artifact',
  createdAt: '2026-11-01T01:30:00Z', url: `https://github.com/example/repo/actions/runs/${runId}`, ...changes,
});
const facts = {
  v: 1, generatedAt: '2026-11-01T02:00:00Z', repo: 'example/repo', windowHours: 1, available: true, reason: null,
  total: 5, byEvent: { pull_request: 3, push: 0, schedule: 1, merge_group: 0, workflow_dispatch: 1, other: 0 },
  byWorkflow: [{ name: 'Checks', total: 5, failed: 2 }], failures: { total: 2, bindArtifact: 1, code: 1, unclassified: 0 },
  daily: { runId: 2, conclusion: 'success', createdAt: '2026-11-01T01:40:00Z', failedJobs: [], url: 'https://github.com/example/repo/actions/runs/2' },
  recent: [run(1), run(2, { event: 'schedule', prNumber: null, conclusion: 'success', failureClass: null, createdAt: '2026-11-01T01:40:00Z' }),
    run(3, { conclusion: null, status: 'in_progress', failureClass: null }), run(4, { createdAt: 'bad' }), run(5, { createdAt: '2026-10-31T23:00:00Z' })],
};

describe('CI lane', () => {
  it('places in-window runs, preserves statuses and identifies the nightly run', () => {
    const result = ciLane(facts, from, to);
    expect(result.unplaced).toBe(1);
    expect(result.headline).toBe('5 runs · 2 failed (1 branch-behind, 1 code) · nightly green');
    expect(result.lane?.items).toEqual([
      { id: 'ci:1', label: 'CI #1 · Checks · pull_request · PR #12 · bind artifact', start: Date.parse('2026-11-01T01:30:00Z'), end: Date.parse('2026-11-01T01:31:00Z'), status: 'failed' },
      { id: 'ci:3', label: 'CI #3 · Checks · pull_request · PR #12', start: Date.parse('2026-11-01T01:30:00Z'), end: null, status: 'running' },
      { id: 'ci:2', label: 'Nightly · CI #2 · Checks · schedule', start: Date.parse('2026-11-01T01:40:00Z'), end: Date.parse('2026-11-01T01:41:00Z'), status: 'done' },
    ]);
    expect(ciRunUrl(facts, 'ci:1')).toBe('https://github.com/example/repo/actions/runs/1');
    expect(ciRunUrl({ ...facts, recent: [run(1, { url: 'javascript:alert(1)' })] }, 'ci:1')).toBeNull();
  });
  it('reports red and absent nightly runs without treating unfinished runs as successful', () => {
    expect(ciLane({ ...facts, daily: { ...facts.daily, conclusion: 'failure' } }, from, to).headline).toContain('nightly red');
    expect(ciLane({ ...facts, daily: null }, from, to).headline).toContain('nightly none');
    expect(ciLane({ ...facts, daily: { ...facts.daily, conclusion: null } }, from, to).headline).toContain('nightly none');
  });
  it('hides unavailable, incompatible and malformed responses', () => {
    for (const input of [null, { ...facts, available: false }, { ...facts, v: 2 }, { ...facts, recent: null }]) {
      expect(ciLane(input, from, to)).toEqual({ lane: null, unplaced: 0, headline: null });
    }
  });
});

afterEach(() => vi.unstubAllGlobals());
it('clamps and rounds query hours, and treats only 404 as unavailable', async () => {
  const fetch = vi.fn(async () => new Response(null, { status: 404 }));
  vi.stubGlobal('fetch', fetch);
  expect(await ciRunsQuery(0, 3_600_001).fetch()).toBeNull();
  expect(fetch).toHaveBeenCalledWith('/api/verse/fleet/ci-runs?hours=2', expect.anything());
  expect(ciRunsQuery(0, 0).key).toBe('verse-fleet-ci-runs:1');
  expect(ciRunsQuery(0, 999 * 3_600_000).key).toBe('verse-fleet-ci-runs:168');
  fetch.mockResolvedValueOnce(new Response(null, { status: 500 }));
  await expect(ciRunsQuery(0, 1).fetch()).rejects.toMatchObject({ status: 500 });
});
