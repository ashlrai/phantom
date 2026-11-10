import { expect, it } from 'vitest';
import {
  planWriteBudget, writeBudgetBriefLines, writeBudgetLanesFromStatus, QUEUE_IGNORED_LANES,
  type WriteBudgetLaneInput,
} from '../src/core/fleet/planner-write-budget.js';

const lane = (over: Partial<WriteBudgetLaneInput>): WriteBudgetLaneInput =>
  ({ lane: 'x', running: 0, target: 0, queued: 0, held: false, ...over });
const plan = (lanes: WriteBudgetLaneInput[], claudeLane = 'ok') => planWriteBudget(lanes, { claudeLane });

it('ignores queued for devin and codex-local and covers every reason', () => {
  const { rows, total } = plan([
    lane({ lane: 'devin', target: 2, queued: 184 }),                    // open, queued ignored
    lane({ lane: 'codex-local', target: 1, queued: 50 }),               // open, queued ignored
    lane({ lane: 'codex-personal', target: 4, queued: 22 }),            // queued-covers
    lane({ lane: 'gemini', target: 3, held: true }),                    // held
    lane({ lane: 'claude', target: 6, running: 4, queued: 1 }),         // open: free 2 - queued 1
    lane({ lane: 'grok', target: 2, running: 2 }),                      // at-target
    lane({ lane: 'zero' }),                                             // no-target
  ], 'ok 2026-11-04 07:30:53');
  expect(rows.map(r => [r.lane, r.budget, r.reason])).toEqual([
    ['devin', 2, 'open'],
    ['codex-local', 1, 'open'],
    ['codex-personal', 0, 'queued-covers'],
    ['gemini', 0, 'held'],
    ['claude', 1, 'open'],
    ['grok', 0, 'at-target'],
    ['zero', 0, 'no-target'],
  ]);
  expect(rows.map(r => r.free)).toEqual([2, 1, 4, 3, 2, 0, 0]);
  expect(total).toBe(4);
});

it('marks the claude lane down unless claude-lane.state starts ok or ready', () => {
  const claude = lane({ lane: 'claude', target: 4 });
  for (const state of ['ok', 'ok 2026-11-04 07:30:53', 'ready', 'READY now', 'Ok']) {
    expect(plan([claude], state).rows[0]).toMatchObject({ budget: 4, reason: 'open' });
  }
  for (const state of ['down token rejected', 'okay', 'readiness', 'unknown', '']) {
    expect(plan([claude], state).rows[0]).toMatchObject({ budget: 0, reason: 'claude-down' });
  }
  // Only the lane named claude is gated; other lanes are unaffected.
  expect(plan([lane({ lane: 'other', target: 2 })], 'down').rows[0]).toMatchObject({ budget: 2, reason: 'open' });
  // Claude-down outranks at-target and queued-covers but not held/no-target.
  expect(plan([lane({ lane: 'claude', target: 4, running: 9 })], 'down').rows[0]!.reason).toBe('claude-down');
  expect(plan([lane({ lane: 'claude', target: 4, held: true })], 'down').rows[0]!.reason).toBe('held');
});

it('normalizes negative and non-finite counts to zero', () => {
  const { rows, total } = plan([
    lane({ lane: 'a', running: -3, target: Number.NaN, queued: -1 }),   // all zero → no-target
    lane({ lane: 'b', running: Number.NaN, target: 4, queued: Infinity }),// free 4, queued 0 → open
    lane({ lane: 'c', running: 2, target: -5 }),                        // target 0 → no-target
    lane({ lane: 'd', running: Infinity, target: 3 }),                  // running 0 → open
  ]);
  expect(rows.map(r => [r.running, r.target, r.queued])).toEqual([[0, 0, 0], [0, 4, 0], [2, 0, 0], [0, 3, 0]]);
  expect(rows.map(r => r.reason)).toEqual(['no-target', 'open', 'no-target', 'open']);
  expect(total).toBe(7);
});

it('keeps input order, honors a custom queueIgnored list and caps queued at free', () => {
  const { rows } = plan([
    lane({ lane: 'b', target: 5, queued: 3 }),
    lane({ lane: 'a', target: 5, queued: 99 }),
    lane({ lane: 'c', target: 5, queued: 5 }),
  ]);
  expect(rows.map(r => [r.lane, r.budget, r.reason])).toEqual([['b', 2, 'open'], ['a', 0, 'queued-covers'], ['c', 0, 'queued-covers']]);
  const custom = planWriteBudget([lane({ lane: 'devin', target: 2, queued: 9 })], { claudeLane: 'ok', queueIgnored: [] });
  expect(custom.rows[0]).toMatchObject({ budget: 0, reason: 'queued-covers' });
});

it('renders one line per lane plus a total', () => {
  const lines = writeBudgetBriefLines(plan([
    lane({ lane: 'devin', target: 2, queued: 184 }),
    lane({ lane: 'codex-personal', target: 4, queued: 22 }),
    lane({ lane: 'gemini', target: 3, held: true }),
    lane({ lane: 'claude', target: 6, running: 2 }),
    lane({ lane: 'grok', target: 0 }),
    lane({ lane: 'full', target: 1, running: 1 }),
    lane({ lane: 'some', target: 4, queued: 1 }),
  ], 'down'));
  expect(lines).toEqual([
    'devin 2 (free 2, queued ignored)',
    'codex-personal 0 (free 4, queued 22 covers it)',
    'gemini 0 (held)',
    'claude 0 (claude lane down)',
    'grok 0 (no target)',
    'full 0 (at target)',
    'some 3 (free 4, queued 1)',
    'total 5',
  ]);
});

it('parses queue/status.json lanes strictly and scrubs nothing else', () => {
  expect(writeBudgetLanesFromStatus({ lanes: { a: { running: 1, target: 2, queued: 3, held: true }, b: {} } }))
    .toEqual([
      { lane: 'a', running: 1, target: 2, queued: 3, held: true },
      { lane: 'b', running: 0, target: 0, queued: 0, held: false },
    ]);
  for (const bad of [null, '{', [], { lanes: 4 }, { lanes: { a: 7 } }, { lanes: { a: [] } }]) {
    expect(() => writeBudgetLanesFromStatus(bad)).toThrow();
  }
  expect(QUEUE_IGNORED_LANES).toEqual(['devin', 'codex-local']);
});
