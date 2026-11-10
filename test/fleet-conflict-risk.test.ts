/**
 * Tests for src/core/fleet/conflict-risk.ts and src/cli/fleet-conflict-risk.ts
 * — the read-only conflict predictor feeding the rebase scheduler.
 *
 * FULLY HERMETIC: `gh`, the jobs ledger and the merge-state join are all
 * injected. No subprocess, no filesystem, no network.
 */
import { describe, expect, it, vi } from 'vitest';
import type { CloudGh } from '../src/core/cloud/pr-actions.js';
import type { FleetMergeStateRead } from '../src/core/fleet/fleet-merge-state.js';
import type { MergeBacklogItem } from '../src/core/fleet/merge-backlog-plan.js';
import {
  buildConflictRiskReport,
  churnedPaths,
  ledgerMergeCount,
  mergedPageMergeCount,
  parseConflictRiskMergedPr,
  parseConflictRiskOpenPr,
  predictedMergeWindow,
  readConflictRisk,
  scoreConflictRisk,
  type ConflictRiskBuildInput,
} from '../src/core/fleet/conflict-risk.js';
import { cmdFleetConflictRisk } from '../src/cli/fleet-conflict-risk.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const SHA = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const REPO = 'acme/app';
const NOW = new Date('2026-11-07T12:00:00.000Z');
const NOW_MS = NOW.getTime();

const openRow = (number: number, files: string[] = [], over: Record<string, unknown> = {}): Record<string, unknown> => ({
  number, state: 'OPEN', isDraft: false,
  headRefOid: SHA, headRefName: `fleet/rq-${number}`, baseRefName: 'master',
  isCrossRepository: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN',
  statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'SUCCESS' }],
  createdAt: '2026-11-06T12:00:00.000Z', title: `PR ${number}`,
  files: files.map(path => ({ path })),
  ...over,
});
const mergedRow = (number: number, files: string[] = [], mergedAt: unknown = '2026-11-07T11:00:00.000Z'): Record<string, unknown> => ({
  number, mergedAt, files: files.map(path => ({ path })),
});

const ghFor = (open: unknown[] | 'fail', merged: unknown[] | 'fail'): CloudGh => async (args) => {
  const state = args[args.indexOf('--state') + 1];
  const rows = state === 'merged' ? merged : open;
  if (rows === 'fail') return { ok: false, stdout: '', stderr: 'boom' };
  return { ok: true, stdout: JSON.stringify(rows), stderr: '' };
};
const noStates = (): ReadonlyMap<number, FleetMergeStateRead> => new Map();
const build = (over: ConflictRiskBuildInput = {}) =>
  buildConflictRiskReport({ repo: REPO, open: [], states: noStates, now: NOW, ...over });

const item = (number: number, over: Partial<MergeBacklogItem> = {}): MergeBacklogItem => ({
  repo: REPO, createdAt: '2026-11-06T12:00:00.000Z',
  mergeState: { state: 'missing' }, github: null, ...over,
});
const ghPr = (number: number, over: Record<string, unknown> = {}) =>
  parseConflictRiskOpenPr(openRow(number, [], over))!.github;

describe('row parsing', () => {
  it('validates open rows, normalizes paths and keeps unparsable PRs as github-null', () => {
    const pr = parseConflictRiskOpenPr(openRow(7, ['src/a.ts', 'src\\b.ts', './c/../d.ts', '/abs.ts', '../up.ts', 'src/a.ts', 'bad/../x']));
    expect(pr).not.toBeNull();
    expect(pr!.github!.number).toBe(7);
    expect(pr!.files).toEqual(['src/a.ts', 'src/b.ts']);
    expect(pr!.title).toBe('PR 7');
    // A row with a real number but an undescribed PR view still parses (github null).
    const broken = parseConflictRiskOpenPr(openRow(8, [], { headRefOid: 'not-a-sha' }));
    expect(broken).not.toBeNull();
    expect(broken!.github).toBeNull();
    expect(parseConflictRiskOpenPr(null)).toBeNull();
    expect(parseConflictRiskOpenPr({ number: 0 })).toBeNull();
    expect(parseConflictRiskOpenPr([])).toBeNull();
  });
  it('validates merged rows and never invents timestamps', () => {
    expect(parseConflictRiskMergedPr(mergedRow(3, ['x.ts']))).toEqual({
      number: 3, mergedAt: Date.parse('2026-11-07T11:00:00.000Z'), files: ['x.ts'], filesTruncated: false,
    });
    expect(parseConflictRiskMergedPr(mergedRow(4, [], 'garbage'))!.mergedAt).toBeNull();
    expect(parseConflictRiskMergedPr(mergedRow(4, [], 42))!.mergedAt).toBeNull();
    expect(parseConflictRiskMergedPr({ files: [] })).toBeNull();
  });
});

