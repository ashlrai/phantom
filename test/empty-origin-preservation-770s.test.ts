import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { cmdJobsYield } from '../src/cli/jobs-yield.js';

it('filters before sampling and preserves unknowns through the command', async () => {
  const root = await mkdtemp(join(tmpdir(), 'empty-preservation-'));
  const now = Date.parse('2026-11-18T00:00:00Z');
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const rows = [
    { id: 'RQ-PHX-GAPOLD', lane: 'a', empty: true, offset: -3000 },
    { id: 'RQ-PHX-LANDDIRTY1', lane: 'a', empty: true, offset: -1000 },
    { id: 'RQ-OTHER', lane: 'b', empty: true, offset: 0 },
    { id: 'RQ-GOOD', lane: 'a', empty: false, offset: -2000 },
  ].map(({ offset, ...row }) => JSON.stringify({ ...row, ts: new Date(now + offset).toISOString(), event: 'finish' }));
  const read = vi.fn(async (_path: string, onLine: (line: string) => void) => { rows.forEach(onLine); return true; });
  try {
    await mkdir(join(root, 'metrics'));
    await writeFile(join(root, 'RQ-PHX-LANDDIRTY1.log'), 'no eligible PRs found');
    const args = ['--metrics', join(root, 'metrics', 'jobs.jsonl'), '--lane', 'a', '--last', '2'];
    expect(await cmdJobsYield([...args, '--json'], read, now, true)).toBe(0);
    const report = JSON.parse(output.mock.calls.at(-1)![0] as string);
    expect(report).toMatchObject({ sampled: 2, total: 1, jobs: [{ id: 'RQ-PHX-LANDDIRTY1', generator: 'LAND*DIRTY', cause: 'no-eligible-pr', tokens: null }], families: [{ wasted_tokens: null }] });
    expect(await cmdJobsYield(args, read, now, true)).toBe(0);
    expect(output.mock.calls.at(-1)![0]).toContain('a: 1 of 2 empty');
    for (const flags of [['--lane'], ['--lane', '../bad'], ['--lane', 'a', '--lane', 'b'], ['--last'], ['--last', '9007199254740992'], ['--last', '1', '--last', '2']]) expect(await cmdJobsYield(flags, read, now, true)).toBe(2);
    expect(await cmdJobsYield(['--json'], async () => false, now, true)).toBe(1);
    expect(JSON.parse(output.mock.calls.at(-1)![0] as string)).toMatchObject({ known: false, total: null, sampled: null });
    expect(await cmdJobsYield(['--by', 'lane', '--json'], read, now)).toBe(0);
    expect(JSON.parse(output.mock.calls.at(-1)![0] as string).schema).toBe('jobs.yield-by.v1');
  } finally { output.mockRestore(); error.mockRestore(); await rm(root, { recursive: true, force: true }); }
});
