import { expect, it, vi } from 'vitest';
import { readReviewPickAcross } from '../src/core/fleet/review-pick-multi.js';

it('refreshes both PR pages and shared ownership evidence after failures', async () => {
  const repos = ['example/phantom', 'example/lexicon'];
  const deps = {
    now: () => Date.parse('2026-11-14T16:00:00Z'),
    readClaimedTsv: vi.fn(async () => ({ state: 'healthy' as const, text: '' })),
    inspectBusWork: vi.fn(() => ({ source: 'available' as const, claims: [] })),
    readBoard: vi.fn(() => ({ schema: 'fleet.coordination.v1' as const, state: 'known' as const, claims: [], messages: [], proposals: [], expiredClaims: 0 })),
    listWorkers: vi.fn(async () => ({ v: 1 as const, generatedAt: '', sourceState: 'healthy' as const, workers: [], leaders: [], orchestratorAgents: 0 })),
  };
  let pass = 0;
  const gh = vi.fn(async (args: string[]) => {
    const index = repos.findIndex(repo => args.includes(repo));
    expect(index).toBeGreaterThanOrEqual(0);
    if ((pass === 0 && index === 0) || (pass === 1 && index === 1) || pass === 2) {
      return { ok: false, stdout: '', stderr: 'synthetic failure' };
    }
    const number = [20, 31, 0, 42][pass]!;
    return { ok: true, stderr: '', stdout: JSON.stringify([{
      number, title: 'Review', headRefName: `review/pr-${number}`, headRefOid: String(pass + 1).repeat(40),
      isDraft: false, mergeStateStatus: 'CLEAN', updatedAt: '2026-11-12T00:00:00Z',
    }]) };
  });
  const run = async () => {
    const report = await readReviewPickAcross(repos, { ...deps, gh });
    for (const reader of Object.values(deps).slice(1)) expect(reader).toHaveBeenCalledTimes(pass + 1);
    expect(gh).toHaveBeenCalledTimes((pass + 1) * 2);
    expect(report.repos.every(repo => repo.source.unavailable.length === 0)).toBe(true);
    return report;
  };
  const first = await run();
  expect(first.repos[0]).toMatchObject({ source: { prs: 'unavailable' }, picked: null });
  expect(first.repos[1]).toMatchObject({ source: { prs: 'read' }, picked: { pr: 20, head_sha: '1'.repeat(40) } });
  expect(first.first).toMatchObject({ repo: repos[1], pr: 20, head: 'review/pr-20', head_sha: '1'.repeat(40) });

  pass = 1;
  const swapped = await run();
  expect(swapped.repos[1]).toMatchObject({ source: { prs: 'unavailable' }, picked: null });
  expect(swapped.repos[0]).toMatchObject({ source: { prs: 'read' }, picked: { pr: 31, head_sha: '2'.repeat(40) } });
  expect(swapped.first).toMatchObject({ repo: repos[0], pr: 31, head: 'review/pr-31', head_sha: '2'.repeat(40) });

  pass = 2;
  const outage = await run();
  expect(outage.first).toBeNull();
  for (const repo of outage.repos) expect(repo).toMatchObject({ source: { prs: 'unavailable' }, picked: null });

  pass = 3;
  const recovered = await run();
  expect(recovered.repos.every(repo => repo.source.prs === 'read')).toBe(true);
  expect(recovered.first).toMatchObject({ repo: repos[0], pr: 42, head: 'review/pr-42', head_sha: '4'.repeat(40) });
});
