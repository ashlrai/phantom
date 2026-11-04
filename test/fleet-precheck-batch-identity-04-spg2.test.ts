import { describe, expect, it, vi } from 'vitest';
import { cmdFleetJobPrecheck } from '../src/cli/fleet-job-precheck.js';
import { precheckJobBatch } from '../src/core/fleet/job-precheck-batch.js';

function harness() {
  const log = vi.fn();
  const error = vi.fn();
  const readFile = vi.fn(async () => 'Edit src/shared.ts; prose mentions RQ-OTHER-1');
  const exists = vi.fn(async () => true);
  const lastCommit = vi.fn(async () => ({ sha: 'abc1234', subject: 'bridge(RQ-EXAMPLE-1): done' }));
  const resolveRef = vi.fn(async () => 'a'.repeat(40));
  return { log, error, readFile, exists, lastCommit, resolveRef, deps: { log, error, readFile, git: { exists, lastCommit }, resolveRef } };
}

const files = ['nested/drop/RQ-EXAMPLE-1.md', 'other/RQ-EXAMPLE-10.md'];

describe('batch filename identity', () => {
  it('uses exact basename identities with a shared snapshot and probe cache', async () => {
    const h = harness();
    expect(await cmdFleetJobPrecheck(['--batch', ...files, '--identity-from-filename', '--json'], h.deps)).toBe(3);
    const result = JSON.parse(h.log.mock.calls[0]![0] as string);
    expect(result.resolvedRef).toBe('a'.repeat(40));
    expect(result.results.map((r: { jobId: string; verdict: string }) => [r.jobId, r.verdict])).toEqual([
      ['RQ-EXAMPLE-1', 'likely-done'], ['RQ-EXAMPLE-10', 'partly-on-master'],
    ]);
    expect(result.results.map((r: { facts: Array<{ jobIdMatch: boolean }> }) => r.facts[0]!.jobIdMatch)).toEqual([true, false]);
    expect(result.counts).toEqual({ fresh: 0, 'partly-on-master': 1, 'likely-done': 1, errors: 0 });
    expect(h.resolveRef).toHaveBeenCalledTimes(1);
    expect(h.exists).toHaveBeenCalledTimes(1);
    expect(h.lastCommit).toHaveBeenCalledTimes(1);
  });

  it('continues after an invalid filename and gives errors exit precedence', async () => {
    const h = harness();
    expect(await cmdFleetJobPrecheck(['--batch', 'bad name.md', files[0]!, 'RQ-EXAMPLE-1.txt', '--identity-from-filename', '--json'], h.deps)).toBe(2);
    const result = JSON.parse(h.log.mock.calls[0]![0] as string);
    expect(result.results.map((r: { error?: string; verdict?: string }) => r.error ?? r.verdict)).toEqual([
      'invalid job ID filename', 'likely-done', 'invalid job ID filename',
    ]);
    expect(result.counts).toEqual({ fresh: 0, 'partly-on-master': 0, 'likely-done': 1, errors: 2 });
  });

  it('leaves default batch reports identity-free', async () => {
    const h = harness();
    expect(await cmdFleetJobPrecheck(['--batch', ...files, '--json'], h.deps)).toBe(3);
    const result = JSON.parse(h.log.mock.calls[0]![0] as string);
    expect(result.results.map((r: { verdict: string }) => r.verdict)).toEqual(['likely-done', 'likely-done']);
    expect(result.results[0]).not.toHaveProperty('jobId');
    expect(result.results[0].facts[0]).not.toHaveProperty('jobIdMatch');
  });

  it('retains collision reporting for successful identity-resolved drafts', async () => {
    const h = harness();
    const result = await precheckJobBatch(files, { readFile: h.readFile, git: h.deps.git, resolveJobId: file => file.includes('10') ? 'RQ-EXAMPLE-10' : 'RQ-EXAMPLE-1' });
    expect(result.collisions).toEqual([{ path: 'src/shared.ts', files }]);
  });

  it.each([
    ['RQ-EXAMPLE-1.md', '--identity-from-filename'],
    ['RQ-EXAMPLE-1.md', '--job-id', 'RQ-EXAMPLE-1', '--identity-from-filename'],
    ['--batch', 'RQ-EXAMPLE-1.md', '--job-id', 'RQ-EXAMPLE-1', '--identity-from-filename'],
    ['--batch', 'RQ-EXAMPLE-1.md', '--identity-from-filename', '--identity-from-filename'],
    ['--batch', '-', '--identity-from-filename'],
  ])('rejects incompatible flags before I/O: %j', async (...args) => {
    const h = harness();
    expect(await cmdFleetJobPrecheck(args, h.deps)).toBe(2);
    expect(h.readFile).not.toHaveBeenCalled();
    expect(h.resolveRef).not.toHaveBeenCalled();
  });
});
