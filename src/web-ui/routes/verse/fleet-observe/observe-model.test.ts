import { expect, it } from 'vitest';
import type { UsageRow } from '../fleet-usage/usage-pane-model.js';
import { heldIncidents, readComms, readGauges, readLanes, readMerges, readSessions } from './observe-model.js';

const runs = {
  lanes: [
    { lane: 'claude', running: 2, target: 3, queued: 1, held: false, heldReason: null, tokensLastHour: 1200 },
    { lane: 'devin', running: 1, target: 1, queued: 0, held: true, heldReason: 'quota', tokensLastHour: null },
  ],
  workers: [
    { job: 'job-young', repo: 'a/b', lane: 'claude', tier: 'work', ageSeconds: 300 },
    { job: 'job-old', repo: 'a/b', lane: 'claude', tier: 'work', ageSeconds: 40 * 60 },
    { job: 'job-held', repo: 'a/c', lane: 'devin', tier: 'work', ageSeconds: null },
    { job: 'bad job' },
  ],
  claimed: [{ job: 'job-young', lane: 'claude', tier: 'work', at: 'x' }, { job: 'job-next', lane: 'claude', tier: 'work', at: 'x' }],
  mergesLastHour: { items: [
    { repo: 'a/b', number: 1, title: 'old', mergedAt: '2026-01-01T00:00:00Z' },
    { repo: 'a/b', number: 2, title: 'new', mergedAt: '2026-01-01T00:30:00Z' },
    { repo: '../x', number: 3, title: 'bad repo', mergedAt: null },
    { repo: 'a/b', number: 0, title: 'bad number' },
  ] },
};

it('lists every session across lanes, oldest first, with lane tokens and a typical-length ETA', () => {
  const rows = readSessions(runs);
  expect(rows.map((r) => [r.job, r.status])).toEqual([['job-old', 'running'], ['job-young', 'running'], ['job-held', 'held'], ['job-next', 'claimed']]);
  expect(rows[0]).toMatchObject({ ageState: 'long', etaMinutes: null, laneTokensLastHour: 1200 });
  expect(rows[1].etaMinutes).toBe(10);
  expect(rows[2]).toMatchObject({ ageSeconds: null, etaMinutes: null, laneTokensLastHour: null });
});

it('keeps unknown readings null and tolerates garbage', () => {
  expect(readSessions(null)).toEqual([]);
  expect(readLanes('x')).toEqual([]);
  expect(readMerges(undefined)).toEqual([]);
});

it('orders merges newest first and only links well-formed repos', () => {
  const merges = readMerges(runs);
  expect(merges.map((m) => m.id)).toEqual(['a/b#2', 'a/b#1', '../x#3']);
  expect(merges[0].url).toBe('https://github.com/a/b/pull/2');
  expect(merges[2].url).toBeNull();
});

it('turns provider windows into toned gauges', () => {
  const win = (label: string, usedPercent: number | null, limitReached = false) => ({ label, usedPercent, resetsAt: null, resetDescription: null, limitReached, measured: usedPercent !== null });
  const rows = [{ id: 'c', label: 'Claude', windows: [win('Weekly', 50), win('Opus', 80), win('Sonnet', 95), win('Unread', null), win('Cap', 10, true)] }] as unknown as UsageRow[];
  expect(readGauges(rows).map((g) => g.tone)).toEqual(['ok', 'warn', 'danger', 'ok', 'danger']);
  expect(readGauges(rows)[3].usedPercent).toBeNull();
});

it('splits bus traffic into comms and CI incidents', () => {
  const msg = (cursor: number, body: unknown) => ({ cursor, receivedAt: 1, envelope: { id: `m${cursor}`, from: 'a', to: 'b', priority: 'P2', ttl: 1000, body } });
  const page = { v: 1, status: 'ok', nextCursor: 3, messages: [msg(1, { text: 'hello' }), msg(2, { kind: 'ci.failed-scheduled-run', repo: 'a/b', runId: 7, workflow: 'CI' })] };
  const { comms, incidents } = readComms(page);
  expect(comms).toHaveLength(1);
  expect(comms[0].text).toContain('hello');
  expect(incidents[0].url).toBe('https://github.com/a/b/actions/runs/7');
  expect(readComms('nope')).toEqual({ comms: [], incidents: [] });
});

it('reports held lanes as incidents with their own reason', () => {
  expect(heldIncidents(readLanes(runs))).toEqual(['devin held: quota']);
});
