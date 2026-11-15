import { describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cmdJobsRetryEmpty } from '../src/cli/jobs-retry-empty.js';

// One eligible source (RQ-OK, too-broad) plus unrelated queue bytes that must survive untouched.
const queueText = [
  '# router queue fixture',
  '',
  '- READY RQ-OTHER (P2, pool=claude, tier=mid, repo=otherrepo): Unrelated pending work.',
  '- READY RQ-OK (P1, pool=codex-personal, tier=work, repo=phantom): Implement the widget. Acceptance: tests pass.',
  '',
].join('\n');

interface Fixture { dir: string; path: string; oldRuns: string | undefined; oldWt: string | undefined }

async function fixture(): Promise<Fixture> {
  const dir = await mkdtemp(join(tmpdir(), 'retry-empty-qual-'));
  const oldRuns = process.env.ASHLR_RUNS_DIR;
  const oldWt = process.env.ASHLR_WT_DIR;
  process.env.ASHLR_RUNS_DIR = dir;
  process.env.ASHLR_WT_DIR = join(dir, 'wt');
  await mkdir(join(dir, 'metrics'), { recursive: true });
  await mkdir(join(dir, 'queue'));
  await writeFile(join(dir, 'metrics/jobs.jsonl'), JSON.stringify({ event: 'outcome', empty: true, job: 'RQ-OK', lane: 'codex-personal', ts: new Date().toISOString() }) + '\n');
  await writeFile(join(dir, 'RQ-OK.log'), 'Task is too broad');
  return { dir, path: join(dir, 'queue/router-queue.md'), oldRuns, oldWt };
}

async function teardown(f: Fixture): Promise<void> {
  if (f.oldRuns === undefined) delete process.env.ASHLR_RUNS_DIR; else process.env.ASHLR_RUNS_DIR = f.oldRuns;
  if (f.oldWt === undefined) delete process.env.ASHLR_WT_DIR; else process.env.ASHLR_WT_DIR = f.oldWt;
  await rm(f.dir, { recursive: true, force: true });
}

function capture(): { out: string[]; err: string[]; restore: () => void } {
  const out: string[] = [];
  const err: string[] = [];
  const logSpy = vi.spyOn(console, 'log').mockImplementation((...parts: unknown[]) => { out.push(parts.map(String).join(' ')); });
  const errSpy = vi.spyOn(console, 'error').mockImplementation((...parts: unknown[]) => { err.push(parts.map(String).join(' ')); });
  return { out, err, restore: () => { logSpy.mockRestore(); errSpy.mockRestore(); } };
}

describe('retry empty jobs: owner qualification negatives (RQ-PHX-EMPTYRETRYOWNERQUALIFY292S)', () => {
  it('dry-run leaves queue bytes, file mode and receipt directory unchanged', async () => {
    const f = await fixture();
    const cap = capture();
    try {
      await writeFile(f.path, queueText);
      const modeBefore = (await stat(f.path)).mode;
      expect(await cmdJobsRetryEmpty(['--dry-run', '--json'])).toBe(0);
      const report = JSON.parse(cap.out[cap.out.length - 1]!) as { applied: boolean; lines: string[] };
      expect(report.applied).toBe(false);
      expect(report.lines).toHaveLength(1);
      expect(report.lines[0]).toContain('retry-empty-source=RQ-OK');
      expect(await readFile(f.path, 'utf8')).toBe(queueText);
      expect((await stat(f.path)).mode).toBe(modeBefore);
      await expect(readdir(join(f.dir, 'queue', 'empty-retry-receipts'))).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      cap.restore();
      await teardown(f);
    }
  });

  it('non-regular queue target and missing queue fail nonzero without enqueueing', async () => {
    const f = await fixture();
    const cap = capture();
    try {
      const real = join(f.dir, 'queue', 'real.md');
      const link = join(f.dir, 'queue', 'linked.md');
      await writeFile(real, queueText);
      await symlink(real, link);

      // Symlink: the queue reads fine, but the writer's lstat regular-file guard must refuse.
      expect(await cmdJobsRetryEmpty(['--apply', '--json', '--file', link])).toBe(1);
      expect(cap.err.join('\n')).toContain('Could not update queue');
      expect(cap.out.filter(line => line.includes('RQ-EMPTYRETRY-'))).toHaveLength(0);
      expect(await readFile(real, 'utf8')).toBe(queueText);
      await expect(readdir(join(f.dir, 'queue', 'empty-retry-receipts'))).rejects.toMatchObject({ code: 'ENOENT' });

      // Missing file: unreadable queue fails before any planning or enqueue.
      cap.out.length = 0; cap.err.length = 0;
      expect(await cmdJobsRetryEmpty(['--apply', '--json', '--file', join(f.dir, 'queue', 'absent.md')])).toBe(1);
      expect(cap.err.length).toBeGreaterThan(0);
      expect(cap.out.filter(line => line.includes('RQ-EMPTYRETRY-'))).toHaveLength(0);
      expect(await readFile(real, 'utf8')).toBe(queueText);
    } finally {
      cap.restore();
      await teardown(f);
    }
  });

  it('a pre-existing durable receipt suppresses replay across fresh invocations', async () => {
    const f = await fixture();
    const cap = capture();
    try {
      await writeFile(f.path, queueText);
      const receiptName = createHash('sha256').update('RQ-OK').digest('hex');
      const receiptDir = join(f.dir, 'queue', 'empty-retry-receipts');
      await mkdir(receiptDir);
      await writeFile(join(receiptDir, receiptName), '');

      // Two fresh command invocations: the receipt alone suppresses every enqueue.
      for (let i = 0; i < 2; i++) {
        cap.out.length = 0;
        expect(await cmdJobsRetryEmpty(['--apply', '--json'])).toBe(0);
        const report = JSON.parse(cap.out[cap.out.length - 1]!) as { applied: boolean; lines: string[] };
        expect(report.applied).toBe(true);
        expect(report.lines).toHaveLength(0);
        expect(await readFile(f.path, 'utf8')).toBe(queueText);
      }
      // Unrelated bytes and the unrelated entry's pool/tier/repo survive byte-for-byte.
      const after = await readFile(f.path, 'utf8');
      expect(after).toBe(queueText);
      expect(after).toContain('pool=claude, tier=mid, repo=otherrepo');
      expect(after).not.toContain('RQ-EMPTYRETRY-');
    } finally {
      cap.restore();
      await teardown(f);
    }
  });
});
