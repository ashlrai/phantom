import { describe, expect, it } from 'vitest';
import { cmdFleetBehindSweep } from '../src/cli/fleet-behind-sweep.js';

const pr = (number: number, day: number, mergeStateStatus = 'BEHIND', autoMergeRequest: object | null = {}) =>
  ({ number, createdAt: `2026-10-${String(day).padStart(2, '0')}T00:00:00Z`, headRefOid: 'a'.repeat(40), mergeStateStatus, autoMergeRequest });
const page = (nodes: unknown[]) => ({ data: { repository: { pullRequests: { nodes } } } });
async function run(args: string[], fail = false, stdout = JSON.stringify([
  page([pr(30, 3), pr(20, 2), pr(99, 1, 'CLEAN')]), page([pr(10, 1), pr(98, 1, 'BEHIND', null)]),
])) {
  const calls: string[][] = [];
  let result = '';
  const code = await cmdFleetBehindSweep([...args, '--json'], {
    gh: async argv => { calls.push(argv); return { ok: calls.length === 1 || !fail, stdout, stderr: '' }; },
    output: text => { result = text; }, error: () => {},
  });
  return { code, calls, report: result ? JSON.parse(result) : undefined };
}
describe('fleet behind-sweep', () => {
  it('plans eligible PRs oldest first across pages without updating by default', async () => {
    const { code, calls, report } = await run([]);
    expect(code).toBe(0);
    expect(report.planned.map((p: { number: number }) => p.number)).toEqual([10, 20, 30]);
    expect(report.dryRun).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(expect.arrayContaining(['--paginate', '--slurp']));
  });
  it('updates only the oldest N with the observed head and chosen repo', async () => {
    const { code, calls, report } = await run(['--repo', 'phantom', '--limit', '2', '--apply']);
    expect(code).toBe(0);
    expect(report.candidates).toBe(3);
    expect(report.updated).toEqual([10, 20]);
    expect(calls.slice(1)).toEqual([10, 20].map(n => ['api', '--method', 'PUT',
      `repos/ashlrai/phantom/pulls/${n}/update-branch`, '-f', `expected_head_sha=${'a'.repeat(40)}`]));
  });
  it('defaults to ten updates and breaks equal-age ties by PR number', async () => {
    const nodes = Array.from({ length: 12 }, (_, n) => pr(12 - n, 1));
    const { code, report, calls } = await run(['--apply'], false, JSON.stringify([page(nodes)]));
    expect(code).toBe(0);
    expect(report.updated).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(calls).toHaveLength(11);
  });
  it('reports update failures and does not replace them with newer PRs', async () => {
    const { code, calls, report } = await run(['--apply', '--limit', '1'], true);
    expect(code).toBe(1);
    expect(report.failed).toEqual([10]);
    expect(calls).toHaveLength(2);
  });
  it('refuses malformed read results before any update', async () => {
    const { code, calls } = await run(['--apply'], false, '{}');
    expect(code).toBe(1);
    expect(calls).toHaveLength(1);
  });
  it.each([['--limit', '0'], ['--limit', 'oops'], ['--repo', '../bad'], ['--apply', '--apply']])('rejects invalid options %j', async (...args) => {
    const { code, calls } = await run(args);
    expect(code).toBe(2);
    expect(calls).toHaveLength(0);
  });
});
