import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { leverageScore, rankPrLeverage } from '../src/core/fleet/pr-leverage.js';
import { cmdFleetPrLeverage } from '../src/cli/fleet-pr-leverage.js';

// Recovered from PR #6500 (pinned source SHA 8af08bffc560103b88964a9612d3735f2e9cc253).
// Merge-queue ordering and registry wiring are intentionally not covered here.

const now = Date.parse('2026-11-16T12:00:00Z');
const url = (n: number, repo = 'phantom') => `https://github.com/ashlrai/${repo}/pull/${n}`;
const pr = (number: number, extra: Record<string, unknown> = {}) => ({
  number, url: url(number), title: 'chore: formatting', state: 'OPEN', additions: 1, deletions: 0,
  updatedAt: '2026-11-16T00:00:00Z', files: [{ path: `src/${number}.ts` }], ...extra,
});

let root: string;
let logs: string[];
let errors: string[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pr-leverage-619s-'));
  vi.stubEnv('ASHLR_RUNS_DIR', root);
  logs = [];
  errors = [];
  vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.map(String).join(' ')); });
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { errors.push(args.map(String).join(' ')); });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

const writeSnapshot = async (name: string, value: unknown): Promise<string> => {
  const path = join(root, name);
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value));
  return path;
};

describe('advisory ranking (pure)', () => {
  it('ranks useful recovery ahead of cosmetic work and keeps the order deterministic', () => {
    const snapshot = [pr(1), pr(2, { title: 'feat: unlock new capability', additions: 350, deletions: 20 }),
      pr(3, { body: `Depends on ${url(2)}` })];
    const report = rankPrLeverage(snapshot, null, now);
    expect(report).toMatchObject({ advisory: true, coverage: 'provided-snapshot' });
    expect(report.ranked[0]).toMatchObject({ number: 2, signals: { deltaPotential: 40 } });
    // Cosmetic ties (score 2.5 each) fall back to URL order, so the ranking is total and stable.
    expect(report.ranked.map(p => p.number)).toEqual([2, 1, 3]);
    // Input order must not change the ranking.
    const shuffled = rankPrLeverage([...snapshot].reverse(), null, now);
    expect(shuffled.ranked.map(p => p.url)).toEqual(report.ranked.map(p => p.url));
    expect(leverageScore({ title: 'placeholder', files: ['test/a.test.ts'], additions: 1, deletions: 0 }).slop).toBe(true);
  });

  it('keeps an unmet dependency blocked and never orders it ahead of its predecessor', () => {
    const report = rankPrLeverage([pr(1), pr(2, { title: 'feat: unlock capability', body: `Depends on ${url(1)}` }),
      pr(3, { body: `Depends on ${url(999)}` })], null, now);
    expect(report.mergeOrder).toEqual([url(1), url(2)]);
    expect(report.dependencyBlocked).toEqual([url(3)]);
    expect(report.mergeOrder).not.toContain(url(3));
  });

  it('never orders members of a dependency cycle and reports both as blocked', () => {
    const cycle = rankPrLeverage([pr(1, { body: `Depends on ${url(2)}` }), pr(2, { body: `Depends on ${url(1)}` })], null, now);
    expect(cycle.mergeOrder).toEqual([]);
    expect(cycle.dependencyBlocked).toHaveLength(2);
  });

  it('reports same-job overlap as review groups that never enter the merge order', () => {
    const report = rankPrLeverage([pr(1, { title: 'RQ-ONE: first' }), pr(2, { title: 'feat: unlock RQ-ONE' })], null, now);
    expect(report.clusters).toEqual([{ strongest: url(2), reconcile: [url(1)] }]);
    expect(report.mergeOrder).toEqual([url(2)]);
    expect(report.mergeOrder).not.toContain(url(1));
  });

  it('flags conflicting, drafted and stale work without closing it automatically', () => {
    const report = rankPrLeverage([pr(3, { mergeable: 'CONFLICTING' }), pr(4, { updatedAt: '2026-10-01T00:00:00Z' }),
      pr(5, { isDraft: true })], '', now);
    expect(report.ranked.find(p => p.number === 3)?.action).toBe('agent-rebase-or-close');
    expect(report.ranked.find(p => p.number === 4)?.action).toBe('agent-rebase-or-close');
    expect(report.ranked.find(p => p.number === 5)?.action).toBe('draft');
    expect(report.mergeOrder).toEqual([]);
  });

  it('credits only exact-head complete check evidence and successful unique jobs in the UTC day', () => {
    const head = 'a'.repeat(40), mergedAt = '2026-11-15T12:00:00Z';
    const merged = pr(1, { state: 'MERGED', mergedAt, headRefOid: head, additions: 10, deletions: 2, requiredChecks: ['gate'],
      statusCheckRollup: [{ name: 'gate', headSha: head, conclusion: 'SUCCESS', completedAt: mergedAt }] });
    const jobs = [{ event: 'launch', job: 'a', pool: 'codex', ts: mergedAt },
      { event: 'publish', job: 'a', pr: url(3), ts: mergedAt },
      { event: 'finish', job: 'a', exit_code: 0, ts: mergedAt }, { event: 'finish', job: 'a', exit_code: 0, ts: mergedAt },
      { event: 'finish', job: 'bad', exit_code: 1, ts: mergedAt },
      { event: 'outcome', job: 'a', pr: url(99), state: 'MERGED', mergedAt, ts: mergedAt }].map(r => JSON.stringify(r)).join('\n');
    const report = rankPrLeverage([merged, pr(2, { ...merged, number: 2, url: url(2), requiredChecks: undefined }), pr(3)],
      jobs, now, '2026-11-15');
    // PR 1 is exact-head verified (10+2). PR 2 lacks required checks and the jobs outcome row for url 99 has no
    // snapshot entry; both stay unmeasured rather than being credited.
    expect(report.delta).toMatchObject({ day: '2026-11-15', prsMerged: 3, verifiedLines: 12, unmeasuredPrs: 2, jobsCompleted: 1 });
    expect(report.ranked[0]).toMatchObject({ lane: 'codex', signals: { laneYield: 0.5 } });
  });

  it('does not credit a stale head or a check completed after the day ended', () => {
    const head = 'a'.repeat(40), mergedAt = '2026-11-15T12:00:00Z';
    for (const observation of [{ headSha: 'b'.repeat(40), completedAt: mergedAt }, { headSha: head, completedAt: '2026-11-16T00:00:00Z' }]) {
      expect(rankPrLeverage([pr(1, { state: 'MERGED', mergedAt, headRefOid: head, requiredChecks: ['gate'],
        statusCheckRollup: [{ name: 'gate', conclusion: 'SUCCESS', ...observation }] })], null, now, '2026-11-15').delta.verifiedLines).toBe(0);
    }
  });

  it('treats absent jobs evidence as unknown (null), not zero', () => {
    const report = rankPrLeverage([pr(1, { state: 'MERGED', mergedAt: '2026-11-15T12:00:00Z', additions: 3, deletions: 1 })],
      null, now, '2026-11-15');
    expect(report.delta.jobsCompleted).toBeNull();
    expect(report.dependencies).toEqual({});
  });

  it('rejects malformed snapshots, duplicate-looking URLs and incomplete delta days', () => {
    expect(() => rankPrLeverage({}, null, now)).toThrow();
    expect(() => rankPrLeverage([pr(1, { url: url(2) })], null, now)).toThrow();
    expect(() => rankPrLeverage([], null, now, '2026-11-16')).toThrow();
  });
});

