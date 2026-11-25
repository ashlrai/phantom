import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { postMergeBacklogItems } from '../src/core/improve/postmerge-backlog.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';
import { recordPostMergeObservation } from '../src/core/fleet/post-merge-observations.js';
import type { EvalObservationRow } from '../src/core/fleet/eval-report.js';

let home: string;
let saved: { HOME?: string; ASHLR_HOME?: string };
beforeEach(() => {
  saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME };
  delete process.env.ASHLR_HOME;
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'improve-postmerge-')));
  process.env.HOME = home;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(home, { recursive: true, force: true });
});

const NOW = new Date('2026-11-23T12:00:00Z');
const daysAgo = (days: number): string => new Date(NOW.getTime() - days * 86_400_000).toISOString();
const sha = (n: number): string => n.toString(16).padStart(40, '0');

let jobSeq = 0;
/**
 * One fleet job's ledger rows for a merged PR: a launch carrying the
 * lane/tier/repo routing labels, a publish binding the PR url to the job,
 * and the MERGED outcome row carrying the merge commit the observation
 * ledger keys on.
 */
const mergeJob = (
  lane: string,
  tier: string,
  repoLabel: string,
  prRepo: string,
  prNumber: number,
  mergeCommit: string,
  mergedDaysAgo: number,
): Record<string, unknown>[] => {
  const job = `RQ-PM-${++jobSeq}`;
  const url = `https://github.com/${prRepo}/pull/${prNumber}`;
  return [
    { event: 'launch', job, repo: repoLabel, lane, tier, ts: daysAgo(mergedDaysAgo + 1) },
    { event: 'publish', job, url, ts: daysAgo(mergedDaysAgo) },
    { event: 'outcome', job, url, state: 'MERGED', mergedAt: daysAgo(mergedDaysAgo), mergeCommit, ts: daysAgo(mergedDaysAgo) },
  ];
};

const ledger = (rows: Record<string, unknown>[]): string => rows.map((r) => JSON.stringify(r)).join('\n') + '\n';

const obs = (rows: EvalObservationRow[]) => ({ sourceState: 'healthy' as const, rows });
const adverse = (commit: number, outcome: EvalObservationRow['outcome'], confidence: EvalObservationRow['confidence'] = 'deterministic'): EvalObservationRow =>
  ({ mergeCommit: sha(commit), outcome, confidence });

/**
 * The recurring fixture. Adverse merges (commit → outcome):
 *   devin/work on ashlrai/phantom: c1 reverted, c2 regressed (heuristic),
 *     c3 followed-up — lane devin and tier work cells;
 *   codex/fast phantom c4 reverted — below every bar;
 *   claude-api/frontier phantom c5 reverted, stack/frontier lexicon c6
 *     regressed, devin/frontier phantom c7 followed-up — tier frontier;
 *   devin/work locus c8 reverted, codex/work locus c9 regressed,
 *     claude-api/mid locus c10 followed-up — repo ashlrai/locus;
 *   unattributed phantom c11-13 — repo cell evidence with no lane/tier.
 * Group tallies: lane devin 5 adverse, tier work 5, tier frontier 3,
 * repo phantom 9, repo locus 3, repo lexicon 1; lane codex 2,
 * lane claude-api 2, lane stack 1, tier fast 1, tier mid 1.
 */
