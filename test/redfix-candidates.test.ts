import { describe, expect, it, vi } from 'vitest';
import { planRedfixCycle, readRedfixCandidates, readRedCandidates, redCandidates, RED_BUCKETS, redfixCandidate, type RedfixPr } from '../src/core/fleet/redfix-candidates.js';
import { cmdFleetRedCandidates } from '../src/cli/fleet-red-candidates.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { cmdJobsRedfixCandidates } from '../src/cli/jobs-redfix-candidates.js';
import { familyYield } from '../src/core/fleet/family-yield.js';

const pr = (number = 1, log = 'error TS1: wrong'): RedfixPr => ({ number, title: `bridge: RQ-PHX-DEMO${number}`, headRefName: 'demo', updatedAt: '2026-01-01T00:00:00Z', files: [{ path: 'src/cli/demo.ts' }], statusCheckRollup: [
  { name: 'CI', status: 'COMPLETED', conclusion: 'FAILURE', startedAt: 'today', detailsUrl: 'https://github.com/ashlrai/phantom/actions/runs/1/job/1', log },
] });
describe('redfix pre-emit scan', () => {
  it('does not emit a bucket paused by its last four empty launches', async () => {
    const ts = new Date(Date.now() - 1000).toISOString();
    const stats = familyYield(Array.from({ length: 4 }, (_, i) => [JSON.stringify({ event: 'launch', job: `RQ-PHX-REDFIXCLIC${i}`, ts }),
      JSON.stringify({ event: 'finish', job: `RQ-PHX-REDFIXCLIC${i}`, empty: true, summary: 'no diff' })]).flat(), Date.now(), 24).launch_families;
    expect(await planRedfixCycle(7, async () => ({ open: [pr()], merged: [] }), vi.fn(), async () => stats)).toEqual([]);
  });
  it('emits zero rows and one message for zero eligible PRs', async () => {
    const log = vi.fn(); expect(await planRedfixCycle(1, async () => ({ open: [], merged: [] }), log)).toEqual([]);
    expect(log.mock.calls).toEqual([['redfix: 0 eligible red PRs, no cycle emitted']]);
  });
  it('excludes merged successors by stem or explicit marker', async () => {
    expect(redfixCandidate(pr(), [{ title: 'bridge(RQ-PHX-DEMO1): done', body: '' }]).reason).toBe('merged successor');
    expect(redfixCandidate(pr(), [{ title: 'fix', body: 'Supersedes #1' }]).kept).toBe(false);
    expect(redfixCandidate(pr(), [{ title: 'fix', body: 'Supersedes #10' }]).kept).toBe(true);
    const p = { ...pr(), title: 'bridge: RQ-PHX-DEMOC711B' };
    expect(await planRedfixCycle(7, async () => ({ open: [p], merged: [{ title: 'bridge(RQ-PHX-DEMOC712C): done', body: '' }] }), vi.fn())).toEqual([]);
  });
  it('emits one named PR per bucket from a single scan', async () => {
    const read = vi.fn(async () => ({ open: [pr(), { ...pr(2, 'AssertionError: wrong'), files: [{ path: 'test/demo.ts' }] }, pr(3)], merged: [] }));
    const rows = await planRedfixCycle(7, read); expect(read).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(2); expect(rows[0]).toContain('Fix PR #1 in CLI'); expect(rows[1]).toContain('Fix PR #2 in SCRIPTS/TEST');
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
    await expect(readRedfixCandidates(async args => JSON.stringify(args.includes('open') ? [{ ...pr(), changedFiles: 2 }] : []))).rejects.toThrow('files unavailable or incomplete');
  });
  it('rejects branch freshness failures, mixed scopes and superseded work', () => {
    const behind = pr(); behind.statusCheckRollup[0]!.name = 'Branch behind';
    expect(redCandidates([behind], RED_BUCKETS.CLI, []).candidates).toEqual([]);
    const mixed = { ...pr(2), files: [{ path: 'src/cli/demo.ts' }, { path: 'test/demo.ts' }] };
    expect(redCandidates([mixed], RED_BUCKETS.CLI, []).rejected).toEqual([{ number: 2, why: 'files cross bucket scope' }]);
    expect(redCandidates([pr()], RED_BUCKETS.CLI, [{ title: 'fix', body: 'Supersedes #1' }]).rejected[0]?.why).toBe('superseded');
    expect(redCandidates([pr(), { ...pr(2), body: 'Supersedes #1' }], RED_BUCKETS.CLI, []).candidates.map(c => c.number)).toEqual([2]);
    expect(redCandidates([pr()], RED_BUCKETS.CLI, [{ title: pr().title, body: '' }]).candidates).toEqual([]);
  });
  it('ranks old PRs deterministically and waits three hours, including invalid dates', () => {
    const now = Date.parse('2026-01-02T00:00:00Z');
    const recent = { ...pr(3), updatedAt: '2026-01-01T22:00:00Z' };
    const bad = { ...pr(4), updatedAt: 'unknown' };
    const result = redCandidates([pr(2), recent, pr(), bad], RED_BUCKETS.CLI, [], now);
    expect(result.candidates.map(c => c.number)).toEqual([1, 2]);
    expect(result.rejected.map(c => c.why)).toEqual(['updated within three hours', 'update time unknown']);
    expect(redCandidates([], RED_BUCKETS.CLI, []).candidates).toEqual([]);
  });
  it('exposes known and unavailable scans through the registered fleet verb', async () => {
    expect((await FLEET_SUBCOMMAND_LOADERS['red-candidates']!()).cmdFleetRedCandidates).toBe(cmdFleetRedCandidates);
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const report = redCandidates([pr()], RED_BUCKETS.CLI, []);
      expect(await cmdFleetRedCandidates(['--bucket', 'CLI', '--json'], async () => report)).toBe(0);
      expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toMatchObject({ bucket: 'CLI', candidates: [{ number: 1 }] });
      const unknown = await readRedCandidates('CLI', async () => { throw new Error('offline'); });
      expect(unknown.state).toBe('unknown');
      expect(await cmdFleetRedCandidates(['--bucket', 'CLI', '--json'], async () => unknown)).toBe(1);
      expect(await cmdFleetRedCandidates(['--bucket', 'other'])).toBe(2);
    } finally { output.mockRestore(); error.mockRestore(); }
  });

});
