import { expect, it } from 'vitest';
import { fleetRunsFixture } from '../fleet/fleet-runs-fixtures.test-support.js';
import { stuckWorkers } from './fleet-timeline-model.js';

const worker = (job: string, ageSeconds: number | null, lane = 'devin') =>
  ({ ...fleetRunsFixture().workers[0]!, job, ageSeconds, lane });

it('returns valid stuck workers in descending age order without changing the input', () => {
  const rows = [worker('RQ-PHX-SHORT', 600), worker('RQ-PHX-OLDER', 2760), worker('RQ-PHX-UNKNOWN', null),
    worker('bad id', 5000), worker('RQ-PHX-LONGEST', 3720, 'codex'), worker('RQ-PHX-BOUNDARY', 2700)];
  expect(stuckWorkers(rows)).toEqual([
    { job: 'RQ-PHX-LONGEST', lane: 'codex', ageSeconds: 3720 },
    { job: 'RQ-PHX-OLDER', lane: 'devin', ageSeconds: 2760 },
  ]);
  expect(rows.map(row => row.job)).toEqual(['RQ-PHX-SHORT', 'RQ-PHX-OLDER', 'RQ-PHX-UNKNOWN', 'bad id', 'RQ-PHX-LONGEST', 'RQ-PHX-BOUNDARY']);
});
