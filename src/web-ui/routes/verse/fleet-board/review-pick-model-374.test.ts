/** RQ-PHX-REVIEWPICKSTRIP374 — review-pick body parser. Fake repos/PRs only. */
import { expect, it } from 'vitest';
import { parseReviewPickBody, type ReviewPickFound } from './review-pick-model.js';

const picked = (over: Record<string, unknown> = {}) => ({
  repo: 'example/phantom', pr: 42, head: 'review/fake', head_sha: 'a'.repeat(40),
  title: 'Fake review task', owner: 'none', reason: 'no live claim names it', ...over,
});

const body = (over: Record<string, unknown> = {}) => ({
  schema: 'fleet.review-pick.v1', as_of: '2026-11-14T18:00:00.000Z', repo: 'example/phantom',
  source: {
    prs: 'read',
    claims: { 'claimed-tsv': 'read', 'bus-work-claims': 'read', coordination: 'read', 'live-workers': 'read' },
    unavailable: [],
  },
  picked: picked(), reason: 'no live claim names it', skipped: [], unowned_candidates: 1, ...over,
});

it('parses a valid pick with a short sha and github link', () => {
  const r = parseReviewPickBody(body());
  expect(r).toEqual({
    kind: 'pick', repo: 'example/phantom', pr: 42, head: 'review/fake',
    headShort: 'aaaaaaa', title: 'Fake review task', asOf: '2026-11-14T18:00:00.000Z',
    candidates: 1, prUrl: 'https://github.com/example/phantom/pull/42',
  });
});

it('parses none with the reason and unavailable sources', () => {
  const r = parseReviewPickBody(body({
    picked: null, reason: 'ownership source unavailable', unowned_candidates: 3,
    source: { prs: 'read', claims: {}, unavailable: ['coordination', 'live-workers'] },
  }));
  expect(r).toEqual({
    kind: 'none', reason: 'ownership source unavailable',
    asOf: '2026-11-14T18:00:00.000Z', unavailable: ['coordination', 'live-workers'],
  });
});

it('treats wrong schema and malformed bodies as unavailable, not empty', () => {
  for (const b of [
    null, 'x', 42, {},
    body({ schema: 'fleet.review-pick.v2' }),
    body({ schema: 'fleet.review-pick.v0' }),
    body({ as_of: 5 }),
    body({ unowned_candidates: 'one' }),
    body({ unowned_candidates: -1 }),
    body({ picked: undefined }),
    body({ picked: 'PR-42' }),
    body({ picked: picked({ pr: '42' }) }),
    body({ picked: picked({ pr: 4.2 }) }),
    body({ picked: picked({ pr: 0 }) }),
    body({ picked: picked({ title: 7 }) }),
    body({ picked: picked({ head: null }) }),
    body({ picked: picked({ head_sha: {} }) }),
  ]) {
    expect(parseReviewPickBody(b)).toEqual({ kind: 'unavailable' });
  }
});

it('truncates an oversized title to 120 chars', () => {
  const r = parseReviewPickBody(body({ picked: picked({ title: 't'.repeat(300) }) }));
  expect(r.kind).toBe('pick');
  const title = (r as ReviewPickFound).title;
  expect(title).toHaveLength(120);
  expect(title.endsWith('…')).toBe(true);
});

it('rejects an owner other than the literal none', () => {
  for (const owner of ['codex-local', 'devin', '', 0, null]) {
    expect(parseReviewPickBody(body({ picked: picked({ owner }) }))).toEqual({ kind: 'unavailable' });
  }
});

it('keeps the pick but drops the link on a bad repo shape', () => {
  for (const repo of ['not a repo', '../escape', 'https://evil.example/x', 'example/', '/phantom']) {
    const r = parseReviewPickBody(body({ picked: picked({ repo }) }));
    expect(r.kind).toBe('pick');
    expect((r as ReviewPickFound).prUrl).toBeNull();
  }
});

it('reports none with a recorded reason even when reason is absent', () => {
  const r = parseReviewPickBody(body({ picked: null, reason: undefined }));
  expect(r).toEqual({ kind: 'none', reason: 'no reason recorded', asOf: '2026-11-14T18:00:00.000Z', unavailable: [] });
});
