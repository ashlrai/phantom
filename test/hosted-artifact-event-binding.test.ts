import { describe, expect, it } from 'vitest';

import { metadata } from '../.github/tests/helpers/hosted-artifact-fixture.mjs';
import { auditGithub } from '../scripts/hosted-build-artifact.mjs';

/**
 * The audit's candidate↔event binding must accept the shapes GitHub actually
 * emits. On pull_request the event revision is a synthetic merge: a BEHIND
 * head gives it a newer base tree, so equality of the two commit trees cannot
 * be the test — the merge's head-side parent must be the candidate. On
 * merge_group, schedule, dispatch, push and reusable calls the run checks out
 * the event revision itself, so the trees are identical anyway.
 */
const repository = 'ashlrai/ashlr-hub';
const revision = 'a'.repeat(40);
const baseSha = 'b'.repeat(40);
const mergeSha = 'c'.repeat(40);
const headTree = 'd'.repeat(40);
const mergeTree = 'e'.repeat(40);
const otherSha = '0'.repeat(40);

function input(over: { event?: string; eventSha?: string; commits?: Record<string, unknown> } = {}) {
  const event = over.event ?? 'pull_request';
  const eventSha = over.eventSha ?? mergeSha;
  const commits = over.commits ?? {};
  const job = { id: 5, run_id: 100, head_sha: revision, name: 'Mac exhaustive (1/4)', status: 'completed', conclusion: 'success',
    labels: ['macos-15'], steps: [{ name: 'Test complete partition', status: 'completed', conclusion: 'success' }] };
  const run = { id: 100, run_attempt: 1, repository: metadata(), head_sha: revision, event, path: '.github/workflows/ci.yml',
    status: 'completed', conclusion: 'success' };
  const artifact = { id: 200, name: 'qualified-build', expired: false, digest: `sha256:${'f'.repeat(64)}`,
    workflow_run: { id: 100, head_sha: revision } };
  const read = (endpoint: string) => {
    if (endpoint === `repos/${repository}`) return metadata();
    if (endpoint.includes('/git/commits/')) {
      const sha = endpoint.split('/').at(-1)!;
      return commits[sha] ?? { sha, tree: { sha: headTree } };
    }
    if (endpoint.includes('/jobs?')) return { total_count: 1, jobs: [job] };
    if (endpoint.includes('/artifacts/')) return artifact;
    return run;
  };
  return { repository, revision, eventSha, runId: 100, runAttempt: 1, artifactId: artifact.id, artifactName: artifact.name,
    requiredJobs: [{ name: job.name, labels: job.labels, steps: job.steps.map((step) => step.name) }], read };
}

describe('hosted build audit event-tree binding', () => {
  it('binds a pull_request merge whose head-side parent is the candidate (BEHIND head)', () => {
    const commits = {
      [mergeSha]: { sha: mergeSha, tree: { sha: mergeTree }, parents: [{ sha: baseSha }, { sha: revision }] },
      [revision]: { sha: revision, tree: { sha: headTree } },
    };
    const result = auditGithub(input({ commits }));
    expect(result.tree).toBe(headTree);
    expect(result.eventSha).toBe(mergeSha);
  });

  it('binds an up-to-date pull_request merge whose tree already equals the candidate', () => {
    const commits = {
      [mergeSha]: { sha: mergeSha, tree: { sha: headTree }, parents: [{ sha: baseSha }, { sha: revision }] },
      [revision]: { sha: revision, tree: { sha: headTree } },
    };
    expect(auditGithub(input({ commits })).tree).toBe(headTree);
  });

  it('binds merge_group, schedule, dispatch, push and reusable-call runs that test the event revision', () => {
    for (const event of ['merge_group', 'schedule', 'workflow_dispatch', 'push', 'workflow_call']) {
      const commits = { [revision]: { sha: revision, tree: { sha: headTree } } };
      expect(auditGithub(input({ event, eventSha: revision, commits })).tree).toBe(headTree);
    }
  });

  it('refuses an event outside the workflow triggers before any commit read', () => {
    let reads = 0;
    const base = input({ event: 'issue_comment' });
    const wrapped = { ...base, read: (endpoint: string) => { reads++; return base.read(endpoint); } };
    expect(() => auditGithub(wrapped)).toThrow('unexpected CI event');
    expect(reads).toBe(2);
  });

  it.each([
    ['a merge built on a different head', { sha: mergeSha, tree: { sha: mergeTree }, parents: [{ sha: baseSha }, { sha: otherSha }] }],
    ['a single-parent commit with a different tree', { sha: mergeSha, tree: { sha: mergeTree }, parents: [{ sha: baseSha }] }],
    ['a merge that lists the candidate only as its base parent', { sha: mergeSha, tree: { sha: mergeTree }, parents: [{ sha: revision }, { sha: otherSha }] }],
  ])('refuses %s when its tree is not the candidate', (_label, eventCommit) => {
    const commits = { [mergeSha]: eventCommit, [revision]: { sha: revision, tree: { sha: headTree } } };
    expect(() => auditGithub(input({ commits }))).toThrow('event tree does not bind the candidate');
  });
});
