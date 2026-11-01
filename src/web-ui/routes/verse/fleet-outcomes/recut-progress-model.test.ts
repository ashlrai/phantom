import { describe, expect, it } from 'vitest';
import { recallRecut, recutProgress, rememberRecut } from './recut-progress-model.js';

const id = 'RECUT12341101';
const job = `RQ-PHX-${id}`;
const queuedAtMs = Date.parse('2026-11-01T00:00:00Z');
const nowMs = queuedAtMs + 180_000;
const progress = (runs: unknown, now = nowMs) => recutProgress({ id, runs, queuedAtMs, nowMs: now });

describe('recut progress', () => {
  it('uses published evidence before worker, claim and drop, and links only https', () => {
    const runs = { publishesLastHour: [{ job, url: 'https://github.com/ashlrai/phantom/pull/42' }], workers: [{ job, lane: 'other' }], claimed: [{ job }], drop: { pending: [{ file: `${job}.md` }] } };
    expect(progress(runs)).toEqual({ phase: 'published', text: 'published → PR #42', prUrl: 'https://github.com/ashlrai/phantom/pull/42' });
    for (const url of ['http://example.com/pull/42', 'javascript:alert(1)', null]) {
      expect(progress({ publishesLastHour: [{ job, url }] })).toEqual({ phase: 'published', text: 'published → Pull request', prUrl: null });
    }
  });
  it('prefers workers to claims, and formats claim age', () => {
    const claimed = [{ job, lane: 'claim-lane', at: '2026-11-01T00:01:00Z' }];
    expect(progress({ workers: [{ job, lane: 'codex-personal', ageSeconds: 120 }], claimed }).text).toBe('launched on codex-personal · 2 min ago');
    expect(progress({ claimed })).toEqual({ phase: 'launched', text: 'launched on claim-lane · 2 min ago', prUrl: null });
  });
  it('matches the exact drop filename before applying the missing threshold', () => {
    expect(progress({ drop: { pending: [{ file: `${job}.md` }] } }, queuedAtMs + 600_000)).toEqual({ phase: 'waiting', text: 'waiting in drop · 10 min', prUrl: null });
    expect(progress({ drop: { pending: [{ file: `${job}.md.bak` }] } }, queuedAtMs + 599_999)).toEqual({ phase: 'waiting', text: 'queued · waiting for ingest', prUrl: null });
    expect(progress(null, queuedAtMs + 600_000)).toEqual({ phase: 'missing', text: 'not seen for 10 min (ingest may have rejected it)', prUrl: null });
  });
  it('tolerates malformed readings and unknown ages', () => {
    expect(progress({ workers: [{ job, lane: 'codex-personal', ageSeconds: null }], drop: 'bad' }).text).toBe('launched on codex-personal');
    expect(progress({ workers: {}, claimed: null, publishesLastHour: 'bad' }).phase).toBe('waiting');
  });
});

describe('recut storage', () => {
  it('preserves recuts for multiple PRs and tolerates garbage and unavailable storage', () => {
    let contents = 'broken JSON';
    const storage = { getItem: () => contents, setItem: (_key: string, value: string) => { contents = value; } };
    expect(recallRecut(storage, '1234')).toBeNull();
    rememberRecut(storage, '1234', { id, queuedAtMs });
    rememberRecut(storage, 5678, { id: 'OTHER-RECUT', queuedAtMs });
    expect(recallRecut(storage, 5678)).toEqual({ id: 'OTHER-RECUT', queuedAtMs });
    expect(recallRecut(storage, '1234')).toEqual({ id, queuedAtMs });
    contents = JSON.stringify({ '1234': { id: 'bad', queuedAtMs: 'yesterday' } });
    expect(recallRecut(storage, '1234')).toBeNull();
    const unavailable = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
    expect(recallRecut(unavailable, '1234')).toBeNull();
    expect(() => rememberRecut(unavailable, '1234', { id, queuedAtMs })).not.toThrow();
  });
});
