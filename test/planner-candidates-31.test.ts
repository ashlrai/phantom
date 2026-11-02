import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readPlannerCandidates } from '../src/core/fleet/planner-candidates.js';

async function runsRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'planner-candidates-'));
  await mkdir(join(dir, 'queue'), { recursive: true });
  return dir;
}
const path = (dir: string): string => join(dir, 'queue', 'planner-candidates.json');

describe('readPlannerCandidates', () => {
  it('reports missing when the file is absent', async () => {
    const dir = await runsRoot();
    try {
      expect(await readPlannerCandidates(dir)).toEqual({ source: 'missing', path: path(dir), candidates: [], lastProvider: null });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('reads a valid slate with lastProvider', async () => {
    const dir = await runsRoot();
    try {
      await writeFile(path(dir), JSON.stringify({
        v: 1,
        candidates: [
          { provider: 'codex-personal', argv: ['echo'] },
          { provider: 'claude-api', argv: ['echo', 'a', 'b'] },
        ],
        lastProvider: 'codex-personal',
      }));
      expect(await readPlannerCandidates(dir)).toEqual({
        source: 'ok',
        path: path(dir),
        candidates: [
          { provider: 'codex-personal', argv: ['echo'] },
          { provider: 'claude-api', argv: ['echo', 'a', 'b'] },
        ],
        lastProvider: 'codex-personal',
      });
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('treats a missing lastProvider as null and rejects malformed files', async () => {
    const dir = await runsRoot();
    try {
      await writeFile(path(dir), JSON.stringify({ v: 1, candidates: [{ provider: 'sol', argv: ['echo'] }] }));
      expect((await readPlannerCandidates(dir)).lastProvider).toBeNull();
      for (const bad of [
        'not json',
        '{"v":2,"candidates":[]}',
        '{"v":1}',
        '{"v":1,"candidates":{}}',
        '{"v":1,"candidates":[{"provider":7,"argv":[]}]}',
        '{"v":1,"candidates":[{"provider":"","argv":[]}]}',
        '{"v":1,"candidates":[{"provider":"x"}]}',
        '{"v":1,"candidates":[{"provider":"x","argv":["a",4]}]}',
        '{"v":1,"candidates":[],"lastProvider":5}',
        '[]',
      ]) {
        await writeFile(path(dir), bad);
        expect(await readPlannerCandidates(dir), bad).toEqual({ source: 'invalid', path: path(dir), candidates: [], lastProvider: null });
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  it('reads a file over the 64 KB bound as invalid and a directory as invalid', async () => {
    const dir = await runsRoot();
    try {
      const big = { v: 1, candidates: [{ provider: 'x', argv: ['echo'] }], pad: 'y'.repeat(70 * 1024) };
      await writeFile(path(dir), JSON.stringify(big));
      expect((await readPlannerCandidates(dir)).source).toBe('invalid');
      await rm(path(dir));
      await mkdir(path(dir));
      expect((await readPlannerCandidates(dir)).source).toBe('invalid');
    } finally { await rm(dir, { recursive: true, force: true }); }
  });
});
