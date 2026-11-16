import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdJobsRetryEmpty, planEmptyRetries } from '../src/cli/jobs-retry-empty.js';

// Regression for RQ-PHX-REDTYPEFIXC213 (supersedes #4501): the mode flag parse
// must narrow '--dry-run'|'--apply' explicitly — a blanket `as typeof mode` cast
// of arg.slice(2) is a TS2352 conversion error, and a wrong runtime type would
// misroute dry-run/apply handling.
const queue = '- READY RQ-Z (P1, pool=codex-personal, tier=work, repo=phantom): Implement Z. Acceptance: tests pass.\n';

async function withRuns(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'redtypefix-c213-'));
  const oldRuns = process.env.ASHLR_RUNS_DIR, oldWt = process.env.ASHLR_WT_DIR;
  try {
    process.env.ASHLR_RUNS_DIR = dir; process.env.ASHLR_WT_DIR = join(dir, 'wt');
    await mkdir(join(dir, 'metrics'), { recursive: true });
    await mkdir(join(dir, 'queue'), { recursive: true });
    await writeFile(join(dir, 'metrics/jobs.jsonl'), '');
    await writeFile(join(dir, 'queue/router-queue.md'), queue);
    await fn(dir);
  } finally {
    if (oldRuns === undefined) delete process.env.ASHLR_RUNS_DIR; else process.env.ASHLR_RUNS_DIR = oldRuns;
    if (oldWt === undefined) delete process.env.ASHLR_WT_DIR; else process.env.ASHLR_WT_DIR = oldWt;
    await rm(dir, { recursive: true, force: true });
  }
}

describe('jobs retry-empty mode parsing', () => {
  it('parses --dry-run and reports the dry-run JSON shape', async () => {
    await withRuns(async () => {
      const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      expect(await cmdJobsRetryEmpty(['--dry-run', '--json'])).toBe(0);
      const calls = output.mock.calls.map(call => call[0]);
      output.mockRestore();
      const report = JSON.parse(calls[0] as string);
      expect(report).toMatchObject({ schema: 'jobs.retry-empty.v1', applied: false, lines: [] });
    });
  });

  it('parses --apply and reports applied mode without eligible jobs', async () => {
    await withRuns(async () => {
      const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      expect(await cmdJobsRetryEmpty(['--apply', '--json'])).toBe(0);
      const calls = output.mock.calls.map(call => call[0]);
      output.mockRestore();
      const report = JSON.parse(calls[0] as string);
      expect(report).toMatchObject({ schema: 'jobs.retry-empty.v1', applied: true });
    });
  });

  it('rejects a second mode flag instead of overriding the first', async () => {
    await withRuns(async () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      expect(await cmdJobsRetryEmpty(['--dry-run', '--apply'])).toBe(2);
      expect(await cmdJobsRetryEmpty(['--apply', '--dry-run'])).toBe(2);
      expect(await cmdJobsRetryEmpty(['--dry-run', '--dry-run'])).toBe(2);
      err.mockRestore();
    });
  });

  it('rejects unknown flags and a missing mode', async () => {
    await withRuns(async () => {
      const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      expect(await cmdJobsRetryEmpty(['--bogus'])).toBe(2);
      expect(await cmdJobsRetryEmpty(['--json'])).toBe(2);
      err.mockRestore();
    });
  });
});

describe('planEmptyRetries eligibility guards', () => {
  const jobs = [
    { id: 'RQ-Z', lane: 'x', class: 'too-broad' as const, reason: 'The task was too broad.' },
  ];

  it('skips a job whose queue line is ambiguous', () => {
    const dup = queue + queue;
    expect(planEmptyRetries(dup, jobs, new Set())).toHaveLength(0);
  });

  it('emits one scoped retry line carrying the original route', () => {
    const lines = planEmptyRetries(queue, jobs, new Set());
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('pool=codex-personal');
    expect(lines[0]).toContain('repo=phantom');
    expect(lines[0]).toContain('retry-empty-source=RQ-Z');
  });
});
