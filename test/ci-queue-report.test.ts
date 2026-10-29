import { describe, expect, it } from 'vitest';
// @ts-expect-error -- standalone ESM operator script
import { buildQueueReport, main, renderQueueReport } from '../scripts/ci-queue-report.mjs';

const created = '2026-10-26T03:00:00Z';
const started = '2026-10-26T03:02:00Z';
const completed = '2026-10-26T03:05:00Z';
const observedAt = '2026-10-26T03:10:00Z';
function job(overrides: Record<string, unknown> = {}) {
  return { id: 1, run_id: 10, run_attempt: 1, runner_id: 42, labels: ['macos-15'],
    status: 'completed', conclusion: 'success', created_at: created,
    started_at: started, completed_at: completed,
    steps: [{ status: 'completed', conclusion: 'success', started_at: started }], ...overrides };
}
function capture(jobs = [job()]) {
  return { repository: 'ashlrai/phantom', runId: 10, runAttempt: 1, observedAt,
    pages: [{ total_count: jobs.length, jobs }] };
}
function report(jobs = [job()]) { return buildQueueReport([capture(jobs)]); }
function outputIO(contents: string | Error) {
  const output = { stdout: '', stderr: '', reads: [] as string[] };
  return { output, io: {
    readFile: async (path: string) => {
      output.reads.push(path);
      if (contents instanceof Error) throw contents;
      return contents;
    },
    stdout: (value: string) => { output.stdout += value; },
    stderr: (value: string) => { output.stderr += value; },
  } };
}

describe('CI queue evidence', () => {
  it('separates scheduling delay from execution and keeps capture provenance', () => {
    const result = report();
    expect(result.totalJobs).toBe(1);
    expect(result.captures).toEqual([{ repository: 'ashlrai/phantom', runId: 10, runAttempt: 1, observedAt }]);
    expect(result.labels[0]).toMatchObject({ label: 'macos-15', started: 1,
      queueMs: { samples: 1, p50: 120_000, p95: 120_000, max: 120_000 },
      executionMs: { samples: 1, p95: 180_000 } });
  });

  it('validates and combines all pages before calculating percentiles', () => {
    const input = capture();
    input.pages = Array.from({ length: 20 }, (_, index) => ({ total_count: 20,
      jobs: [job({ id: index + 1, started_at: `2026-10-26T03:00:${String(index).padStart(2, '0')}Z` })] }));
    expect(buildQueueReport([input]).labels[0].queueMs).toEqual({ samples: 20, p50: 9000, p95: 18_000, max: 19_000 });
  });

  it.each(['queued', 'waiting', 'pending', 'requested'])('keeps %s ages out of start-delay percentiles', status => {
    const result = report([job(), job({ id: 2, status, runner_id: 0, steps: [], started_at: null, completed_at: null })]);
    expect(result.labels[0]).toMatchObject({ started: 1, queued: 1,
      queueMs: { samples: 1, p95: 120_000 }, queuedAgeMs: { samples: 1, max: 600_000 } });
  });

  it('does not manufacture zero queue times from no-step cancellations', () => {
    const result = report([job({ conclusion: 'cancelled', steps: [], started_at: created })]);
    expect(result.labels[0]).toMatchObject({ cancelledWithoutSteps: 1,
      queueMs: { samples: 0, p50: null, p95: null, max: null } });
  });

  it('measures a cancelled job that actually executed', () => {
    expect(report([job({ conclusion: 'cancelled' })]).jobs[0]).toMatchObject({ state: 'started', queueMs: 120_000 });
  });

  it('retains skipped jobs without using synthesized timing', () => {
    expect(report([job({ conclusion: 'skipped' })]).jobs[0]).toMatchObject({ state: 'skipped', queueMs: null });
  });

  it('measures an executing job without inventing its final duration', () => {
    expect(report([job({ status: 'in_progress', completed_at: null })]).jobs[0])
      .toMatchObject({ state: 'started', queueMs: 120_000, executionMs: null });
  });

  it.each([
    { created_at: null }, { created_at: 'broken' }, { created_at: observedAt },
    { started_at: '2026-10-26T03:11:00Z' }, { started_at: '2026-10-26T02:59:00Z' },
    { completed_at: created }, { completed_at: null }, { completed_at: '2026-10-26T03:11:00Z' },
    { runner_id: 0 }, { steps: undefined }, { steps: [] },
    { steps: [{ status: 'completed', conclusion: 'skipped', started_at: started }] },
    { status: 'future_api_state' }, { created_at: '2026-02-30T03:00:00Z' },
    { steps: [{ status: 'completed', started_at: '2099-01-01T00:00:00Z' }] },
    { steps: [{ status: 'completed', started_at: created }] },
    { conclusion: 'cancelled', steps: undefined, runner_id: undefined },
  ])('leaves absent or contradictory timing unknown: %j', overrides => {
    expect(report([job(overrides)]).jobs[0]).toMatchObject({ state: 'unknown', queueMs: null, executionMs: null });
  });

  it('keeps missing labels explicit and de-duplicates labels without multiplying total jobs', () => {
    const result = report([job({ labels: [] }), job({ id: 2, labels: ['self-hosted', 'linux', 'linux'] })]);
    expect(result.totalJobs).toBe(2);
    expect(result.labels.map((row: { label: string | null }) => row.label)).toEqual([null, 'linux', 'self-hosted']);
    expect(result.labels.every((row: { jobs: number }) => row.jobs === 1)).toBe(true);
  });

  it('accepts complete zero-job captures without inventing measurements', () => {
    expect(report([])).toMatchObject({ totalJobs: 0, labels: [], jobs: [] });
  });

  it.each([
    { pages: [] }, { pages: [{ total_count: 2, jobs: [job()] }] },
    { pages: [{ total_count: 1, jobs: [] }] }, { pages: [{ message: 'Forbidden' }] },
    { pages: [{ total_count: 1, jobs: [job()] }, { total_count: 2, jobs: [] }] },
    { pages: [{ total_count: 2, jobs: [job(), job()] }] },
    { pages: [{ total_count: 1, jobs: [job({ run_attempt: 2 })] }] },
    { pages: [{ total_count: 1, jobs: [job({ run_id: 11 })] }] },
    { pages: [{ total_count: 1, jobs: [job({ id: null })] }] },
    { repository: 'bad/repo/extra' }, { repository: ['ashlrai/phantom'] },
    { observedAt: 'not-a-date' }, { observedAt: '2026-02-30T00:00:00Z' }, { runAttempt: 0 },
  ])('rejects incomplete or ambiguous capture evidence: %j', overrides => {
    expect(() => buildQueueReport([{ ...capture(), ...overrides }])).toThrow();
  });

  it('rejects duplicate captures but preserves distinct rerun attempts', () => {
    expect(() => buildQueueReport([capture(), capture()])).toThrow('Duplicate');
    expect(() => buildQueueReport([capture(), { ...capture(), repository: 'AshlrAI/Phantom' }])).toThrow('Duplicate');
    const second = { ...capture([job({ run_attempt: 2 })]), runAttempt: 2 };
    expect(buildQueueReport([capture(), second]).totalJobs).toBe(2);
  });

  it('escapes untrusted Markdown and omits arbitrary input payloads', () => {
    const result = report([job({ labels: ['mac|<script>\n`x`'], secret: 'PRIVATE_SENTINEL' })]);
    const rendered = renderQueueReport(result);
    expect(rendered).toContain('mac&#124;&#60;script&#62;&#10;&#96;x&#96;');
    expect(JSON.stringify(result)).not.toContain('PRIVATE_SENTINEL');
    expect(rendered).toContain('does not verify PR heads');
  });
});

