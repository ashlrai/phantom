import { describe, expect, it } from 'vitest';
import { parseIdeas, readIdeas } from '../src/core/fleet/ideas.js';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('ideas', () => {
  it('preserves vision order, fills missing metadata and appends queue jobs once', () => {
    expect(parseIdeas('- READY RQ-B: Second bet\n- READY RQ-A (repo=one, pool=work): First bet', '- READY RQ-B (repo=two, pool=fast): Queue wording\n- DONE RQ-C: done\n- READY RQ-C (repo=three, pool=work): Third bet')).toEqual([
      { id: 'RQ-B', repo: 'two', lane: 'fast', goal: 'Second bet' },
      { id: 'RQ-A', repo: 'one', lane: 'work', goal: 'First bet' },
      { id: 'RQ-C', repo: 'three', lane: 'work', goal: 'Third bet' },
    ]);
  });
  it('reports missing sources separately from an empty list', async () => {
    const root = await mkdtemp(join(tmpdir(), 'ideas-'));
    try {
      await mkdir(join(root, 'leader'));
      await writeFile(join(root, 'leader', 'VISION.md'), '');
      expect(await readIdeas(root)).toEqual({ schema: 'fleet.ideas.v1', ideas: [], missing: ['queue/router-queue.md'] });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});
