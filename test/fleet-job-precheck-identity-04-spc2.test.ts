import { describe, expect, it, vi } from 'vitest';
import { cmdFleetJobPrecheck } from '../src/cli/fleet-job-precheck.js';

function harness(subjects: Record<string, string | null>, draft = 'src/existing.ts') {
  const log = vi.fn();
  const error = vi.fn();
  const readFile = vi.fn(async () => draft);
  const exists = vi.fn(async (path: string) => path in subjects);
  const lastCommit = vi.fn(async (path: string) => {
    const subject = subjects[path];
    return subject ? { sha: 'abcd1234', subject } : null;
  });
  return { deps: { log, error, readFile, git: { exists, lastCommit } }, log, error, readFile, exists, lastCommit };
}

async function run(subjects: Record<string, string | null>, draft = 'src/existing.ts') {
  const h = harness(subjects, draft);
  const code = await cmdFleetJobPrecheck(['draft.md', '--job-id', 'RQ-EXAMPLE-1', '--json'], h.deps);
  return { ...h, code, report: JSON.parse(h.log.mock.calls[0]![0] as string) };
}

describe('job-precheck exact job identity', () => {
  it('accepts an exact parsed last-commit identity on an existing source file', async () => {
    const r = await run({ 'src/existing.ts': 'bridge(RQ-EXAMPLE-1): work (#42)' });
    expect(r.code).toBe(3);
    expect(r.report).toMatchObject({ jobId: 'RQ-EXAMPLE-1', verdict: 'likely-done', facts: [{ onMaster: true, jobIdMatch: true }] });
  });

  it.each(['RQ-OTHER-1', 'RQ-EXAMPLE-10'])('does not accept unrelated or prefix identity %s', async id => {
    const r = await run({ 'src/existing.ts': `bridge(${id}): older work` });
    expect(r.code).toBe(0);
    expect(r.report).toMatchObject({ verdict: 'partly-on-master', facts: [{ onMaster: true, jobIdMatch: false }] });
  });

  it('keeps mixed and unknown evidence partial', async () => {
    const r = await run({ 'src/existing.ts': 'bridge(RQ-EXAMPLE-1): work', 'src/other.ts': 'ordinary commit' }, 'src/existing.ts src/other.ts src/missing.ts');
    expect(r.code).toBe(0);
    expect(r.report.verdict).toBe('partly-on-master');
    expect(r.report.facts.map((f: { jobIdMatch: boolean | null }) => f.jobIdMatch)).toEqual([true, null, null]);
  });

  it('renders requested identity and evidence for people', async () => {
    const h = harness({ 'src/existing.ts': 'bridge(RQ-OTHER): work' });
    expect(await cmdFleetJobPrecheck(['draft.md', '--job-id', 'RQ-EXAMPLE-1'], h.deps)).toBe(0);
    expect(h.log.mock.calls.flat().join('\n')).toContain('job-id: RQ-EXAMPLE-1');
    expect(h.log.mock.calls.flat().join('\n')).toContain('job-id-match=false');
  });

  it.each([
    ['draft.md', '--job-id'], ['draft.md', '--job-id', '--json'],
    ['draft.md', '--job-id', 'invalid'], ['draft.md', '--job-id', 'RQ-A', '--job-id', 'RQ-B'],
    ['--batch', 'draft.md', '--job-id', 'RQ-A'],
  ])('rejects malformed arguments without file or git I/O: %j', async (...args) => {
    const h = harness({});
    expect(await cmdFleetJobPrecheck(args, h.deps)).toBe(2);
    expect(h.readFile).not.toHaveBeenCalled();
    expect(h.exists).not.toHaveBeenCalled();
    expect(h.lastCommit).not.toHaveBeenCalled();
  });

  it('preserves legacy matching and output when no identity is requested', async () => {
    const h = harness({ 'src/existing.ts': 'bridge(RQ-OTHER): work' });
    expect(await cmdFleetJobPrecheck(['draft.md', '--json'], h.deps)).toBe(3);
    const report = JSON.parse(h.log.mock.calls[0]![0] as string);
    expect(report.verdict).toBe('likely-done');
    expect(report).not.toHaveProperty('jobId');
    expect(report.facts[0]).not.toHaveProperty('jobIdMatch');
  });
});
