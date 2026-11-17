import { describe, expect, it, vi } from 'vitest';
import { readReviewPickAcross } from '../src/core/fleet/review-pick-multi.js';
import type { ReviewPickReadOptions } from '../src/core/fleet/review-pick.js';

const repos = ['example/phantom', 'example/lexicon'];
const row = (number: number, state = 'CLEAN', date = '2026-11-12T00:00:00Z') => ({
  number, title: 'Example review', headRefName: 'example/review', headRefOid: 'a'.repeat(40),
  isDraft: false, mergeStateStatus: state, updatedAt: date,
});
function sources() {
  return {
    now: () => Date.parse('2026-11-14T16:00:00Z'),
    readClaimedTsv: vi.fn(async () => ({ state: 'healthy' as const, text: '' })),
    inspectBusWork: vi.fn(() => ({ source: 'available' as const, claims: [] })),
    readBoard: vi.fn(() => ({ schema: 'fleet.coordination.v1' as const, state: 'known' as const, claims: [], messages: [], proposals: [], expiredClaims: 0 })),
    listWorkers: vi.fn(async () => ({ v: 1 as const, generatedAt: '', sourceState: 'healthy' as const, workers: [], leaders: [], orchestratorAgents: 0 })),
  };
}
const ghRows = (rows: unknown[]) => ({ ok: true, stdout: JSON.stringify(rows), stderr: '' });

describe('multi-repo review picks', () => {
  it('reads each ownership source once and GitHub sequentially once per repo', async () => {
    const deps = sources();
    let active = false;
    const gh = vi.fn(async (args: string[]) => {
      expect(active).toBe(false);
      active = true;
      await Promise.resolve();
      active = false;
      return ghRows([row(args.includes(repos[0]!) ? 10 : 20)]);
    });
    const report = await readReviewPickAcross(repos, { ...deps, gh });
    for (const source of [deps.readClaimedTsv, deps.inspectBusWork, deps.readBoard, deps.listWorkers]) expect(source).toHaveBeenCalledTimes(1);
    expect(gh).toHaveBeenCalledTimes(2);
    expect(report.repos.map(r => r.picked?.pr)).toEqual([10, 20]);
    expect(report.first).toEqual({ repo: repos[0], pr: 10, head: 'example/review', head_sha: 'a'.repeat(40), title: 'Example review' });
  });

  it.each([
    ['DIRTY', '2026-11-01', 'CLEAN', '2026-11-13'],
    ['BLOCKED', '2026-11-01', 'CLEAN', '2026-11-13'],
    ['DIRTY', '2026-11-01', 'UNSTABLE', '2026-11-13'],
    ['CLEAN', '2026-11-13', 'CLEAN', '2026-11-01'],
    ['BLOCKED', '2026-11-13', 'UNSTABLE', '2026-11-01'],
    ['CLEAN', 'invalid-date', 'CLEAN', '2026-11-01'],
  ])('ranks %s/%s against %s/%s using the single-repo ordering', async (a, at, b, bt) => {
    const report = await readReviewPickAcross(repos, { ...sources(), gh: async args => ghRows([
      args.includes(repos[0]!) ? row(10, a, at) : row(20, b, bt),
    ]) });
    expect(report.first).toMatchObject({ repo: repos[1], pr: 20 });
  });

  it.each(['failed', 'throw', 'invalid-json'])('keeps another repo pick when one GitHub read is %s', async failure => {
    const report = await readReviewPickAcross(repos, { ...sources(), gh: async args => {
      if (!args.includes(repos[0]!)) return ghRows([row(20)]);
      if (failure === 'throw') throw new Error('fake failure');
      return { ok: failure === 'invalid-json', stdout: 'invalid', stderr: '' };
    } });
    expect(report.repos[0]?.source.prs).toBe('unavailable');
    expect(report.first).toMatchObject({ repo: repos[1], pr: 20 });
  });

  it.each(['readClaimedTsv', 'inspectBusWork', 'readBoard', 'listWorkers'] as const)('withholds first when %s throws and reads it once', async source => {
    const deps = sources();
    const fail = vi.fn(() => { throw new Error('fake unavailable'); });
    const options: Omit<ReviewPickReadOptions, 'repo'> = { ...deps, [source]: fail, gh: async () => ghRows([row(10)]) };
    const report = await readReviewPickAcross(repos, options);
    expect(fail).toHaveBeenCalledTimes(1);
    expect(report.first).toBeNull();
    expect(report.reason).toBe('ownership source unavailable');
    expect(report.repos.every(r => r.source.unavailable.length === 1)).toBe(true);
  });

  it('deduplicates case-insensitively preserving first spelling and input order', async () => {
    const gh = vi.fn(async () => ghRows([row(10)]));
    const report = await readReviewPickAcross([repos[0]!, repos[1]!, 'EXAMPLE/PHANTOM'], { ...sources(), gh });
    expect(report.repos.map(r => r.repo)).toEqual(repos);
    expect(gh).toHaveBeenCalledTimes(2);
  });

  it('caps at ten distinct repos after deduplication', async () => {
    const names = Array.from({ length: 12 }, (_, i) => `example/phantom${i}`);
    const gh = vi.fn(async () => ghRows([]));
    const report = await readReviewPickAcross([names[0]!, names[0]!, ...names], { ...sources(), gh });
    expect(report.repos.map(r => r.repo)).toEqual(names.slice(0, 10));
    expect(gh).toHaveBeenCalledTimes(10);
    expect(report.first).toBeNull();
  });
});
