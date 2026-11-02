import { expect, it } from 'vitest';
import { workerAgeSummary } from './graph-summary.js';

it('summarizes finite worker ages and lane-specific stuck states', () => {
  expect(workerAgeSummary([])).toBeNull();
  expect(workerAgeSummary([{ lane: 'codex', ageSeconds: null }])).toBeNull();
  expect(workerAgeSummary([{ lane: 'codex', ageSeconds: Infinity }])).toBeNull();
  expect(workerAgeSummary([{ lane: 'codex', ageSeconds: 300 }])).toBe('oldest worker 5 min');
  const stuck = { lane: 'codex-personal', ageSeconds: 61 * 60 };
  expect(workerAgeSummary([stuck, stuck])).toBe('oldest worker 61 min · 2 look stuck');
  expect(workerAgeSummary([stuck])).toBe('oldest worker 61 min · 1 looks stuck');
  expect(workerAgeSummary([{ lane: 'devin', ageSeconds: 100 * 60 }])).toBe('oldest worker 1 h 40 min');
});
