import { describe, expect, it } from 'vitest';
import { cmdFleetReviewPick, type FleetReviewPickDeps } from '../src/cli/fleet-review-pick.js';
import { readReviewPick, type ReviewPickReport } from '../src/core/fleet/review-pick.js';

const repo = 'example/phantom';
const other = 'example/lexicon';
function deps(): FleetReviewPickDeps {
  return {
    now: () => Date.parse('2026-11-14T16:00:00Z'),
    gh: async () => ({ ok: true, stderr: '', stdout: JSON.stringify([{
      number: 10, title: 'Example review', headRefName: 'example/review', headRefOid: 'a'.repeat(40),
      isDraft: false, mergeStateStatus: 'CLEAN', updatedAt: '2026-11-12T00:00:00Z',
    }]) }),
    readClaimedTsv: async () => ({ state: 'healthy', text: '' }),
    inspectBusWork: () => ({ source: 'available', claims: [] }),
    readBoard: () => ({ schema: 'fleet.coordination.v1', state: 'known', claims: [], messages: [], proposals: [], expiredClaims: 0 }),
    listWorkers: async () => ({ v: 1, generatedAt: '', sourceState: 'healthy', workers: [], leaders: [], orchestratorAgents: 0 }),
  };
}
async function run(args: string[], overrides: FleetReviewPickDeps = {}) {
  let stdout = '';
  let stderr = '';
  const code = await cmdFleetReviewPick(args, { ...deps(), ...overrides, stdout: s => { stdout += s; }, stderr: s => { stderr += s; } });
  return { code, stdout, stderr };
}

/** Frozen text format from the existing single-repo path. */
function snapshot(report: ReviewPickReport) {
  const pick = report.picked!;
  return `repo: ${repo}\nas_of: ${report.as_of}\npr: ${pick.pr}\nhead: ${pick.head}\nhead_sha: ${pick.head_sha}\ntitle: ${pick.title}\nowner: none\nreason: ${report.reason}\nunowned_candidates: 1\nskipped: 0\nsource.prs: read\nsource.unavailable: none\n`;
}

describe('repeatable review-pick --repo', () => {
  it('keeps single-repo JSON and text byte-identical to the existing path', async () => {
    const report = await readReviewPick({ ...deps(), repo });
    expect(await run(['--repo', repo, '--json'])).toEqual({ code: 0, stdout: `${JSON.stringify(report)}\n`, stderr: '' });
    expect(await run(['--repo', repo])).toEqual({ code: 0, stdout: snapshot(report), stderr: '' });
  });

  it('emits multi JSON and a three-line text report for two repos', async () => {
    const args = ['--repo', repo, '--repo', other];
    const json = await run([...args, '--json']);
    expect(json.code).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({ schema: 'fleet.review-pick-multi.v1', repos: [{ repo }, { repo: other }], first: { repo, pr: 10 } });
    const text = await run(args);
    expect(text.stdout.trim().split('\n')).toEqual([
      expect.stringMatching(/^example\/phantom: #10 /),
      expect.stringMatching(/^example\/lexicon: #10 /),
      'first: example/phantom#10',
    ]);
  });

  it('returns 1 for a failed PR source while keeping the other pick', async () => {
    const healthy = deps().gh!;
    const result = await run(['--repo', repo, '--repo', other, '--json'], { gh: args => args.includes(repo) ? Promise.resolve({ ok: false, stdout: '', stderr: '' }) : healthy(args) });
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ first: { repo: other }, repos: [{ source: { prs: 'unavailable' } }, { source: { prs: 'read' } }] });
  });

  it('returns 1 and no overall pick when ownership is unreadable', async () => {
    const result = await run(['--repo', repo, '--repo', other, '--json'], { readBoard: () => { throw new Error('fake unavailable'); } });
    expect(result.code).toBe(1);
    expect(JSON.parse(result.stdout)).toMatchObject({ first: null, reason: 'ownership source unavailable' });
  });

  it('returns 0 for trustworthy empty answers', async () => {
    const result = await run(['--repo', repo, '--repo', other, '--json'], { gh: async () => ({ ok: true, stdout: '[]', stderr: '' }) });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout).first).toBeNull();
  });

  it.each([
    ['--repo'], ['--repo', repo, '--repo'], ['--repo', repo, '--repo', 'invalid'],
    ['--repo', repo, '--limit', '0'], ['--repo', repo, '--unknown'],
  ])('returns 2 for bad usage %j', async (...args) => {
    const result = await run(args);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Usage:');
  });
});
