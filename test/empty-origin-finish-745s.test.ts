import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { cmdJobsYield } from '../src/cli/jobs-yield.js';

it('samples the newest finishes in the selected lane through the real CLI', async () => {
  const root = await mkdtemp(join(tmpdir(), 'empty-origin-'));
  const now = Date.parse('2026-11-18T00:00:00Z');
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const rows = [
    { id: 'RQ-PHX-GAPOLD', lane: 'a', empty: true, ts: now - 3000 },
    { id: 'RQ-PHX-LANDDIRTY1', lane: 'a', empty: true, ts: now - 1000 },
    { id: 'RQ-OTHER', lane: 'b', empty: true, ts: now },
    { id: 'RQ-GOOD', lane: 'a', empty: false, ts: now - 2000 },
  ].map(row => JSON.stringify({ ...row, ts: new Date(row.ts).toISOString(), event: 'finish' }));
  const read = vi.fn(async (_path: string, onLine: (line: string) => void) => { rows.forEach(onLine); return true; });
  try {
    await mkdir(join(root, 'metrics'));
    await writeFile(join(root, 'RQ-PHX-LANDDIRTY1.log'), 'no eligible PRs found\nprivate evidence');
    const args = ['--metrics', join(root, 'metrics', 'jobs.jsonl'), '--lane', 'a', '--last', '2'];
    expect(await cmdJobsYield([...args, '--json'], read, now, true)).toBe(0);
    const report = JSON.parse(output.mock.calls.at(-1)![0] as string);
    expect(report).toMatchObject({ sampled: 2, total: 1, jobs: [{ id: 'RQ-PHX-LANDDIRTY1', generator: 'LAND*DIRTY', cause: 'no-eligible-pr', tokens: null }] });
    expect(JSON.stringify(report)).not.toContain('private evidence');
    expect(await cmdJobsYield(args, read, now, true)).toBe(0);
    expect(output.mock.calls.at(-1)![0]).toContain('Generator (inferred from id)');
    expect(output.mock.calls.at(-1)![0]).not.toContain('private evidence');
    read.mockClear();
    for (const flags of [['--last', '0'], ['--last', '1.5'], ['--last', '2', '--last', '1'], ['--lane', 'a', '--lane', 'b']]) {
      expect(await cmdJobsYield(flags, read, now, true)).toBe(2);
    }
    expect(read).not.toHaveBeenCalled();
    expect(await cmdJobsYield(['--json'], read, now)).toBe(0);
    expect(JSON.parse(output.mock.calls.at(-1)![0] as string).schema).toBe('jobs.yield.v1');
  } finally {
    output.mockRestore(); error.mockRestore(); await rm(root, { recursive: true, force: true });
  }
});
