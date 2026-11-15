import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdJobsRetryEmpty } from '../src/cli/jobs-retry-empty.js';

// Mixed queue: one eligible source, rejected/ambiguous sources, and unrelated bytes.
const queueText = [
  '# router queue fixture',
  '',
  '- READY RQ-OTHER-JOB (P2, pool=claude, tier=mid, repo=otherrepo): Unrelated pending work.',
  '- DONE RQ-OLD (P1, pool=codex-personal, tier=work, repo=phantom): Finished earlier.',
  '- READY RQ-OK (P1, pool=codex-personal, tier=work, repo=phantom): Implement the widget. Acceptance: tests pass.',
  '- READY RQ-TMO (P1, pool=codex-personal, tier=work, repo=phantom): Fix the flaky suite. Acceptance: tests pass.',
  '- CLAIMED codex-personal now RQ-TMO (retry of earlier attempt)',
  '- READY RQ-NOROUTE (P1): Tidy the docs.',
  '- READY RQ-DONE (P1, pool=codex-personal, tier=work, repo=phantom): Already shipped work.',
  '- READY RQ-MISC (P1, pool=codex-personal, tier=work, repo=phantom): Misc job.',
  '- READY RQ-AGAIN (P1, pool=devin, tier=fast, repo=phantom): Retry the widget. retry-empty-source=RQ-OLD',
  '',
].join('\n');

const ledgerRows = [
  { event: 'outcome', empty: true, job: 'RQ-OK', lane: 'codex-personal', ts: new Date().toISOString() },
  { event: 'outcome', empty: true, job: 'RQ-TMO', lane: 'codex-personal', ts: new Date().toISOString() },
  { event: 'outcome', empty: true, job: 'RQ-NOROUTE', lane: 'codex-personal', ts: new Date().toISOString() },
  { event: 'outcome', empty: true, job: 'RQ-DONE', lane: 'codex-personal', ts: new Date().toISOString() },
  { event: 'outcome', empty: true, job: 'RQ-MISC', lane: 'codex-personal', ts: new Date().toISOString() },
  { event: 'outcome', empty: true, job: 'RQ-AGAIN', lane: 'devin', ts: new Date().toISOString() },
];

const logTexts: Record<string, string> = {
  'RQ-OK': 'Task is too broad',
  'RQ-TMO': 'The tests timed out on CI',
  'RQ-NOROUTE': 'Task is too broad',
  'RQ-DONE': 'No changes needed',
  'RQ-MISC': 'The cat sat on the mat',
  'RQ-AGAIN': 'Task is too broad',
};

describe('retry empty jobs: original preservation (RQ-EMPTYRETRYN9RQ8 / PR #4501)', () => {
  it('keeps unrelated queue bytes, plans one retry, and honors durable receipts across invocations', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'retry-empty-preserve-'));
    const oldRuns = process.env.ASHLR_RUNS_DIR;
    const oldWt = process.env.ASHLR_WT_DIR;
    const out: string[] = [];
    const logSpy = vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => { out.push(parts.map(String).join(' ')); });
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      process.env.ASHLR_RUNS_DIR = dir;
      process.env.ASHLR_WT_DIR = join(dir, 'wt');
      await mkdir(join(dir, 'metrics'), { recursive: true });
      await mkdir(join(dir, 'queue'));
      const path = join(dir, 'queue/router-queue.md');
      await writeFile(path, queueText);
      await writeFile(join(dir, 'metrics/jobs.jsonl'), ledgerRows.map(row => JSON.stringify(row)).join('\n') + '\n');
      for (const [id, text] of Object.entries(logTexts)) await writeFile(join(dir, `${id}.log`), text);

      // Dry-run JSON plans exactly one retry and mutates nothing on disk.
      out.length = 0;
      expect(await cmdJobsRetryEmpty(['--dry-run', '--json'])).toBe(0);
      const dry = JSON.parse(out[out.length - 1]!) as { schema: string; applied: boolean; lines: string[] };
      expect(dry.schema).toBe('jobs.retry-empty.v1');
      expect(dry.applied).toBe(false);
      expect(dry.lines).toHaveLength(1);
      expect(dry.lines[0]).toContain('retry-empty-source=RQ-OK');
      expect(dry.lines[0]).toContain('pool=codex-personal');
      expect(dry.lines[0]).toContain('tier=work');
      expect(dry.lines[0]).toContain('repo=phantom');
      expect(await readFile(path, 'utf8')).toBe(queueText);
      await expect(readdir(join(dir, 'queue', 'empty-retry-receipts'))).rejects.toMatchObject({ code: 'ENOENT' });

      // Apply appends exactly one retry line and preserves every prior byte.
      out.length = 0;
      expect(await cmdJobsRetryEmpty(['--apply', '--json'])).toBe(0);
      const applied = JSON.parse(out[out.length - 1]!) as { applied: boolean; lines: string[] };
      expect(applied.applied).toBe(true);
      expect(applied.lines).toHaveLength(1);
      const afterApply = await readFile(path, 'utf8');
      expect(afterApply.startsWith(queueText)).toBe(true);
      // One new retry line: the fixture already carries one retry-empty-source marker (RQ-AGAIN's source entry).
      expect(afterApply.match(/retry-empty-source=/g)!.length).toBe(queueText.match(/retry-empty-source=/g)!.length + 1);
      expect(afterApply.match(/RQ-EMPTYRETRY-/g)).toHaveLength(1);
      for (const fragment of ['# router queue fixture', 'RQ-OTHER-JOB', 'RQ-OLD', 'CLAIMED codex-personal now RQ-TMO', 'RQ-NOROUTE', 'RQ-MISC', 'RQ-AGAIN']) {
        expect(afterApply).toContain(fragment);
      }
      // No retry is invented for ambiguous, unrouted, ineligible or already-retried sources.
      for (const id of ['RQ-TMO', 'RQ-NOROUTE', 'RQ-DONE', 'RQ-MISC', 'RQ-AGAIN']) {
        expect(afterApply).not.toContain(`retry-empty-source=${id}`);
      }
      expect(await readdir(join(dir, 'queue', 'empty-retry-receipts'))).toHaveLength(1);

      // A fresh invocation after the retry line is removed still sees the durable receipt.
      await writeFile(path, queueText);
      out.length = 0;
      expect(await cmdJobsRetryEmpty(['--apply', '--json'])).toBe(0);
      const second = JSON.parse(out[out.length - 1]!) as { applied: boolean; lines: string[] };
      expect(second.applied).toBe(true);
      expect(second.lines).toHaveLength(0);
      expect(await readFile(path, 'utf8')).toBe(queueText);
    } finally {
      logSpy.mockRestore();
      errSpy.mockRestore();
      if (oldRuns === undefined) delete process.env.ASHLR_RUNS_DIR; else process.env.ASHLR_RUNS_DIR = oldRuns;
      if (oldWt === undefined) delete process.env.ASHLR_WT_DIR; else process.env.ASHLR_WT_DIR = oldWt;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
