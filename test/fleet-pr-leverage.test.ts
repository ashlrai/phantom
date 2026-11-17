import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { leverageScore, rankPrLeverage } from '../src/core/fleet/pr-leverage.js';
import { cmdFleetPrLeverage } from '../src/cli/fleet-pr-leverage.js';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';
import { runMergeQueueCycle, type MergeQueuePr } from '../src/core/drive/merge-queue-loop.js';

const now = Date.parse('2026-11-16T12:00:00Z');
const url = (n: number, repo = 'phantom') => `https://github.com/ashlrai/${repo}/pull/${n}`;
const pr = (number: number, extra: Record<string, unknown> = {}) => ({ number, url: url(number), title: 'chore: formatting',
  state: 'OPEN', additions: 1, deletions: 0, updatedAt: '2026-11-16T00:00:00Z', files: [{ path: `src/${number}.ts` }], ...extra });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

it('prioritizes ambitious capabilities and counts cross-repo dependents without number collisions', () => {
  const report = rankPrLeverage([pr(1), pr(2, { title: 'feat: unlock new capability', additions: 350, deletions: 20 }),
    pr(1, { url: url(1, 'locus'), body: `Depends on ${url(2)}` }), pr(20, { body: `Depends on ${url(20)}` })], null, now);
  expect(report.ranked[0]).toMatchObject({ number: 2, signals: { deltaPotential: 40, dependents: 1, laneYield: null } });
  expect(report.ranked).toHaveLength(4);
  expect(report.ranked.find(p => p.number === 20)?.signals.dependents).toBe(0);
  expect(leverageScore({ title: 'placeholder', files: ['test/a.test.ts'], additions: 1, deletions: 0 }).slop).toBe(true);
});

it('clusters connected overlap, chooses strongest, and flags conflicts, drafts and stale work', () => {
  const files = [{ path: 'src/a.ts' }, { path: 'test/a.test.ts' }];
  const report = rankPrLeverage([pr(1, { files }), pr(2, { files, title: 'feat: enable fleet recovery' }),
    pr(3, { mergeable: 'CONFLICTING' }), pr(4, { updatedAt: '2026-10-01T00:00:00Z' }), pr(5, { isDraft: true })], '', now);
  expect(report.clusters).toEqual([{ strongest: url(2), reconcile: [url(1)] }]);
  expect(report.mergeOrder).toEqual([url(2)]);
  expect(report.ranked.filter(p => p.action === 'agent-rebase-or-close').map(p => p.number).sort()).toEqual([3, 4]);
});

it('credits only head-bound required checks and successful unique jobs in the UTC day', () => {
  const head = 'a'.repeat(40), mergedAt = '2026-11-15T12:00:00Z';
  const merged = pr(1, { state: 'MERGED', mergedAt, headRefOid: head, additions: 10, deletions: 2, requiredChecks: ['gate'],
    statusCheckRollup: [{ name: 'gate', headSha: head, conclusion: 'SUCCESS', completedAt: mergedAt }] });
  const jobs = [{ event: 'launch', job: 'a', pool: 'codex', ts: mergedAt },
    { event: 'publish', job: 'a', pr: url(3), ts: mergedAt },
    { event: 'finish', job: 'a', exit_code: 0, ts: mergedAt }, { event: 'finish', job: 'a', exit_code: 0, ts: mergedAt },
    { event: 'finish', job: 'bad', exit_code: 1, ts: mergedAt },
    { event: 'outcome', job: 'a', pr: url(99), state: 'MERGED', mergedAt, ts: mergedAt }].map(r => JSON.stringify(r)).join('\n');
  const report = rankPrLeverage([merged, pr(2, { ...merged, number: 2, url: url(2), requiredChecks: undefined }), pr(3)], jobs, now);
  expect(report.delta).toMatchObject({ prsMerged: 3, verifiedLines: 12, unmeasuredPrs: 2, jobsCompleted: 1 });
  expect(report.ranked[0]).toMatchObject({ lane: 'codex', signals: { laneYield: 0.5 } });
  expect(() => rankPrLeverage({}, null, now)).toThrow();
  expect(() => rankPrLeverage([pr(1, { url: url(2) })], null, now)).toThrow();
  expect(() => rankPrLeverage([], null, now, '2026-11-16')).toThrow();
});

