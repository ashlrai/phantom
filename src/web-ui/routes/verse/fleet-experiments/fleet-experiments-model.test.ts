import { expect, it } from 'vitest';
import type { OpsExperimentV1, OpsFleetV1 } from '../../../../core/verse/ops-types.js';
import { experimentNotes, experimentRows } from './fleet-experiments-model.js';

const exp = (id: string, overrides: Partial<OpsExperimentV1> = {}): OpsExperimentV1 => ({
  id, hypothesisId: null, arms: { base: 'base', candidate: id }, status: 'done', pairs: 10, wins: 6, losses: 3, ties: 1,
  lift: { mean: 2, ciLow: 1, ciHigh: 3 }, verdict: 'adopt', reasons: ['Evidence'], startedAt: '2026-01-01', finishedAt: '2026-01-02', ...overrides,
});
export const fixture = (): OpsFleetV1 => ({
  v: 1, generatedAt: '', tickAt: null, lanes: null, holdProduction: null, held: [], decisions: [],
  sources: { tick: 'healthy', journal: 'healthy', learning: 'healthy' },
  experiments: [exp('positive'), exp('unclear', { lift: { mean: 0, ciLow: -1, ciHigh: 1 }, finishedAt: '2026-01-03' }), exp('unknown', { status: 'running', lift: null, verdict: null, finishedAt: null })],
});

it('orders active first then by finish and id, and counts interval verdicts', () => {
  const fleet = fixture();
  fleet.experiments.push(exp('negative', { lift: { mean: -2, ciLow: -3, ciHigh: -1 }, finishedAt: '2026-01-03' }));
  const { rows, summary } = experimentRows(fleet);
  expect(rows.map(r => r.id)).toEqual(['unknown', 'negative', 'unclear', 'positive']);
  expect(summary).toEqual({ total: 4, helped: 1, hurt: 1, unclear: 1, unknown: 1 });
  expect(rows[0]).toMatchObject({ estimate: null, low: null, high: null, n: 10, detail: '6W 3L 1T · running' });
  expect(rows[3]).toMatchObject({ label: 'base → positive', estimate: 2, low: 1, high: 3, detail: '6W 3L 1T · done · adopt' });
  expect(experimentNotes(fleet.experiments[0]!)).toEqual(['Evidence', 'Started: 2026-01-01', 'Finished: 2026-01-02']);
});