describe('CI queue report command', () => {
  it.each([{ args: [] }, { args: ['--unknown'] }, { args: ['--json'] }])('fails usage before reading evidence: %j', async ({ args }) => {
    const { io, output } = outputIO('');
    expect(await main(args, io)).toBe(2);
    expect(output.reads).toEqual([]);
    expect(output.stdout).toBe('');
  });

  it('shows help without reading files', async () => {
    const { io, output } = outputIO('');
    expect(await main(['--help'], io)).toBe(0);
    expect(output.reads).toEqual([]);
    expect(output.stdout).toContain('Usage:');
  });

  it.each([false, true])('renders validated evidence with json=%s', async json => {
    const { io, output } = outputIO(JSON.stringify(capture()));
    expect(await main([...(json ? ['--json'] : []), 'capture.json'], io)).toBe(0);
    expect(output.reads).toEqual(['capture.json']);
    expect(output.stderr).toBe('');
    if (json) expect(JSON.parse(output.stdout).labels[0].queueMs.p95).toBe(120_000);
    else expect(output.stdout).toContain('| macos-15 | 1 | 1 |');
  });

  it.each(['PRIVATE_SENTINEL malformed JSON', new Error('PRIVATE_SENTINEL file error')])('fails closed without printing input or filesystem error contents', async contents => {
      const { io, output } = outputIO(contents);
      expect(await main(['capture.json'], io)).toBe(1);
      expect(output.stdout).toBe('');
      expect(output.stderr).toContain('could not be read as JSON');
      expect(output.stderr).not.toContain('PRIVATE_SENTINEL');
    });

  it('does not emit a partial report when a later capture is invalid', async () => {
    const { io, output } = outputIO(JSON.stringify(capture()));
    expect(await main(['one.json', 'duplicate.json'], io)).toBe(1);
    expect(output.stdout).toBe('');
  });
});
