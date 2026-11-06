import { expect, it } from 'vitest';
import { fleetRunsFixture } from '../fleet/fleet-runs-fixtures.test-support.js';
import { paletteWorkers } from './palette-workers.js';

it('deduplicates claims and publishes behind running jobs, validates IDs, and orders states', () => {
  const at = '2026-10-31T04:40:00Z';
  const claimed = ['RQ-PHX-RUN', 'RQ-PHX-MERGED', 'RQ-PHX-QUEUE', '../bad'].map(job => ({ job, lane: 'codex-personal', tier: 'mid', at }));
  const snapshot = { ...fleetRunsFixture(), claimed,
    workers: [
      { job: 'RQ-PHX-RUN', repo: 'phantom', lane: 'codex-personal', tier: 'mid', ageSeconds: 720 },
      { job: 'RQ-PHX-OLDER', repo: 'phantom', lane: 'codex-personal', tier: 'mid', ageSeconds: 900 },
      { job: '../bad', repo: 'phantom', lane: 'codex-personal', tier: 'mid', ageSeconds: 999 },
    ],
    publishesLastHour: [
      { job: 'RQ-PHX-RUN', lane: 'codex-personal', url: null, at },
      { job: 'RQ-PHX-MERGED', lane: 'codex-personal', url: 'https://github.com/ashlrai/phantom/pull/1811', at },
      { job: '../bad', lane: null, url: 'https://example.com/', at },
    ],
  };
  expect(paletteWorkers(snapshot)).toEqual([
    { job: 'RQ-PHX-OLDER', lane: 'codex-personal', tier: 'mid', ageSeconds: 900, state: 'running', at: null, prUrl: null },
    { job: 'RQ-PHX-RUN', lane: 'codex-personal', tier: 'mid', ageSeconds: 720, state: 'running', at: null, prUrl: null },
    { job: 'RQ-PHX-QUEUE', lane: 'codex-personal', tier: 'mid', ageSeconds: null, state: 'queued', at, prUrl: null },
    { job: 'RQ-PHX-MERGED', lane: 'codex-personal', tier: '', ageSeconds: null, state: 'merged', at, prUrl: 'https://github.com/ashlrai/phantom/pull/1811' },
  ]);
});