describe('merge velocity', () => {
  const row = (job: string, hoursAgo: number, repo = 'acme/app') => JSON.stringify({
    event: 'outcome', state: 'MERGED', job, ts: new Date(NOW_MS - hoursAgo * 3_600_000).toISOString(),
    url: `https://github.com/${repo}/pull/9`,
  });
  it('counts the latest in-window MERGED outcome per job for the repo only', () => {
    const text = [
      row('a', 1), row('a', 2),                    // same job twice → one
      row('b', 5.9), row('c', 6.2),                // c out of window
      row('d', 1, 'acme/other'),                   // other repo
      JSON.stringify({ event: 'outcome', state: 'FAILED', job: 'e', ts: new Date(NOW_MS).toISOString(), url: 'https://github.com/acme/app/pull/9' }),
      '{broken', JSON.stringify({ event: 'outcome', state: 'MERGED', job: 'f', ts: 'bad' }),
    ].join('\n');
    expect(ledgerMergeCount(text, 'acme/app', 6 * 3_600_000, NOW_MS)).toBe(2);
    expect(ledgerMergeCount('', 'acme/app', 6 * 3_600_000, NOW_MS)).toBe(0);
  });
  it('counts mergedAt rows inside the window from the merged page', () => {
    const merged = [
      parseConflictRiskMergedPr(mergedRow(1))!,                                        // 1h ago
      parseConflictRiskMergedPr(mergedRow(2, [], '2026-11-07T05:59:00.000Z'))!,        // outside 6h
      parseConflictRiskMergedPr(mergedRow(3, [], '2026-11-08T00:00:00.000Z'))!,        // future
      parseConflictRiskMergedPr(mergedRow(4, [], 'nope'))!,                            // unknown
    ];
    expect(mergedPageMergeCount(merged, 6 * 3_600_000, NOW_MS)).toBe(1);
  });
});

describe('predicted merge window', () => {
  const entry = (number: number, over: Record<string, unknown>, createdAt = '2026-11-06T12:00:00.000Z') =>
    item(number, { github: ghPr(number, over), createdAt });
  it('orders ready, behind, then non-draft pending, oldest first; excludes the rest', () => {
    const items = [
      entry(10, {}, '2026-11-05T00:00:00.000Z'),                                            // ready, newer
      entry(11, {}, '2026-11-04T00:00:00.000Z'),                                            // ready, older → first
      entry(12, { mergeStateStatus: 'BEHIND' }),                                            // behind
      entry(13, { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }),                   // conflicted → out
      entry(14, { isDraft: true }),                                                         // draft → out
      entry(15, { statusCheckRollup: [{ __typename: 'CheckRun', status: 'IN_PROGRESS' }] }),// pending → tier 3
      entry(16, { mergeStateStatus: 'BLOCKED', statusCheckRollup: [{ __typename: 'CheckRun', status: 'COMPLETED', conclusion: 'FAILURE' }] }), // red-required → out
    ];
    const window = predictedMergeWindow(items, 10);
    expect(window.map(e => e.github!.number)).toEqual([11, 10, 12, 15]);
    expect(predictedMergeWindow(items, 2).map(e => e.github!.number)).toEqual([11, 10]);
  });
});

