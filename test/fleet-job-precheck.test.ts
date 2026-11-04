import { expect, it } from 'vitest';
import { extractJobPaths, precheckJob, type JobPrecheckGit } from '../src/core/fleet/job-precheck.js';

const job = [
  'Update src/core/fleet/job-precheck.ts and test/fleet-job-precheck.test.ts.',
  'Also docs/guide.md, schema/job.schema.json, scripts/run.mjs.',
  'Skip bare src/core/fleet and notsrc/foo.ts and desktop/src/skip.ts.',
  'Do not edit src/cli/fleet.ts or docs/README.md.',
  'Never touch scripts/gen-fleet-registry.mjs.',
  'Again src/core/fleet/job-precheck.ts and `src/cli/fleet-job-precheck.ts`.',
].join('\n');

function fake(master: Record<string, string | null>): JobPrecheckGit & { commits: number } {
  const git = {
    commits: 0,
    async exists(path: string) { return Object.prototype.hasOwnProperty.call(master, path); },
    async lastCommit(path: string) {
      git.commits += 1;
      const subject = master[path];
      return subject ? { sha: 'abc1234', subject } : null;
    },
  };
  return git;
}

it('extracts prefixed files once and skips Do not edit and Never touch lines', () => {
  expect(extractJobPaths(job)).toEqual([
    'src/core/fleet/job-precheck.ts',
    'test/fleet-job-precheck.test.ts',
    'docs/guide.md',
    'schema/job.schema.json',
    'scripts/run.mjs',
    'src/cli/fleet-job-precheck.ts',
  ]);
  expect(extractJobPaths('DO NOT EDIT src/cli/fleet.ts\nnever touch test/x.test.ts\n')).toEqual([]);
});

it('calls a draft fresh when no named src file is on master and lists new tests', async () => {
  const git = fake({ 'docs/guide.md': 'docs only' });
  const report = await precheckJob('src/new.ts docs/guide.md test/new.test.ts test/old.test.ts', {
    ...git, async exists(path: string) { return path === 'docs/guide.md' || path === 'test/old.test.ts'; },
    async lastCommit(path: string) { return path === 'docs/guide.md' ? { sha: 'abc1234', subject: 'docs only' } : path === 'test/old.test.ts' ? { sha: 'def5678', subject: 'old test' } : null; },
  });
  expect(report.verdict).toBe('fresh');
  expect(report.newTestFiles).toEqual(['test/new.test.ts']);
  expect(report.facts.map(fact => [fact.path, fact.onMaster])).toEqual([
    ['src/new.ts', false], ['docs/guide.md', true], ['test/new.test.ts', false], ['test/old.test.ts', true],
  ]);
});

it('does not ask git for a commit when the path is missing', async () => {
  const git = fake({});
  const report = await precheckJob('src/new.ts\nDo not edit src/cli/fleet.ts\n', git);
  expect(report.verdict).toBe('fresh');
  expect(report.facts.map(fact => fact.path)).toEqual(['src/new.ts']);
  expect(git.commits).toBe(0);
});

it('calls a draft partly on master when src work is mixed or lacks a bridge id', async () => {
  const mixed = await precheckJob('src/a.ts src/b.ts', fake({ 'src/a.ts': 'bridge(RQ-PHX-A1): landed' }));
  expect(mixed.verdict).toBe('partly-on-master');
  const unbridged = await precheckJob('src/a.ts', fake({ 'src/a.ts': 'bridge the gap' }));
  expect(unbridged.verdict).toBe('partly-on-master');
  expect(unbridged.facts[0]!.lastCommit?.subject).toBe('bridge the gap');
  const testsOnly = await precheckJob('src/a.test.ts', fake({ 'src/a.test.ts': 'bridge(RQ-PHX-T1): test' }));
  expect(testsOnly.verdict).toBe('partly-on-master');
  expect(testsOnly.newTestFiles).toEqual([]);
});

it('calls a draft likely-done when every non-test src file landed under bridge(RQ-...)', async () => {
  const report = await precheckJob(
    'src/a.ts src/b.ts src/a.test.ts test/new.test.ts docs/guide.md',
    fake({
      'src/a.ts': 'bridge(RQ-PHX-A1): landed',
      'src/b.ts': 'also bridge(RQ-PHX-B2) in the subject',
      'docs/guide.md': 'docs',
    }),
  );
  expect(report.verdict).toBe('likely-done');
  expect(report.newTestFiles).toEqual(['src/a.test.ts', 'test/new.test.ts']);
  expect(report.facts[0]!.lastCommit).toEqual({ sha: 'abc1234', subject: 'bridge(RQ-PHX-A1): landed' });
});