describe('cmdFleetPrLeverage (real CLI, temp runs root)', () => {
  it('returns advisory provided-snapshot JSON for a synthetic snapshot and writes no ledger by default', async () => {
    const input = await writeSnapshot('prs.json', [pr(1), pr(2, { title: 'feat: unlock capability', additions: 50, deletions: 5 })]);
    expect(await cmdFleetPrLeverage(['--input', input, '--json'])).toBe(0);
    const report = JSON.parse(logs.at(-1)!);
    expect(report).toMatchObject({ schema: 'fleet.pr-leverage.v1', advisory: true, coverage: 'provided-snapshot' });
    expect(report.ranked[0].number).toBe(2);
    await expect(readFile(join(root, 'metrics', 'pr-delta.jsonl'), 'utf8')).rejects.toThrow();
  });

  it('records a complete day idempotently and refuses to write while another writer holds the lock', async () => {
    const input = await writeSnapshot('prs.json', [pr(1, { state: 'MERGED', mergedAt: '2026-11-15T12:00:00Z',
      additions: 4, deletions: 1 })]);
    const args = ['--input', input, '--day', '2026-11-15', '--record-delta', '--json'];
    const ledger = join(root, 'metrics', 'pr-delta.jsonl');
    expect(await cmdFleetPrLeverage(args)).toBe(0);
    expect(await cmdFleetPrLeverage(args)).toBe(0);
    const rows = (await readFile(ledger, 'utf8')).trim().split('\n');
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!)).toMatchObject({ schema: 'fleet.delta.v1', day: '2026-11-15', prsMerged: 1 });

    await writeFile(`${ledger}.lock`, '');
    expect(await cmdFleetPrLeverage(args)).toBe(1);
    expect(await readFile(ledger, 'utf8')).toBe(rows[0] + '\n');
    await rm(`${ledger}.lock`);
  });

  it('fails malformed or non-canonical input without echoing the raw private value', async () => {
    const secret = 'TEST-ONLY-PRIVATE-619';
    const malformed = await writeSnapshot('bad.json', `[{"url": "${secret}"`);
    expect(await cmdFleetPrLeverage(['--input', malformed])).toBe(1);
    const foreign = await writeSnapshot('foreign.json', [{ url: `https://example.invalid/${secret}/pull/1`, number: 1, title: secret }]);
    expect(await cmdFleetPrLeverage(['--input', foreign])).toBe(1);
    expect(errors.join('\n')).toContain('no merge action taken');
    expect(errors.join('\n')).not.toContain(secret);
    expect(logs.join('\n')).not.toContain(secret);
  });

  it('rejects unknown flags and duplicated flags with usage exit 2', async () => {
    expect(await cmdFleetPrLeverage(['--day'])).toBe(2);
    expect(await cmdFleetPrLeverage(['--json', '--json'])).toBe(2);
    expect(await cmdFleetPrLeverage(['--merge'])).toBe(2);
  });
});
