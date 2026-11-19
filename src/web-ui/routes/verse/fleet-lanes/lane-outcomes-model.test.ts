import { describe, expect, it } from 'vitest';
import type { JobOutcomesReport } from '../../../../core/fleet/job-outcomes.js';
import { isJobOutcomesReport, laneOutcomeLine } from './lane-outcomes-model.js';

const report = { schema: 'fleet.job-outcomes.v1', known: true, lanes: [{ lane: 'zai', summary: 'zai: 1 merged of 56; most empty: task already on master' }] } as unknown as JobOutcomesReport;

describe('lane outcome line', () => {
  it('shows the lane summary, and nothing for an unknown report or a lane with no jobs', () => {
    expect(isJobOutcomesReport(report)).toBe(true);
    expect(isJobOutcomesReport({ schema: 'other' })).toBe(false);
    expect(laneOutcomeLine('zai', report)).toBe('zai: 1 merged of 56; most empty: task already on master');
    expect(laneOutcomeLine('claude', report)).toBeNull();
    expect(laneOutcomeLine('zai', { ...report, known: false })).toBeNull();
    expect(laneOutcomeLine('zai', null)).toBeNull();
  });
});
