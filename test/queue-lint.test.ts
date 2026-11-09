import { readFile, mkdtemp, mkdir, writeFile, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { lintQueue } from '../src/core/queue/lint.js';
import { cmdQueue } from '../src/cli/queue.js';

it('reports duplicate, invalid, old and unknown rows from fixture queues', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'queue-lint-')));
  const router = await readFile('test/fixtures/queue-lint/router-queue.md', 'utf8');
  const ready = await readFile('test/fixtures/queue-lint/ready.tsv', 'utf8');
  const report = await lintQueue(router, ready, root, root, Date.parse('2026-01-01T03:00:00Z'));
  expect(report.duplicates).toEqual([{ line: 3, id: 'RQ-ONE', reason: 'Already CLAIMED on line 1' }, { line: 4, id: 'RQ-TWO', reason: 'Already DONE on line 2' }]);
  expect(report.old).toEqual([{ line: 3, id: 'RQ-ONE', reason: 'READY for more than 2 hours' }]);
  expect(report.unknownAge).toEqual([{ line: 5, id: 'RQ-UNKNOWN', reason: 'Queue time is unknown' }]);
  expect(report.invalid[0]).toMatchObject({ line: 1, id: 'RQ-BAD' });
  expect(report.invalid[0]!.reason).toContain('Unknown lane; Unknown tier');
  expect(report.invalid).toHaveLength(1);
  await mkdir(join(root, 'Projects/ashlrai/phantom'), { recursive: true });
  await mkdir(join(root, 'queue/prompts'), { recursive: true });
  const prompt = join(root, 'queue/prompts/job.md');
  await writeFile(prompt, 'work');
  expect((await lintQueue('', `RQ-OK\tphantom\tclaude\twork\t${prompt}`, root, root, 0)).invalid).toEqual([]);
});

it('routes the JSON command and reports missing files', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const root = await mkdtemp(join(tmpdir(), 'queue-lint-cli-'));
  vi.stubEnv('ASHLR_RUNS_DIR', root);
  try {
    expect(await cmdQueue(['lint', '--json'])).toBe(1);
    await mkdir(join(root, 'queue'));
    await writeFile(join(root, 'queue/router-queue.md'), '');
    await writeFile(join(root, 'queue/ready.tsv'), '');
    expect(await cmdQueue(['lint', '--json'])).toBe(0);
    expect(JSON.parse(log.mock.calls[0]![0] as string).schema).toBe('queue.lint.v1');
    expect(await cmdQueue(['lint', '--bad'])).toBe(2);
  } finally { vi.unstubAllEnvs(); log.mockRestore(); error.mockRestore(); }
});
