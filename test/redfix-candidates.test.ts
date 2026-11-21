import { describe, expect, it, vi } from 'vitest';
import { planRedfixCycle, readRedfixCandidates, redfixCandidate, type RedfixPr } from '../src/core/fleet/redfix-candidates.js';
import { cmdJobsRedfixCandidates } from '../src/cli/jobs-redfix-candidates.js';

const pr = (number = 1, log = 'error TS1: wrong'): RedfixPr => ({ number, title: `bridge: RQ-PHX-DEMO${number}`, statusCheckRollup: [
  { name: 'CI', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: 'today', detailsUrl: 'https://github.com/ashlrai/phantom/actions/runs/1/job/1', log },
] });
describe('redfix pre-emit scan', () => {
  it('emits zero rows and one message for zero eligible PRs', async () => {
    const log = vi.fn(); expect(await planRedfixCycle(1, async () => [], log)).toEqual([]);
    expect(log.mock.calls).toEqual([['redfix: 0 eligible red PRs, no cycle emitted']]);
  });
  it('excludes merged successors by stem or explicit marker', async () => {
    expect(redfixCandidate(pr(), [{ title: 'bridge(RQ-PHX-DEMO1): done', body: '' }]).reason).toBe('merged successor');
    expect(redfixCandidate(pr(), [{ title: 'fix', body: 'Supersedes #1' }]).kept).toBe(false);
    expect(redfixCandidate(pr(), [{ title: 'fix', body: 'Supersedes #10' }]).kept).toBe(true);
    const p = { ...pr(), title: 'bridge: RQ-PHX-DEMOC711B' };
    const skipped = redfixCandidate(p, [{ title: 'bridge(RQ-PHX-DEMOC712C): done', body: '' }]);
    expect(await planRedfixCycle(7, async () => [skipped], vi.fn())).toEqual([]);
  });
  it('emits one named PR per bucket from a single scan', async () => {
    const read = vi.fn(async () => [pr(), pr(2, 'AssertionError: wrong'), pr(3)].map(p => redfixCandidate(p, [])));
    const rows = await planRedfixCycle(7, read); expect(read).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(2); expect(rows[0]).toContain('Fix PR #1'); expect(rows[1]).toContain('Fix PR #2');
  });
  it('ignores obsolete failures, pending checks and non-code failures', () => {
    const p = pr(); p.statusCheckRollup.push({ ...p.statusCheckRollup[0]!, startedAt: 'tomorrow', conclusion: 'SUCCESS', log: '' });
    expect(redfixCandidate(p, []).kept).toBe(false);
    p.statusCheckRollup[1]!.status = 'IN_PROGRESS'; expect(redfixCandidate(p, []).reason).toBe('CI incomplete');
    expect(redfixCandidate(pr(1, 'install failed'), []).kept).toBe(false);
  });
  it('reads only through injected gh and exposes the scan through the CLI', async () => {
    const gh = vi.fn(async (args: string[]) => args[0] === 'api' ? 'error TS1: wrong' : JSON.stringify(args.includes('open') ? [pr()] : []));
    const rows = await readRedfixCandidates(gh); expect(rows[0]?.kept).toBe(true);
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    try { expect(await cmdJobsRedfixCandidates(['--json'], async () => rows)).toBe(0); expect(JSON.parse(String(output.mock.calls[0]?.[0])).candidates).toEqual(rows); }
    finally { output.mockRestore(); }
    await expect(planRedfixCycle(1, async () => { throw new Error('offline'); })).rejects.toThrow('offline');
  });
  it('avoids logs for merged successors and rejects truncated lists', async () => {
    const gh = vi.fn(async (args: string[]) => JSON.stringify(args.includes('open') ? [pr()] : [{ title: 'fix', body: 'Supersedes #1' }]));
    expect((await readRedfixCandidates(gh))[0]?.reason).toBe('merged successor'); expect(gh).toHaveBeenCalledTimes(2);
    await expect(readRedfixCandidates(async () => JSON.stringify(Array.from({ length: 1000 }, () => pr())))).rejects.toThrow('incomplete');
  });
});
