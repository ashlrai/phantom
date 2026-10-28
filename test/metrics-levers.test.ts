import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ActivityRollup } from '../src/core/types.js';
import type { FleetDigest } from '../src/core/fleet/digest.js';
import { rankMetricsLevers } from '../src/core/observability/levers.js';
import { cmdMetrics } from '../src/cli/metrics.js';

vi.mock('../src/core/config.js', () => ({ loadConfigReadOnly: vi.fn(() => ({})) }));
vi.mock('../src/core/observability/rollup.js', () => ({ buildRollupAsync: vi.fn() }));
vi.mock('../src/core/fleet/digest.js', () => ({ buildFleetDigest: vi.fn() }));
import { buildRollupAsync } from '../src/core/observability/rollup.js';
import { buildFleetDigest } from '../src/core/fleet/digest.js';

function fixture(): { activity: ActivityRollup; fleet: FleetDigest } {
  return {
    activity: {
      window: '7d', since: '2026-10-19T00:00:00.000Z',
      totals: { tokensIn: 0, tokensOut: 0, estCostUsd: 0, sessions: 10, commits: 1 },
      byProject: [
        { project: 'a', sessions: 9, commits: 0, tokensIn: 0, tokensOut: 0, estCostUsd: 0, lastActive: null },
        { project: 'b', sessions: 1, commits: 1, tokensIn: 0, tokensOut: 0, estCostUsd: 0, lastActive: null },
      ], byDay: [], byModel: [],
      budget: { level: 'ok', window: '7d', spentUsd: 0, capUsd: null, spentTokens: 0, capTokens: null, message: '' },
    },
    fleet: {
      running: false, lastTickAt: null, todaySpentUsd: 0, itemsProcessed: 100,
      repos: [], totalProposed: 10, totalAutoMerged: 3, totalPending: 1, totalDeclined: 6,
      proposalSourceQuality: { sourceState: 'healthy', sourcePresent: true, complete: true,
        stopReasons: [], filesDiscovered: 10, filesRead: 10, bytesRead: 0, invalidFiles: 0, unreadableFiles: 0 },
    },
  };
}

beforeEach(() => {
  const { activity, fleet } = fixture();
  vi.mocked(buildRollupAsync).mockResolvedValue(activity);
  vi.mocked(buildFleetDigest).mockResolvedValue(fleet);
});
afterEach(() => vi.restoreAllMocks());

describe('metrics opportunity ranking', () => {
  it('ranks a stable top three with exact scores and single-line proxy reasons', () => {
    const { activity, fleet } = fixture();
    const original = structuredClone({ activity, fleet });
    const report = rankMetricsLevers(activity, fleet);
    expect(report.levers.map(l => [l.rank, l.id, l.score])).toEqual([
      [1, 'empty-jobs', 90], [2, 'lane-imbalance', 80], [3, 'template-merge-rate', 70],
    ]);
    activity.byProject.reverse();
    expect(rankMetricsLevers(activity, fleet)).toEqual(report);
    activity.byProject.reverse();
    expect({ activity, fleet }).toEqual(original);
    for (const lever of report.levers) {
      expect(lever.evidence).toBe('proxy');
      expect(lever.reason).not.toMatch(/[\r\n\u2014]/);
      expect(lever.reason).toContain('proxy');
    }
  });

  it('promotes review backlog when it dominates', () => {
    const { activity, fleet } = fixture();
    fleet.totalPending = 1000;
    expect(rankMetricsLevers(activity, fleet).levers[0]).toMatchObject({ id: 'wait-time', score: 99.11 });
  });

  it('breaks score ties in a fixed candidate order', () => {
    const { activity, fleet } = fixture();
    activity.byProject.forEach(p => { p.sessions = 1; p.commits = 1; });
    fleet.totalAutoMerged = fleet.totalProposed;
    fleet.totalPending = 0;
    expect(rankMetricsLevers(activity, fleet).levers.map(l => l.id)).toEqual([
      'lane-imbalance', 'template-merge-rate', 'wait-time',
    ]);
  });

  it('returns explicit unknowns for empty samples without division by zero', () => {
    const { activity, fleet } = fixture();
    activity.byProject = [];
    fleet.totalProposed = fleet.totalAutoMerged = fleet.totalPending = fleet.totalDeclined = 0;
    const report = rankMetricsLevers(activity, fleet);
    expect(report.levers).toHaveLength(3);
    expect(report.levers.every(l => l.score === null && l.evidence === 'unavailable')).toBe(true);
    expect(report.levers.map(l => l.id)).toEqual(['lane-imbalance', 'template-merge-rate', 'wait-time']);
  });

  it.each(['degraded', 'legacy'] as const)('does not infer opportunity from %s proposal reads', kind => {
    const { activity, fleet } = fixture();
    if (kind === 'legacy') delete fleet.proposalSourceQuality;
    else fleet.proposalSourceQuality!.complete = false;
    const report = rankMetricsLevers(activity, fleet);
    expect(report.levers[2]).toMatchObject({ id: 'template-merge-rate', score: null, evidence: 'unavailable' });
  });

  it('clamps cross-window merge flow rather than returning negative scores', () => {
    const { activity, fleet } = fixture();
    fleet.totalAutoMerged = 20;
    activity.byProject = [];
    expect(rankMetricsLevers(activity, fleet).levers.find(l => l.id === 'template-merge-rate')?.score).toBe(0);
  });
});

describe('metrics CLI', () => {
  it('emits one JSON object and passes the selected window to both readers', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(await cmdMetrics(['levers', '--window', '30d', '--json'])).toBe(0);
    expect(buildRollupAsync).toHaveBeenLastCalledWith('30d', {});
    expect(buildFleetDigest).toHaveBeenLastCalledWith('30d');
    expect(out).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(out.mock.calls[0]![0])).levers).toHaveLength(3);
  });

  it.each([[], ['unknown'], ['levers', '--window'], ['levers', '--window', '1d'], ['levers', '--notify']].map(args => ({ args })))('rejects invalid arguments $args before reading', async ({ args }) => {
    vi.mocked(buildRollupAsync).mockClear();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await cmdMetrics(args)).toBe(2);
    expect(buildRollupAsync).not.toHaveBeenCalled();
  });

  it('prints help without reading metrics', async () => {
    vi.mocked(buildRollupAsync).mockClear();
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(await cmdMetrics(['--help'])).toBe(0);
    expect(out).toHaveBeenCalledWith(expect.stringContaining('phm metrics levers'));
    expect(buildRollupAsync).not.toHaveBeenCalled();
  });

  it('renders a human ranked list', async () => {
    const out = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    expect(await cmdMetrics(['levers'])).toBe(0);
    expect(out).toHaveBeenCalledWith(expect.stringContaining('1. empty-jobs (90):'));
  });

  it('returns a runtime error without printing source error details', async () => {
    vi.mocked(buildRollupAsync).mockRejectedValueOnce(new Error('private source detail'));
    const err = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    expect(await cmdMetrics(['levers', '--json'])).toBe(1);
    expect(err).toHaveBeenCalledWith('Unable to read local metrics.\n');
  });
});
