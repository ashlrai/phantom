import { describe, expect, it, vi } from 'vitest';
import type { Proposal, WorkItem } from '../src/core/types.js';
import { defaultConfig } from '../src/core/config.js';

vi.mock('node:fs', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs')>(),
  appendFileSync: vi.fn(),
  mkdirSync: vi.fn(),
}));
vi.mock('../src/core/run/sandboxed-engine.js', () => ({
  runApiModelSandboxed: vi.fn(async (engine: string) => ({
    proposalId: `proposal-${engine}`,
    state: { tasks: [{ result: engine === 'local-coder' ? 'local diff' : undefined }] },
  })),
}));
vi.mock('../src/core/fleet/manager.js', () => ({
  judgeProposal: vi.fn(async (_proposal: Proposal) => ({
    verdict: 'review', value: 3, correctness: 3, scope: 3, alignment: 3,
  })),
}));

import { judgeProposal } from '../src/core/fleet/manager.js';
import { raceTask } from '../src/core/fleet/model-racing.js';

describe('model racing proposal contract', () => {
  it('passes complete pending proposals to the judge with optional diffs preserved', async () => {
    const cfg = defaultConfig();
    cfg.foundry = { ...cfg.foundry, modelRacing: { enabled: true } };
    const item: WorkItem = {
      id: 'typing-race', repo: '/tmp/model-racing-types', source: 'issue',
      title: 'Check race proposal', detail: 'Race the same task',
      value: 3, effort: 2, score: 4, tags: [], ts: new Date().toISOString(),
    };

    const result = await raceTask(item, cfg);

    expect(judgeProposal).toHaveBeenCalledTimes(2);
    const proposals = vi.mocked(judgeProposal).mock.calls.map(([proposal]) => proposal);
    expect(proposals).toEqual(['local-coder', 'claude'].map((engine) => ({
      id: `proposal-${engine}`, repo: null, origin: 'backlog', kind: 'patch',
      title: item.title, summary: `M166 race candidate for task ${item.id}`,
      diff: engine === 'local-coder' ? 'local diff' : undefined,
      status: 'pending', createdAt: expect.any(String),
    })));
    for (const proposal of proposals) {
      expect(Number.isNaN(Date.parse(proposal.createdAt))).toBe(false);
    }
    expect(result).toMatchObject({ winner: 'tie', localScore: 12, frontierScore: 12 });
  });
});
