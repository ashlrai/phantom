import { expect, it } from 'vitest';
import { workerTellPrefill } from './workers-tell.js';

it('includes the job, lane, repo and formatted age', () => {
  expect(workerTellPrefill({ job: 'job-stuck', lane: 'codex-personal', repo: 'example/repo', ageSeconds: 4200 }))
    .toBe('Re job-stuck (codex-personal, example/repo): running 1:10 with no PR, looks stuck. ');
});

it('omits an absent repo and handles an unknown age', () => {
  expect(workerTellPrefill({ job: 'job-stuck', lane: 'codex-personal', ageSeconds: 61 }))
    .toBe('Re job-stuck (codex-personal): running 1:01 with no PR, looks stuck. ');
  expect(workerTellPrefill({ job: 'job-stuck', lane: 'codex-personal', repo: null, ageSeconds: null }))
    .toBe('Re job-stuck (codex-personal): running age unknown with no PR, looks stuck. ');
});