describe('scoring', () => {
  const filesByPr = (map: Record<number, string[]>) =>
    new Map(Object.entries(map).map(([k, v]) => [Number(k), new Set(v)]));
  const openPrs = (rows: ReturnType<typeof openRow>[]) =>
    rows.map(r => parseConflictRiskOpenPr(r)!);

  it('weights a hot shared path double; cold single-file overlap stays low', () => {
    const open = openPrs([openRow(1, ['a.ts']), openRow(2, ['a.ts', 'z.ts'])]);
    const window = predictedMergeWindow([item(1, { github: open[0]!.github })], 5);
    const cold = scoreConflictRisk({ open, window, filesByPr: filesByPr({ 1: ['a.ts'], 2: ['a.ts', 'z.ts'] }), hot: new Set() });
    expect(cold.get(2)!.score).toBe(0.25);              // 1 cold path / saturation 4 → low
    const hot = scoreConflictRisk({ open, window, filesByPr: filesByPr({ 1: ['a.ts'], 2: ['a.ts', 'z.ts'] }), hot: new Set(['a.ts']) });
    expect(hot.get(2)!.score).toBe(0.5);                // hot doubles the weight → medium
    expect(hot.get(2)!.threats[0]).toMatchObject({ number: 1, position: 1, shared: ['a.ts'], sharedTotal: 1, hot: 1 });
  });

  it('combines likelihoods across threatening merges and orders threats by position', () => {
    const open = openPrs([openRow(1, ['a.ts']), openRow(2, ['b.ts']), openRow(3, ['a.ts', 'b.ts'])]);
    const items = [item(1, { github: open[0]!.github }), item(2, { github: open[1]!.github }), item(3, { github: open[2]!.github })];
    const window = predictedMergeWindow(items, 5);
    // #3 is a window member at position 3: both earlier merges threaten it.
    const scored = scoreConflictRisk({ open, window, filesByPr: filesByPr({ 1: ['a.ts'], 2: ['b.ts'], 3: ['a.ts', 'b.ts'] }), hot: new Set() });
    const pr3 = scored.get(3)!;
    expect(pr3.threats.map(t => t.number)).toEqual([1, 2]);
    expect(pr3.score).toBe(1 - 0.75 * 0.75);            // .4375 → medium
    // #1 at position 1 and #2 at position 2: nothing (or only #1) precedes them.
    expect(scored.get(1)!.score).toBe(0);
    expect(scored.get(2)!.score).toBe(0);               // #2 shares b.ts with #3 — but #3 lands later
  });

  it('saturates on multi-file overlap and never scores fileless or conflicting PRs', () => {
    const open = openPrs([
      openRow(1, ['a', 'b', 'c', 'd']),
      openRow(2, ['a', 'b', 'c', 'd']),
      openRow(3, []),
      openRow(4, ['a'], { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }),
    ]);
    const window = predictedMergeWindow([item(1, { github: open[0]!.github })], 5);
    const scored = scoreConflictRisk({ open, window, filesByPr: filesByPr({ 1: ['a', 'b', 'c', 'd'], 2: ['a', 'b', 'c', 'd'], 3: [], 4: ['a'] }), hot: new Set() });
    expect(scored.get(2)!.score).toBe(1);               // 4 cold paths → saturated
    expect(scored.has(3)).toBe(false);
    expect(scored.has(4)).toBe(false);
  });
});

