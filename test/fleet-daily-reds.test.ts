import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetDailyReds, readDailyReds } from '../src/cli/fleet-daily-reds.js';
import type { Gh } from '../src/core/autopilot/github.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const sha = 'a'.repeat(40);
const run = { id: 42, name: 'CI', event: 'schedule', head_branch: 'main', status: 'completed', conclusion: 'failure', created_at: '2026-01-01T00:00:00Z' };
function fixture(fail = '', conclusion = 'failure'): Gh {
  return vi.fn(async args => {
    const path = args.at(-1)!;
    if (args[0] === 'run') {
      if (fail === 'logs') throw new Error('private error');
      return 'FAIL test/fixed.test.ts > assertion\nFAIL test/open.spec.ts\nFAIL test/fixed.test.ts\n at test/incidental.test.ts:3';
    }
    if (path.includes('actions/runs?')) {
      if (fail === 'runs') throw new Error('private error');
      return JSON.stringify({ workflow_runs: [{ ...run, conclusion }] });
    }
    if (path.includes('/files?')) {
      if (fail === 'files') throw new Error('private error');
      return JSON.stringify([{ filename: 'test/fixed.test.ts' }]);
    }
    if (path.includes('/pulls?')) {
      if (fail === 'pulls') return '{}';
      return JSON.stringify([
        { number: 1, merged_at: '2026-01-02T00:00:00Z', base: { ref: 'main' }, merge_commit_sha: sha },
        { number: 2, merged_at: '2025-12-31T00:00:00Z' },
        { number: 3, merged_at: null },
        { number: 4, merged_at: '2026-01-02T00:00:00Z', base: { ref: 'other' } },
      ]);
    }
    throw new Error('Unexpected request');
  });
}
afterEach(() => vi.restoreAllMocks());
describe('fleet daily-reds', () => {
  it('reports all seven repos, exact failed paths and later merged commits on the run branch', async () => {
    const gh = fixture();
    const rows = await readDailyReds(gh);
    expect(new Set(rows.map(r => r.repo)).size).toBe(7);
    for (const row of rows) {
      expect(row.run?.id).toBe(42);
      expect(row.failedTests).toEqual([
        { file: 'test/fixed.test.ts', status: 'fixed-after-run', commits: [sha] },
        { file: 'test/open.spec.ts', status: 'still-open', commits: [] },
      ]);
    }
    expect(vi.mocked(gh).mock.calls.every(([args]) => args[0] === 'api' || args.includes('--log-failed'))).toBe(true);
  });
  it.each(['runs', 'logs', 'files', 'pulls'])('keeps %s read failures null', async fail => {
    expect((await readDailyReds(fixture(fail))).every(r => r.failedTests === null)).toBe(true);
  });
  it('only reports empty failures for an explicitly successful completed run', async () => {
    expect((await readDailyReds(fixture('', 'success'))).every(r => r.failedTests?.length === 0)).toBe(true);
    expect((await readDailyReds(fixture('', 'cancelled'))).every(r => r.failedTests === null)).toBe(true);
  });
  it('keeps absent runs and unrecognized failure logs unknown', async () => {
    expect((await readDailyReds(async () => '{"workflow_runs":[]}')).every(r => r.run === null && r.failedTests === null)).toBe(true);
    const gh = fixture();
    expect((await readDailyReds(args => args[0] === 'run' ? Promise.resolve('infrastructure failed') : gh(args))).every(r => r.failedTests === null)).toBe(true);
  });
  it('paginates scheduled runs and fails closed on capped merge evidence', async () => {
    const base = fixture();
    const gh: Gh = async args => {
      const path = args.at(-1)!;
      if (path.includes('actions/runs?') && path.endsWith('page=1')) return JSON.stringify({ workflow_runs: Array.from({ length: 100 }, () => ({ name: 'Other' })) });
      if (path.includes('/pulls?')) return JSON.stringify(Array.from({ length: 100 }, () => ({ merged_at: null })));
      return base(args);
    };
    expect((await readDailyReds(gh)).every(r => r.run?.id === 42 && r.failedTests === null)).toBe(true);
  });
  it('registers the command once and emits JSON with failure exit status', async () => {
    expect((await FLEET_SUBCOMMAND_LOADERS['daily-reds']!()).cmdFleetDailyReds).toBe(cmdFleetDailyReds);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdFleetDailyReds(['--json'], { gh: fixture('runs') })).toBe(1);
    expect(JSON.parse(String(log.mock.calls[0]![0])).repos).toHaveLength(7);
    expect(await cmdFleetDailyReds(['--help'], { gh: fixture() })).toBe(0);
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await cmdFleetDailyReds(['--bogus'])).toBe(2);
  });
});
