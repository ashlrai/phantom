import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendLedger, outcomesLedgerPath, readLedger, type MetricSpec } from '../src/core/improve/outcomes.js';
import { computeNorthStar, measuredLeverage, northStarSummary } from '../src/core/vision/north-star.js';
import { fleetBudget } from '../src/core/fleet/budget-view.js';
import { callNativeTool } from '../src/core/mcp-native.js';
import type { AshlrConfig, DaemonState } from '../src/core/types.js';
import type { LoadDaemonStateStrictResult } from '../src/core/daemon/state.js';

const metric: MetricSpec = { name: 'gate-ms', direction: 'decrease', runner: { kind: 'npm', script: 'bench:gate' } };
const A = 'a'.repeat(40), B = 'b'.repeat(40);
const NOW = new Date('2026-10-15T12:00:00.000Z');

let home: string;
let saved: { HOME?: string; ASHLR_HOME?: string };
beforeEach(() => {
  saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME };
  delete process.env.ASHLR_HOME;
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'north-star-')));
  process.env.HOME = home;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(home, { recursive: true, force: true });
});

let n = 0;
/** One registered proposal measured 100 at base and `head` at its head, `age` days before NOW. */
function outcome(head: number | null, age: number, from: Date = NOW) {
  const proposalId = (++n).toString(16).padStart(10, '0');
  const at = new Date(from.getTime() - age * 86_400_000);
  appendLedger({ type: 'registered', proposalId, title: `p${n}`, proposalKind: 'perf', source: { kind: 'deterministic', rule: 'test' }, metric, predictedDelta: null }, { now: at });
  appendLedger({ type: 'measured', proposalId, phase: 'base', sha: A, value: 100, reason: null }, { now: at });
  appendLedger({ type: 'measured', proposalId, phase: 'head', sha: B, value: head, reason: head === null ? 'metric failed' : null }, { now: at });
}

describe('north-star leverage from measured outcomes', () => {
  it('is unknown, never 0, below three measured outcomes', () => {
    outcome(80, 1); outcome(90, 2); outcome(null, 1);
    const m = measuredLeverage(readLedger(), NOW);
    expect(m.score).toBeNull();
    expect(m.trend).toBe('unknown');
    expect(m.leverage).toMatchObject({ measured: 2, improved: 2, unknown: 1 });
    expect(m.leverage.reasons).toContain('needs-3-measured-outcomes-in-7d');
  });

  it('scores 50 + 50 × net improvement rate and compares with the prior week', () => {
    outcome(80, 1); outcome(80, 2); outcome(80, 3); outcome(120, 4); // 3 improved, 1 regressed: 75
    outcome(100, 8); outcome(100, 9); outcome(120, 10); // prior week: 0 improved, 1 regressed, 2 unchanged: 33
    outcome(80, 20); // older than 14d: ignored
    const m = measuredLeverage(readLedger(), NOW);
    expect(m.score).toBe(75);
    expect(m.leverage).toMatchObject({ measured: 4, improved: 3, regressed: 1, unchanged: 0, priorScore: 33 });
    expect(m.trend).toBe('up');
  });

  it('withholds the score when the ledger is broken', () => {
    outcome(80, 1); outcome(80, 2); outcome(80, 3);
    fs.appendFileSync(outcomesLedgerPath(), 'not json\n');
    const m = measuredLeverage(readLedger(), NOW);
    expect(m.score).toBeNull();
    expect(m.leverage.ledgerIntact).toBe(false);
    expect(m.leverage.reasons).toContain('ledger-not-intact');
  });

  it('computeNorthStar and the MCP tool report the measured score', async () => {
    const real = new Date(Date.now() - 60_000);
    outcome(80, 0, real); outcome(80, 0, real); outcome(100, 0, real);
    const metric = computeNorthStar({} as AshlrConfig);
    expect(metric.leverageScore).toBe(83);
    expect(metric.substantiveMerges7d).toBe(0);
    expect(northStarSummary(metric)).toContain('Measured leverage score: 83/100 (3 measured (2 improved, 1 unchanged, 0 regressed)');
    const r = await callNativeTool('ashlr_north_star', {});
    const payload = JSON.parse(r.content.map((c) => c.text).join('\n')) as Record<string, unknown>;
    expect(payload['leverageScore']).toBe(83);
    expect(payload['leverage']).toMatchObject({ measured: 3, improved: 2 });
  });
});

describe('fleet budget view', () => {
  const state = (s: Partial<DaemonState>): LoadDaemonStateStrictResult =>
    ({ ok: true, fresh: false, state: { todayDate: '2026-10-15', todaySpentUsd: 0, ...s } as DaemonState });

  it('reports the configured cap against today\'s recorded spend', () => {
    expect(fleetBudget({ daemon: { dailyBudgetUsd: 5 } } as AshlrConfig, state({ todaySpentUsd: 1.25 }), NOW)).toEqual({
      day: '2026-10-15', dailyBudgetUsd: 5, budgetSource: 'config', spentTodayUsd: 1.25, remainingUsd: 3.75, capReached: false, reasons: [],
    });
  });

  it('uses the $1 default, rolls over a stale day, and treats 0 as stopped', () => {
    expect(fleetBudget({} as AshlrConfig, state({ todayDate: '2026-10-14', todaySpentUsd: 9 }), NOW))
      .toMatchObject({ dailyBudgetUsd: 1, budgetSource: 'default', spentTodayUsd: 0, remainingUsd: 1, capReached: false });
    expect(fleetBudget({ daemon: { dailyBudgetUsd: 0 } } as AshlrConfig, state({}), NOW))
      .toMatchObject({ dailyBudgetUsd: 0, capReached: true, reasons: ['budget-zero-stopped'] });
    expect(fleetBudget({ daemon: { dailyBudgetUsd: 2 } } as AshlrConfig, state({ todaySpentUsd: 2.5 }), NOW))
      .toMatchObject({ remainingUsd: 0, capReached: true });
  });

  it('closes the day on unknown exposure and leaves spend unknown when state is unreadable', () => {
    expect(fleetBudget({} as AshlrConfig, state({ todaySpentUsd: 0.1, spendGuardAccounting: { budgetDay: '2026-10-15', accountingId: 'x', budgetExhausted: true } }), NOW))
      .toMatchObject({ remainingUsd: 0, capReached: true, reasons: ['unknown-exposure-closes-day'] });
    const broken: LoadDaemonStateStrictResult = { ok: false, path: '/x', reason: 'malformed', error: 'bad', diagnostic: {} as never };
    expect(fleetBudget({} as AshlrConfig, broken, NOW)).toMatchObject({ spentTodayUsd: null, remainingUsd: null, capReached: null, reasons: ['daemon-state-malformed'] });
  });

  it('ashlr_fleet_status returns the budget', async () => {
    const r = await callNativeTool('ashlr_fleet_status', {});
    const payload = JSON.parse(r.content.map((c) => c.text).join('\n')) as { budget: Record<string, unknown> };
    expect(payload.budget).toMatchObject({ dailyBudgetUsd: expect.any(Number), budgetSource: expect.any(String) });
    expect(payload.budget['spentTodayUsd']).toBe(0);
  });
});