function fixture(): { jobs: string; observations: EvalObservationRow[] } {
  jobSeq = 0;
  const rows: Record<string, unknown>[] = [];
  const observations: EvalObservationRow[] = [];
  let commit = 1;
  const adverseMerge = (lane: string, tier: string, repoLabel: string, prRepo: string, prNumber: number, outcome: EvalObservationRow['outcome'], confidence?: EvalObservationRow['confidence']) => {
    rows.push(...mergeJob(lane, tier, repoLabel, prRepo, prNumber, sha(commit), 5 + commit));
    observations.push(adverse(commit, outcome, confidence));
    commit++;
  };
  adverseMerge('devin', 'work', 'phantom', 'ashlrai/phantom', 101, 'reverted');
  adverseMerge('devin', 'work', 'phantom', 'ashlrai/phantom', 102, 'regressed', 'heuristic');
  adverseMerge('devin', 'work', 'phantom', 'ashlrai/phantom', 103, 'followed-up');
  adverseMerge('codex', 'fast', 'phantom', 'ashlrai/phantom', 104, 'reverted');
  adverseMerge('claude-api', 'frontier', 'phantom', 'ashlrai/phantom', 105, 'reverted');
  adverseMerge('stack', 'frontier', 'lexicon', 'ashlrai/lexicon', 201, 'regressed');
  adverseMerge('devin', 'frontier', 'phantom', 'ashlrai/phantom', 106, 'followed-up');
  adverseMerge('devin', 'work', 'locus', 'ashlrai/locus', 301, 'reverted');
  adverseMerge('codex', 'work', 'locus', 'ashlrai/locus', 302, 'regressed');
  adverseMerge('claude-api', 'mid', 'locus', 'ashlrai/locus', 303, 'followed-up');
  for (const [i, outcome] of (['reverted', 'regressed', 'followed-up'] as const).entries()) {
    const n = 400 + i;
    rows.push({ event: 'outcome', url: `https://github.com/ashlrai/phantom/pull/${n}`, state: 'MERGED', mergedAt: daysAgo(6 + i), mergeCommit: sha(commit), ts: daysAgo(6 + i) });
    observations.push(adverse(commit, outcome));
    commit++;
  }
  return { jobs: ledger(rows), observations };
}

const byPrefix = (items: { id: string }[], prefix: string) => items.filter((i) => i.id.startsWith(prefix));

