import { describe, expect, it } from 'vitest';
import { buildHomeDashboard, parseMergedSearch, type HomeSources } from '../src/core/home/dashboard.js';
import { renderHome } from '../src/cli/home.js';

const NOW = new Date('2026-10-13T12:00:00Z');
function src(over: Partial<HomeSources> = {}): HomeSources {
  return {
    now: () => NOW,
    mergedPrs: async () => ({ prs: [
      { repo: 'locus', number: 57, title: 'docs', url: 'u1', mergedAt: '2026-10-13T10:00:00Z', author: 'ashlr-fleet[bot]', openSeconds: 600 },
      { repo: 'lexicon', number: 25, title: 'release', url: 'u2', mergedAt: '2026-10-13T11:00:00Z', author: 'x', openSeconds: 1800 },
      { repo: 'old', number: 1, title: 'old', url: 'u3', mergedAt: '2026-10-10T11:00:00Z', author: 'x', openSeconds: 1 },
    ] }),
    runs: async () => ({ runs: [
      { id: 'r1', goal: 'fix red main', engine: 'claude', status: 'done', createdAt: '2026-10-13T09:00:00Z', updatedAt: '2026-10-13T09:10:00Z', tokens: 500_000, costUsd: 1 },
      { id: 'r2', goal: 'flaky hunt', engine: 'codex', status: 'running', createdAt: '2026-10-13T11:50:00Z', updatedAt: '2026-10-13T11:55:00Z', tokens: 500_000, costUsd: 1 },
      { id: 'r3', goal: 'broken', engine: 'codex', status: 'failed', createdAt: '2026-10-13T08:00:00Z', updatedAt: '2026-10-13T08:05:00Z', tokens: 0, costUsd: 0 },
    ] }),
    pendingProposals: async () => [{ id: 'p1', title: 'bump deps' }],
    onboardingNext: async () => 'ashlr ecosystem up',
    ...over,
  };
}

describe('home dashboard', () => {
  it('computes shipped, spend, value, running and needs-you for the window', async () => {
    const d = await buildHomeDashboard(src());
    expect(d.shipped.mergedPrs).toBe(2);
    expect(d.shipped.byRepo).toEqual({ locus: 1, lexicon: 1 });
    expect(d.spend).toMatchObject({ costUsd: 2, tokens: 1_000_000, runs: 3 });
    expect(d.value).toEqual({ mergesPerDollar: 1, mergesPerMillionTokens: 2, secondsPerMerge: 600, medianOpenToMergeSeconds: 1200 });
    expect(d.runningNow.map((r) => r.id)).toEqual(['r2']);
    expect(d.needsYou.map((a) => a.command)).toEqual(['ashlr inbox show p1', 'ashlr status r3', 'ashlr ecosystem up']);
    expect(renderHome(d, false)).toContain('PRs merged');
  });

  it('empty state when nothing happened and nothing is waiting', async () => {
    const d = await buildHomeDashboard(src({ mergedPrs: async () => ({ prs: [] }), runs: async () => ({ runs: [] }), pendingProposals: async () => [], onboardingNext: async () => null }));
    expect(d.empty).toBe(true);
    expect(renderHome(d, false)).toContain('ashlr ecosystem up');
  });

  it('a failing source becomes an actionable item, not a crash', async () => {
    const d = await buildHomeDashboard(src({ mergedPrs: async () => { throw new Error('gh: not logged in'); } }));
    expect(d.warnings[0]).toMatch(/not logged in/);
    expect(d.needsYou.some((a) => a.command === 'gh auth status')).toBe(true);
  });

  it('parses gh search output', () => {
    expect(parseMergedSearch(JSON.stringify([{ repository: { name: 'locus' }, number: 3, title: 't', url: 'u', closedAt: '2026-10-13T01:00:00Z', createdAt: '2026-10-13T00:00:00Z', author: { login: 'a' } }]))[0]).toMatchObject({ repo: 'locus', openSeconds: 3600 });
    expect(parseMergedSearch('nope')).toEqual([]);
  });
});