it('offers a read-only CLI, explicit idempotent recording, strict arguments and registry wiring', async () => {
  const root = await mkdtemp(join(tmpdir(), 'pr-leverage-'));
  vi.stubEnv('ASHLR_RUNS_DIR', root);
  const path = join(root, 'prs.json'); await writeFile(path, JSON.stringify([pr(1)]));
  vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await cmdFleetPrLeverage(['--input', path, '--json'])).toBe(0);
  await expect(readFile(join(root, 'metrics/pr-delta.jsonl'), 'utf8')).rejects.toThrow();
  const args = ['--input', path, '--record-delta', '--json'];
  expect(await cmdFleetPrLeverage(args)).toBe(0); expect(await cmdFleetPrLeverage(args)).toBe(0);
  expect((await readFile(join(root, 'metrics/pr-delta.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(1);
  await writeFile(path, JSON.stringify([pr(2, { state: 'MERGED', mergedAt: new Date(Date.now() - 86_400_000).toISOString() })]));
  expect(await cmdFleetPrLeverage(args)).toBe(0);
  await writeFile(path, JSON.stringify([pr(1)])); expect(await cmdFleetPrLeverage(args)).toBe(0);
  expect((await readFile(join(root, 'metrics/pr-delta.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(3);
  expect(await cmdFleetPrLeverage(['--day'])).toBe(2);
  expect(await cmdFleetPrLeverage(['--json', '--json'])).toBe(2);
  expect(await cmdFleetPrLeverage(['--input', '/missing'])).toBe(1);
  expect(typeof (await FLEET_SUBCOMMAND_LOADERS['pr-leverage']!()).cmdFleetPrLeverage).toBe('function');
});

it('submits high-leverage queue candidates first while preserving red checks and holds', () => {
  const make = (number: number, title: string, checks = 'SUCCESS'): MergeQueuePr => ({ number, title, checks: checks as MergeQueuePr['checks'],
    id: `PR_${number}`, headSha: 'a'.repeat(40), baseRef: 'master', isDraft: false, author: 'ashlr-fleet[bot]', mergeable: 'MERGEABLE',
    mergeState: 'CLEAN', reviewDecision: null, inMergeQueue: false, autoMerge: false, files: ['src/a.ts'], filesTruncated: false });
  const calls: number[] = [];
  const report = runMergeQueueCycle({ now: () => now, readSnapshot: repo => ({ repo, defaultBranch: 'master', mergeQueue: true,
    prs: [make(1, 'chore: formatting'), make(2, 'feat: unlock capability'), make(3, 'feat: unlock capability', 'FAILURE'), make(4, 'feat: unlock capability'), make(5, 'feat: unlock capability RQ-DUP'), make(6, 'RQ-DUP'),
      { ...make(7, 'feat: unlock capability'), body: `Depends on ${url(1)}` }] }),
    readQueueIds: () => new Set(), readHoldList: () => new Set(['phantom#4']), loadState: () => null, saveState: () => {},
    log: () => {}, appendQueueLine: () => {}, updateBranch: () => {}, enqueue: (_repo, p) => { calls.push(p.number); } }, { repos: ['ashlrai/phantom'] });
  expect(calls).toEqual([2, 5, 1, 7]); expect(report.repos[0]?.totals.reconcile).toBe(1); expect(report.repos[0]?.leverage?.ranked[0]?.signals.deltaPotential).toBe(40);
});

it('orders dependencies before bold dependents and reports cycles for agents', () => {
  const report = rankPrLeverage([pr(1), pr(2, { title: 'feat: unlock capability', body: `Depends on ${url(1)}` })], null, now);
  expect(report.mergeOrder).toEqual([url(1), url(2)]);
  const cycle = rankPrLeverage([pr(1, { body: `Depends on ${url(2)}` }), pr(2, { body: `Depends on ${url(1)}` })], null, now);
  expect(rankPrLeverage([pr(1, { body: `Depends on ${url(999)}` })], null, now).dependencyBlocked).toEqual([url(1)]);
  expect(cycle.mergeOrder).toEqual([]); expect(cycle.dependencyBlocked).toHaveLength(2);
  const transitive = rankPrLeverage([pr(1, { title: 'RQ-ONE' }), pr(2, { title: 'feat: unlock RQ-ONE', body: 'after=RQ-OTHER' }),
    pr(3, { title: 'RQ-OTHER', body: 'after=RQ-ONE' })], null, now);
  expect(transitive.clusters[0]?.strongest).toBe(url(2)); expect(transitive.dependencyBlocked).toContain(url(3));
});

it('does not credit a stale head or late check, and preserves malformed ledgers on record failure', async () => {
  const head = 'a'.repeat(40), mergedAt = '2026-11-15T12:00:00Z';
  for (const observation of [{ headSha: 'b'.repeat(40), completedAt: mergedAt }, { headSha: head, completedAt: '2026-11-16T00:00:00Z' }]) {
    expect(rankPrLeverage([pr(1, { state: 'MERGED', mergedAt, headRefOid: head, requiredChecks: ['gate'],
      statusCheckRollup: [{ name: 'gate', conclusion: 'SUCCESS', ...observation }] })], null, now).delta.verifiedLines).toBe(0);
  }
  const root = await mkdtemp(join(tmpdir(), 'pr-delta-invalid-')); vi.stubEnv('ASHLR_RUNS_DIR', root);
  const path = join(root, 'prs.json'); await writeFile(path, '[]');
  vi.spyOn(console, 'log').mockImplementation(() => {}); vi.spyOn(console, 'error').mockImplementation(() => {});
  const args = ['--input', path, '--record-delta']; expect(await cmdFleetPrLeverage(args)).toBe(0);
  const ledger = join(root, 'metrics/pr-delta.jsonl'); await writeFile(ledger, 'malformed\n');
  expect(await cmdFleetPrLeverage(args)).toBe(1); expect(await readFile(ledger, 'utf8')).toBe('malformed\n');
});