describe('postMergeBacklogItems', () => {
  it('turns a recurring lane adverse fold into a valid priority-3 backlog item', async () => {
    const { jobs, observations } = fixture();
    const items = await postMergeBacklogItems({ repo: 'ashlrai/phantom', jobsText: jobs, observations: obs(observations), now: NOW });
    const lane = byPrefix(items, 'postmerge-lane-');
    expect(lane).toHaveLength(1);
    const item = lane[0]!;
    expect(item.id).toMatch(/^postmerge-lane-[0-9a-f]{16}$/);
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom', area: 'post-merge-outcomes' });
    expect(item.title).toContain('devin');
    expect(item.prompt).toContain("lane 'devin'");
    expect(item.prompt).toContain('5 merged PR(s)');
    expect(item.prompt).toContain('2 reverted, 1 regressed, 2 followed-up');
    expect(item.prompt).toContain('4 deterministic, 1 heuristic');
    expect(item.prompt).toContain('phm fleet eval-report');
    expect(item.prompt).toContain('post-merge-observations.jsonl');
    expect(item.prompt).toContain('no-change');
    expect(item.prompt).toContain('/pull/101');
  });

  it('emits tier items for recurring tiers and a repo item for the target repo', async () => {
    const { jobs, observations } = fixture();
    const items = await postMergeBacklogItems({ repo: 'ashlrai/phantom', jobsText: jobs, observations: obs(observations), now: NOW });
    const tiers = byPrefix(items, 'postmerge-tier-');
    expect(tiers.map((i) => i.title).join('\n')).toContain('frontier');
    expect(tiers.map((i) => i.title).join('\n')).toContain('work');
    for (const item of tiers) expect(validBacklogItem(item)).not.toBeNull();
    const repos = byPrefix(items, 'postmerge-repo-');
    // The phantom repo cell recurs (attributed + unattributed adverse merges);
    // locus's cell exists in the fold but must not land on this target.
    expect(repos).toHaveLength(1);
    expect(repos[0]!.title).toContain('phantom');
    expect(items.filter((i) => i.title.includes('locus') || i.title.includes('lexicon'))).toHaveLength(0);
    // codex (2), claude-api (2), stack (1), fast (1), mid (1) all stay below the bar.
    expect(items.filter((i) => i.title.includes('codex') || i.title.includes('claude-api') || i.title.includes('stack'))).toHaveLength(0);
  });

  it('emits the matching repo item for that repository only', async () => {
    const { jobs, observations } = fixture();
    const items = await postMergeBacklogItems({ repo: 'ashlrai/locus', jobsText: jobs, observations: obs(observations), now: NOW });
    const repos = byPrefix(items, 'postmerge-repo-');
    expect(repos).toHaveLength(1);
    expect(repos[0]).toMatchObject({ priority: 3, repo: 'ashlrai/locus', area: 'post-merge-outcomes' });
    expect(repos[0]!.title).toContain('locus');
    expect(repos[0]!.prompt).toContain("repo 'ashlrai/locus'");
    expect(repos[0]!.prompt).toContain('3 merged PR(s)');
    expect(repos[0]!.prompt).toContain('1 reverted, 1 regressed, 1 followed-up');
    // Lane and tier cells describe this fleet's machinery — never another target's.
    expect(byPrefix(items, 'postmerge-lane-')).toHaveLength(0);
    expect(byPrefix(items, 'postmerge-tier-')).toHaveLength(0);
  });

  it('emits nothing below the recurring bar or with clean evidence', async () => {
    jobSeq = 0;
    const minimal = ledger(mergeJob('devin', 'work', 'phantom', 'ashlrai/phantom', 501, sha(900), 8));
    const one = await postMergeBacklogItems({
      repo: 'ashlrai/phantom', jobsText: minimal,
      observations: obs([{ mergeCommit: sha(900), outcome: 'reverted', confidence: 'deterministic' }]),
      now: NOW,
    });
    expect(one).toEqual([]);
    const { jobs } = fixture();
    const clean = await postMergeBacklogItems({
      repo: 'ashlrai/phantom', jobsText: jobs, observations: obs([]), now: NOW,
    });
    expect(clean).toEqual([]);
    const below = await postMergeBacklogItems({
      repo: 'ashlrai/phantom', jobsText: jobs,
      observations: obs([adverse(1, 'reverted'), adverse(2, 'regressed')]), now: NOW,
    });
    // Two adverse merges can never reach the bar in any single cell.
    expect(below).toEqual([]);
  });

  it('emits nothing for degraded observations, a missing jobs ledger or a missing observation source', async () => {
    const { jobs, observations } = fixture();
    const degraded = await postMergeBacklogItems({
      repo: 'ashlrai/phantom', jobsText: jobs,
      observations: { sourceState: 'degraded', rows: observations }, now: NOW,
    });
    expect(degraded).toEqual([]);
    const missingJobs = await postMergeBacklogItems({
      repo: 'ashlrai/phantom', runsDir: path.join(home, 'no-such-runs'),
      observations: obs(observations), now: NOW,
    });
    expect(missingJobs).toEqual([]);
    const missingObs = await postMergeBacklogItems({
      repo: 'ashlrai/phantom', jobsText: jobs,
      observations: { sourceState: 'missing', rows: [] }, now: NOW,
    });
    expect(missingObs).toEqual([]);
  });

  it('reads jobs.jsonl from the runs dir when no text is injected', async () => {
    const { jobs, observations } = fixture();
    const runsDir = path.join(home, 'runs');
    fs.mkdirSync(path.join(runsDir, 'metrics'), { recursive: true });
    fs.writeFileSync(path.join(runsDir, 'metrics', 'jobs.jsonl'), jobs);
    const items = await postMergeBacklogItems({ repo: 'ashlrai/phantom', runsDir, observations: obs(observations), now: NOW });
    expect(byPrefix(items, 'postmerge-lane-')).toHaveLength(1);
  });

  it('joins real signed observation rows through the production read path', async () => {
    process.env.ASHLR_HOME = path.join(home, '.ashlr');
    jobSeq = 0;
    const rows: Record<string, unknown>[] = [];
    for (const [i, outcome] of (['reverted', 'regressed', 'followed-up'] as const).entries()) {
      const commit = sha(700 + i);
      rows.push(...mergeJob('devin', 'work', 'phantom', 'ashlrai/phantom', 601 + i, commit, 5 + i));
      const recorded = recordPostMergeObservation({
        observedAt: daysAgo(2),
        outcome,
        basis: outcome === 'reverted' ? 'git-revert-reference' : 'bisect-first-bad',
        confidence: 'deterministic',
        repo: path.join(home, 'phantom'),
        proposalId: `proposal-pm-${i}`,
        mergeCommit: commit,
        observedHead: sha(800 + i),
      });
      expect(recorded.recorded).toBe(1);
    }
    const items = await postMergeBacklogItems({
      repo: 'ashlrai/phantom', jobsText: ledger(rows), now: NOW,
    });
    const lane = byPrefix(items, 'postmerge-lane-');
    expect(lane).toHaveLength(1);
    expect(lane[0]!.title).toContain('devin');
    expect(lane[0]!.prompt).toContain('1 reverted, 1 regressed, 1 followed-up');
  });

  it('derives stable ids so a refresh re-adds nothing and honours the limit', async () => {
    const { jobs, observations } = fixture();
    const first = await postMergeBacklogItems({ repo: 'ashlrai/phantom', jobsText: jobs, observations: obs(observations), now: NOW });
    const second = await postMergeBacklogItems({ repo: 'ashlrai/phantom', jobsText: jobs, observations: obs(observations), now: NOW });
    expect(first.length).toBeGreaterThan(1);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    const one = await postMergeBacklogItems({ repo: 'ashlrai/phantom', jobsText: jobs, observations: obs(observations), now: NOW, limit: 1 });
    expect(one).toHaveLength(1);
    expect(one[0]!.id).toBe(first[0]!.id);
  });

  it('scrubs secret-shaped text out of recorded names before it reaches a prompt', async () => {
    const token = `ghp_${'a'.repeat(36)}`;
    jobSeq = 0;
    const rows: Record<string, unknown>[] = [];
    const observations: EvalObservationRow[] = [];
    for (const [i, outcome] of (['reverted', 'regressed', 'followed-up'] as const).entries()) {
      const commit = sha(600 + i);
      rows.push(...mergeJob(token, 'work', 'phantom', 'ashlrai/phantom', 701 + i, commit, 5 + i));
      observations.push(adverse(commit, outcome));
    }
    const items = await postMergeBacklogItems({
      repo: 'ashlrai/phantom', jobsText: ledger(rows), observations: obs(observations), now: NOW,
    });
    const lane = byPrefix(items, 'postmerge-lane-');
    expect(lane).toHaveLength(1);
    expect(lane[0]!.prompt).not.toContain(token);
    expect(lane[0]!.prompt).toContain('[REDACTED]');
    for (const item of items) expect(item.prompt).not.toContain(token);
  });

  it('appends post-merge items through discovery and dedupes on refresh', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    try {
      const { jobs } = fixture();
      const runsDir = path.join(home, 'runs');
      fs.mkdirSync(path.join(runsDir, 'metrics'), { recursive: true });
      fs.writeFileSync(path.join(runsDir, 'metrics', 'jobs.jsonl'), jobs);
      process.env.ASHLR_RUNS_DIR = runsDir;
      process.env.ASHLR_HOME = path.join(home, '.ashlr-e2e');
      // Signed rows for the fixture's first three devin merges (sha(1..3)).
      for (const [i, outcome] of (['reverted', 'regressed', 'followed-up'] as const).entries()) {
        const recorded = recordPostMergeObservation({
          observedAt: daysAgo(2),
          outcome,
          basis: 'bisect-first-bad',
          confidence: 'deterministic',
          repo: path.join(home, 'phantom'),
          proposalId: `proposal-e-${i}`,
          mergeCommit: sha(i + 1),
          observedHead: sha(960 + i),
        });
        expect(recorded.recorded).toBe(1);
      }
      const greenGh = async (args: string[]) => {
        const p = args[4] ?? '';
        if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
        return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
      };
      const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
      const post = first.items.filter((i) => i.id.startsWith('postmerge-'));
      expect(post.length).toBeGreaterThan(0);
      expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
      expect(appendUserBacklogItems(post)).toBe(post.length);
      const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
      expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('postmerge-')))).toBe(0);
      expect(readUserBacklogItems().filter((i) => i.id.startsWith('postmerge-'))).toHaveLength(post.length);
    } finally {
      vi.useRealTimers();
    }
  });
});
