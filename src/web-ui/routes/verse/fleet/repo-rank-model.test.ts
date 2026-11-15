import { expect, test } from 'vitest';
import { scoreParts, type RepoRankState } from './repo-rank-model.js';

test('score parts reflect the weighted normalized evidence and seed prior', () => {
  const row = { repo: 'phantom', score: 0.75, weight: 0.4, recency: 2, leverage: 1 };
  const state: RepoRankState = { generatedAt: '2026-11-09T00:00:00Z', weights: { prior: 0.5, recency: 0.25, leverage: 0.25 }, rankings: [row, { repo: 'locus', score: 0, weight: 0.6, recency: 4, leverage: 2 }], proposals: [] };
  expect(scoreParts(state, row)).toEqual({ prior: 0.5, recency: 0.125, leverage: 0.125 });
  expect(scoreParts(state, { ...row, repo: 'other' }).prior).toBe(0);
});
