import { expect, it, vi } from 'vitest';
import { isBulkCommit } from '../src/core/fleet/bulk-commit.js';
import { precheckJob, type JobPrecheckGit } from '../src/core/fleet/job-precheck.js';
import { cachingJobPrecheckGit } from '../src/core/fleet/job-precheck-batch.js';
import { cmdFleetJobPrecheck } from '../src/cli/fleet-job-precheck.js';
import { cmdFleetPathHistory } from '../src/cli/fleet-path-history.js';

function fake(filesChanged: number | null): JobPrecheckGit {
  return {
    exists: async () => true,
    lastCommit: async () => ({ sha: '84080b77c', subject: 'bridge(RQ-STUCKOPENQ8): rewritten (#3111)', filesChanged }),
  };
}

it('recognizes the bulk threshold and preserves unknown counts', () => {
  expect(isBulkCommit(null)).toBe(false);
  expect(isBulkCommit(499)).toBe(false);
  expect(isBulkCommit(500)).toBe(true);
});

it('does not treat a bulk bridge as landed, including through the batch cache', async () => {
  const report = await precheckJob('Update src/old.ts', cachingJobPrecheckGit(fake(9729)));
  expect(report.verdict).toBe('partly-on-master');
  expect(report.facts[0]?.bulk).toBe(true);
});

it('still accepts a three-file bridge as landed', async () => {
  expect((await precheckJob('Update src/old.ts', fake(3))).verdict).toBe('likely-done');
});

it.each(['RQ-STUCKOPENQ8', 'RQ-OTHER'])('marks bulk job identity unknown for %s', async jobId => {
  const report = await precheckJob('src/old.ts', fake(500), { jobId });
  expect(report.facts[0]?.jobIdMatch).toBeNull();
  expect(report.verdict).toBe('partly-on-master');
});

it('marks text facts and exposes bulk in JSON without returning exit 3', async () => {
  const lines: string[] = [];
  const deps = { git: fake(500), readFile: async () => 'src/old.ts', log: (line: string) => { lines.push(line); } };
  expect(await cmdFleetJobPrecheck(['draft.md'], deps)).toBe(0);
  expect(lines.join('\n')).toContain('(#3111) bulk-commit');
  lines.length = 0;
  expect(await cmdFleetJobPrecheck(['draft.md', '--json'], deps)).toBe(0);
  expect(JSON.parse(lines[0]!).facts[0].bulk).toBe(true);
});

it('path mode skips bulk attribution and prints the skip line while retaining ordinary rows', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  try {
    expect(await cmdFleetPathHistory(['src/old.ts'], { log: async () => [
      { sha: '84080b77c', date: '2026-11-03', subject: 'bridge(RQ-STUCKOPENQ8): rewrite (#3111)', filesChanged: 9729 },
      { sha: 'abc1234', date: '2026-11-02', subject: 'bridge(RQ-REAL): real work (#42)', filesChanged: 3 },
    ] })).toBe(0);
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      '#42 RQ-REAL 2026-11-02 real work',
      'skipped 1 bulk commit (>=500 files) that cannot attribute this path',
    ]);
  } finally { log.mockRestore(); }
});