describe('buildConflictRiskReport', () => {
  it('emits a full report: window, threats, bands, counts and velocity', () => {
    const report = build({
      open: [
        openRow(1, ['a.ts'], { createdAt: '2026-11-04T00:00:00.000Z' }),   // predicted #1
        openRow(2, ['b.ts'], { createdAt: '2026-11-05T00:00:00.000Z' }),   // predicted #2
        openRow(3, ['a.ts', 'b.ts', 'c.ts']),                            // threatened by both → high
        openRow(4, ['a.ts']),                                            // hot shared path → medium
        openRow(5, ['a.ts'], { mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY' }), // already conflicting
        openRow(6, ['unrelated.ts']),
        { number: 7, garbage: true },                                    // unreadable row
      ],
      merged: [mergedRow(50, ['a.ts'], '2026-11-07T10:30:00.000Z')],       // a.ts churned 1.5h ago → hot
      next: 2,
    });
    expect(report.schema).toBe('fleet.conflict-risk.v1');
    expect(report.source).toBe('ok');
    expect(report.complete).toBe(true);
    expect(report.nextMerges.map(m => m.number)).toEqual([1, 2]);
    expect(report.nextMerges[0]!.tier).toBe('ready');
    expect(report.conflicting).toEqual([{ number: 5, headSha: SHA }]);
    const pr3 = report.risks.find(r => r.number === 3)!;
    // threats: #1 shares a.ts (hot), #2 shares b.ts (cold) → 1 - .5*.75 = .625 → high
    expect(pr3.score).toBe(0.625);
    expect(pr3.band).toBe('high');
    expect(pr3.rebaseRecommended).toBe(true);
    expect(pr3.conflictByPosition).toBe(1);
    expect(pr3.threats).toHaveLength(2);
    const pr4 = report.risks.find(r => r.number === 4)!;
    expect(pr4.band).toBe('medium');                                     // a.ts is hot → weight 2/4
    expect(pr4.conflictByPosition).toBe(1);
    expect(report.risks.map(r => r.number)).toEqual([3, 4]);
    expect(report.velocity).toMatchObject({ source: 'merged-page', merges: 1 });
    expect(report.horizonHours).not.toBeNull();
    expect(report.counts).toMatchObject({ open: 7, unreadable: 1, predicted: 2, conflicting: 1, high: 1, medium: 1, low: 0 });
    // Scoreable = #1,#2,#3,#4,#6 (#5 conflicting, #7 github-null); 2 flagged → 3 'none'.
    expect(report.counts.none).toBe(3);
  });

  it('reports degraded legs honestly and never fakes a clean report', () => {
    const failed = build({ open: 'failed', merged: 'failed', ledger: null });
    expect(failed.source).toBe('open-failed');
    expect(failed.reads).toEqual({ open: 'failed', merged: 'failed', ledger: 'unavailable' });
    expect(failed.velocity.source).toBe('unavailable');
    expect(failed.risks).toEqual([]);

    const noMerged = build({ open: [openRow(1, ['a']), openRow(2, ['a'])], merged: 'failed', ledger: null, next: 1 });
    expect(noMerged.reads.merged).toBe('failed');
    expect(noMerged.velocity.source).toBe('unavailable');
    expect(noMerged.horizonHours).toBeNull();
    expect(noMerged.hotWindowHours).toBe(24);                            // fallback
    // overlap still scored — recency evidence is just absent (all cold).
    expect(noMerged.risks[0]!.score).toBe(0.25);
  });

  it('falls back to the fleet ledger when the merged page fails', () => {
    const ledger = JSON.stringify({
      event: 'outcome', state: 'MERGED', job: 'RQ-X', ts: '2026-11-07T11:00:00.000Z',
      url: 'https://github.com/acme/app/pull/44',
    });
    const report = build({ open: [openRow(1)], merged: 'failed', ledger, next: 6 });
    expect(report.velocity).toMatchObject({ source: 'ledger', merges: 1, mergesPerHour: 1 / 6 });
    expect(report.horizonHours).toBe(36);                                // 6 merges at 1/6 per hour
    expect(report.hotWindowHours).toBe(36);
  });

  it('marks a full open page truncated', () => {
    const report = build({ open: [openRow(1), openRow(2)], limit: 2 });
    expect(report.source).toBe('truncated');
    expect(report.complete).toBe(false);
  });

  it('positions a window member so only earlier merges threaten it', () => {
    const report = build({
      open: [
        openRow(1, ['shared.ts'], { createdAt: '2026-11-04T00:00:00.000Z' }),
        openRow(2, ['shared.ts'], { createdAt: '2026-11-05T00:00:00.000Z' }),
        openRow(3, ['shared.ts'], { createdAt: '2026-11-06T00:00:00.000Z' }),
      ],
      next: 3,
    });
    expect(report.nextMerges.map(m => [m.number, m.position])).toEqual([[1, 1], [2, 2], [3, 3]]);
    const pr2 = report.risks.find(r => r.number === 2)!;
    expect(pr2.position).toBe(2);
    expect(pr2.threats.map(t => t.number)).toEqual([1]);                  // only the earlier merge
    expect(report.risks.find(r => r.number === 1)).toBeUndefined();       // nothing precedes it
    expect(report.risks.find(r => r.number === 3)!.threats.map(t => t.number)).toEqual([1, 2]);
  });

  it('scrubs titles and bounds every threat list', () => {
    const many = Array.from({ length: 12 }, (_, i) => `f${i}.ts`);
    const report = build({
      open: [openRow(1, many), openRow(2, many, { title: 'x'.repeat(400) })],
      next: 1,
    });
    const risk = report.risks.find(r => r.number === 2)!;
    expect(risk.title.length).toBeLessThanOrEqual(120);
    expect(risk.threats[0]!.shared).toHaveLength(8);
    expect(risk.threats[0]!.sharedTotal).toBe(12);
    expect(risk.score).toBe(1);                                           // saturated
    expect(risk.headSha).toBe(SHA);
  });
});

describe('readConflictRisk (injected gh)', () => {
  it('runs both gh reads and degrades cleanly on failure', async () => {
    const ok = await readConflictRisk({
      repo: REPO, gh: ghFor([openRow(1, ['a']), openRow(2, ['a'])], [mergedRow(9, ['a'])]),
      states: noStates, now: () => NOW, next: 1,
    });
    expect(ok.source).toBe('ok');
    expect(ok.velocity.source).toBe('merged-page');
    expect(ok.risks.find(r => r.number === 2)!.band).toBe('medium');     // a is hot

    const failed = await readConflictRisk({ repo: REPO, gh: ghFor('fail', 'fail'), states: noStates, now: () => NOW });
    expect(failed.source).toBe('open-failed');
    expect(failed.reason).toBe('gh-pr-list-failed');
  });
});

describe('cmdFleetConflictRisk', () => {
  const deps = (open: unknown[] | 'fail' = [openRow(1, ['a']), openRow(2, ['a'])], merged: unknown[] | 'fail' = []) => ({
    gh: ghFor(open, merged), jobs: async () => null as string | null, states: noStates, now: () => NOW,
  });

  it('emits the fleet.conflict-risk.v1 envelope per repo', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(await cmdFleetConflictRisk(['--repo', 'acme/app', '--next', '2', '--json'], deps())).toBe(0);
      const out = JSON.parse(log.mock.calls[0]![0]);
      expect(out.schema).toBe('fleet.conflict-risk.v1');
      expect(out.params).toEqual({ next: 2, limit: 200, mergedLimit: 50, windowHours: 6 });
      expect(out.repos).toHaveLength(1);
      expect(out.repos[0].repo).toBe('acme/app');
    } finally { vi.restoreAllMocks(); }
  });

  it('honors repeated --repo and the default repo; exits 1 on degraded reads', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      expect(await cmdFleetConflictRisk(['--repo', 'acme/app', '--repo', 'acme/other'], deps())).toBe(0);
      expect(log.mock.calls.filter(c => c[0].includes('acme/other')).length).toBeGreaterThan(0);
      expect(await cmdFleetConflictRisk(['--json'], deps())).toBe(0);
      expect(JSON.parse(log.mock.calls.at(-1)![0]).repos[0].repo).toBe('ashlrai/phantom');
      expect(await cmdFleetConflictRisk(['--repo', 'acme/app'], deps('fail'))).toBe(1);
      expect(await cmdFleetConflictRisk(['--repo', 'acme/app'], deps([openRow(1)], 'fail'))).toBe(1);
    } finally { vi.restoreAllMocks(); }
  });

  it('rejects bad usage without touching gh', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      for (const args of [
        ['--repo'], ['--repo', 'not a repo'], ['--repo', 'a/b', '--repo', 'a/b'],
        ['--next', '0'], ['--next', '33'], ['--next', 'x'], ['--limit', '0'],
        ['--merged-limit', '201'], ['--window-hours', '169'], ['--bogus'], ['conflict-risk'],
      ]) {
        expect(await cmdFleetConflictRisk(args, deps()), JSON.stringify(args)).toBe(2);
      }
      expect(await cmdFleetConflictRisk(['--help'], deps())).toBe(0);
    } finally { vi.restoreAllMocks(); }
  });

  it('registers conflict-risk for fleet dispatch', async () => {
    expect((await FLEET_SUBCOMMAND_LOADERS['conflict-risk']!()).cmdFleetConflictRisk).toBe(cmdFleetConflictRisk);
  });
});
