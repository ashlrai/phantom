import { describe, expect, it } from 'vitest';
import { plannerLine } from './planner-plan-model.js';
import type { PlannerPlanView } from './planner-plan-queries.js';

// Oct 31 2026 18:00 ET — "last ok 12 min ago" and "Nov 7 15:16" pin the fixtures.
const nowMs = Date.parse('2026-10-31T22:00:00Z');
const PATH = '~/.ashlr-runs/queue/planner-candidates.json';
const plan = (over: Partial<PlannerPlanView>): PlannerPlanView => ({
  v: 1,
  generatedAt: new Date(nowMs).toISOString(),
  path: PATH,
  source: 'ok',
  choice: null,
  nextResetAt: null,
  limited: [],
  health: [],
  ...over,
});
const healthRow = (over: Partial<PlannerPlanView['health'][number]>) => ({
  provider: 'codex-personal',
  status: 'ok',
  failingSince: null,
  lastGoodPassAt: null,
  resetAt: null,
  reason: null,
  ...over,
});

describe('plannerLine', () => {
  it('names the next pass login with its health when one can run', () => {
    const lastGoodPassAt = new Date(nowMs - 12 * 60_000).toISOString();
    expect(plannerLine(plan({
      choice: { provider: 'codex-personal', reason: 'ok' },
      health: [healthRow({ lastGoodPassAt })],
    }), nowMs)).toEqual({ text: 'Next planner pass: codex-personal (healthy, last ok 12 min ago).', tone: 'ok' });
  });

  it('says why no planner can run when every candidate is limited', () => {
    expect(plannerLine(plan({
      limited: [
        { provider: 'codex-personal', status: 'usage-limit', until: '2026-11-07T15:16:00-05:00' },
        { provider: 'claude-api', status: 'failing', until: null },
      ],
      nextResetAt: '2026-11-07T20:16:00.000Z',
    }), nowMs)).toEqual({
      text: 'No planner can run: codex-personal limited until Nov 7 15:16, claude-api failing. Fix the executor or add a candidate.',
      tone: 'bad',
    });
  });

  it('names the missing candidates file', () => {
    expect(plannerLine(plan({ source: 'missing' }), nowMs))
      .toEqual({ text: `Planner candidates file missing: ${PATH}.`, tone: 'warn' });
    expect(plannerLine(plan({ source: 'invalid' }), nowMs))
      .toEqual({ text: `Planner candidates file invalid: ${PATH}.`, tone: 'warn' });
  });

  it('is null when the route is absent', () => {
    expect(plannerLine(null, nowMs)).toBeNull();
    expect(plannerLine(undefined, nowMs)).toBeNull();
  });

  it('marks a limited pick without an advertised reset and an empty slate', () => {
    expect(plannerLine(plan({ limited: [{ provider: 'sol', status: 'usage-limit', until: null }] }), nowMs))
      .toEqual({ text: 'No planner can run: sol limited. Fix the executor or add a candidate.', tone: 'bad' });
    expect(plannerLine(plan({}), nowMs))
      .toEqual({ text: 'No planner can run: no planner logins are configured. Fix the executor or add a candidate.', tone: 'bad' });
  });

  it('warns when the chosen login has no healthy reading', () => {
    expect(plannerLine(plan({
      choice: { provider: 'claude-api', reason: 'unread' },
      health: [healthRow({ status: 'failing', reason: 'usage-limit' })],
    }), nowMs)).toEqual({ text: 'Next planner pass: claude-api (no health reading).', tone: 'warn' });
    expect(plannerLine(plan({
      choice: { provider: 'codex-personal', reason: 'executor-fail' },
      health: [healthRow({ status: 'failing', reason: 'executor-fail' })],
    }), nowMs)).toEqual({ text: 'Next planner pass: codex-personal (failing — executor-fail).', tone: 'warn' });
  });
});
