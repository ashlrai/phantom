import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { classifyEmpty } from '../src/core/fleet/empty-jobs.js';
import { cmdJobsRetryEmpty, planEmptyRetries } from '../src/cli/jobs-retry-empty.js';

const queue = ['A', 'B', 'C', 'D'].map(id => `- READY RQ-${id} (P1, pool=codex-personal, tier=work, repo=phantom): Implement ${id}. Acceptance: tests pass.`).join('\n') + '\n';
describe('retry empty jobs', () => {
  it.each([['Task is too broad', 'too-broad'], ['Tests timed out', 'tests-timeout'], ['No changes needed', 'already-done'], ['Duplicate of an earlier job', 'duplicate']])('classifies %s', (text, reason) => {
    expect(classifyEmpty(text, null).class).toBe(reason);
  });
  it('plans only eligible jobs with their original repo and a smaller goal', () => {
    const jobs = ['too-broad', 'tests-timeout', 'already-done', 'duplicate'].map((_kind, i) => ({ id: `RQ-${String.fromCharCode(65 + i)}`, lane: 'x', ...classifyEmpty(['too broad', 'tests timed out', 'no changes needed', 'duplicate job'][i]!, null) }));
    const lines = planEmptyRetries(queue, jobs, new Set());
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('repo=phantom');
    expect(lines[0]).toContain('one smallest independently shippable part');
    expect(lines[1]).toContain('Ship partial, list the gap');
    expect(planEmptyRetries(queue.replace('- READY RQ-A', '- CLAIMED codex-personal now RQ-A'), jobs, new Set())).toHaveLength(2);
  });
  it('previews, applies once, and retains receipts after queue removal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'retry-empty-'));
    const oldRuns = process.env.ASHLR_RUNS_DIR, oldWt = process.env.ASHLR_WT_DIR;
    try {
      process.env.ASHLR_RUNS_DIR = dir; process.env.ASHLR_WT_DIR = join(dir, 'wt');
      await mkdir(join(dir, 'metrics'), { recursive: true }); await mkdir(join(dir, 'queue'));
      const path = join(dir, 'queue/router-queue.md');
      await writeFile(path, queue);
      await writeFile(join(dir, 'metrics/jobs.jsonl'), JSON.stringify({ event: 'outcome', empty: true, job: 'RQ-A', ts: new Date().toISOString() }));
      await writeFile(join(dir, 'RQ-A.log'), 'Task is too broad');
      const output = vi.spyOn(console, 'log').mockImplementation(() => undefined);
      expect(await cmdJobsRetryEmpty(['--dry-run'])).toBe(0);
      expect(output).toHaveBeenCalledWith(expect.stringContaining('retry-empty-source=RQ-A'));
      output.mockRestore();
      expect(await readFile(path, 'utf8')).toBe(queue);
      expect(await cmdJobsRetryEmpty(['--apply'])).toBe(0);
      expect((await readFile(path, 'utf8')).match(/retry-empty-source=RQ-A/g)).toHaveLength(1);
      await writeFile(path, queue);
      expect(await cmdJobsRetryEmpty(['--apply'])).toBe(0);
      expect(await readFile(path, 'utf8')).toBe(queue);
    } finally {
      if (oldRuns === undefined) delete process.env.ASHLR_RUNS_DIR; else process.env.ASHLR_RUNS_DIR = oldRuns;
      if (oldWt === undefined) delete process.env.ASHLR_WT_DIR; else process.env.ASHLR_WT_DIR = oldWt;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
