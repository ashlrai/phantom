import { describe, test, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeRank, SEEDS, updateRank, readRank, validRank, localMerges } from '../src/core/fleet/repo-rank.js';
import { allocateRepos, readRepoPriority, setRepoPriority, type RepoMarketEvidence } from '../src/core/fleet/repo-market.js';
import { managedRepoCatalog, parseRepoMarketFacts, planRepoChange } from '../src/core/fleet/repos-manager.js';
const now = new Date('2026-11-04T12:00:00Z');

test('repository management distinguishes unknown metrics and routes scope changes to grant review', () => {
  const facts = parseRepoMarketFacts({ data: {
    repo0: { nameWithOwner: 'AshlrAI/Locus', pullRequests: { totalCount: 0 }, defaultBranchRef: { target: { statusCheckRollup: { state: 'FAILURE' } } } },
    merges0: { issueCount: 5 },
  } }, ['ashlrai/locus', 'ashlrai/binshield']);
  expect(facts.get('ashlrai/locus')).toMatchObject({ openPrs: 0, mergesPerDay: 5, ciHealth: 'red', lastRelease: null });
  expect(facts.get('ashlrai/binshield')).toMatchObject({ openPrs: null, mergesPerDay: null, ciHealth: null });
  expect(planRepoChange('morphkit', 'add')).toMatchObject({
    repo: 'ashlrai/morphkit', status: 'grant-required', command: ['phm', 'authority', 'draft', '--new', '--json'],
  });
});

test('allocation responds to evidence, and boost and pause are bounded', () => {
  const base: Omit<RepoMarketEvidence, 'repo'> = {
    eligible: true, priority: 'normal', queueDepth: null, ciHealth: null, issues: null, bugs: null, stars: null, mergesPerDay: null,
  };
  const rows = allocateRepos([
    { ...base, repo: 'a/base' },
    { ...base, repo: 'a/boosted', priority: 'boost' },
    { ...base, repo: 'a/red', ciHealth: 'red' },
    { ...base, repo: 'a/paused', priority: 'pause', ciHealth: 'red' },
  ]);
  expect(rows.map(row => row.score)).toEqual([2, 1.25, 1, 0]);
  expect(rows[0]?.reasonCodes).toContain('default_branch_ci_failing');
  expect(rows[3]?.reasonCodes).toContain('owner_pause');
  const directory = mkdtempSync(join(tmpdir(), 'repo-nudge-'));
  try {
    setRepoPriority('locus', 'pause', directory);
    expect(readRepoPriority('ashlrai/locus', directory)).toBe('pause');
    expect(readRepoPriority('ashlrai/lexicon', directory)).toBe('normal');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

test('the manager includes the effective stage for repos beyond the ecosystem seed list', () => {
  const enrolled = new Set(['ashlrai/local-only']);
  const active = Array.from({ length: 28 }, (_, i) => ({
    nameWithOwner: `AshlrAI/Project-${i}`, stage: i < 16 ? 'merge' as const : 'propose' as const,
  }));
  const catalog = managedRepoCatalog(enrolled, [...active, { nameWithOwner: 'ashlrai/cortex', stage: 'merge' }]);
  expect([...catalog.values()].filter(row => row.grantStage === 'merge')).toHaveLength(17);
  expect([...catalog.values()].filter(row => row.grantStage === 'propose')).toHaveLength(12);
  expect(catalog.get('ashlrai/project-27')).toEqual({ label: 'project-27', logo: null, grantStage: 'propose' });
  expect(catalog.get('ashlrai/cortex')).toMatchObject({ logo: 'cortex-logo.svg', grantStage: 'merge' });
  expect(catalog.get('ashlrai/local-only')).toMatchObject({ grantStage: null });
});

test('only current or previous weekly findings add to the estimate before the owner multiplier', () => {
  const period = Math.floor(+now / (7 * 86400000));
  const report = { schema: 'repo-freshness.v1', repos: {
    'a/drift': { docs: { period, verdict: 'drift' }, site: { period: period - 1, verdict: 'unhealthy' } },
    'a/unknown': { docs: { period, verdict: 'unknown' }, site: { period: period - 2, verdict: 'stale' } },
  } };
  const rows = allocateRepos(['a/drift', 'a/unknown'].map(repo => ({
    repo, eligible: true, priority: 'boost', queueDepth: null, ciHealth: null, issues: null, bugs: null, stars: null, mergesPerDay: null,
  })), report, +now);
  expect(rows[0]).toMatchObject({ repo: 'a/drift', score: 2.5, reasonCodes: ['flat_baseline', 'docs_freshness_drift', 'site_freshness_unhealthy', 'owner_boost'] });
  expect(rows[1]).toMatchObject({ repo: 'a/unknown', score: 1.25, reasonCodes: ['flat_baseline', 'owner_boost'] });
});
describe('repository ranking', () => {
  test('flat, normalized shares without evidence', () => {
    const s = computeRank([], now);
    expect(s.rankings.map(r => r.repo)).toEqual(SEEDS);
    expect(s.rankings.every(row => row.weight === 1 / SEEDS.length)).toBe(true);
    expect(s.rankings.reduce((n, r) => n + r.weight, 0)).toBeCloseTo(1);
    expect(validRank(s)).toBe(true);
  });
  test('half life, cutoff, future evidence and leverage proposals', () => {
    const s = computeRank([
      { repo: 'phantom', mergedAt: '2026-10-28T12:00:00Z', title: 'restock' },
      { repo: 'phantom', mergedAt: '2026-10-01T12:00:00Z', title: 'cos' },
      { repo: 'phantom', mergedAt: '2026-11-05T12:00:00Z', title: 'cos' },
      ...[1, 2].map(() => ({ repo: 'candidate', mergedAt: now.toISOString(), title: 'feature', body: 'needs-you automations' })),
    ], now);
    expect(s.rankings.find(row => row.repo === 'phantom')?.recency).toBe(0.5);
    expect(s.rankings.find(row => row.repo === 'phantom')?.leverage).toBe(2);
    expect(s.proposals.map(r => r.repo)).toEqual(['candidate']);
    expect(s.enrolled).not.toContain('candidate');
    expect(computeRank([], now)).toEqual(computeRank([], now));
  });
  test('daily ceiling including recompute and bounded persisted history', () => {
    const dir = mkdtempSync(join(tmpdir(), 'repo-rank-'));
    const path = join(dir, 'rank.json');
    try {
      const first = updateRank(() => [], { path, now });
      expect(updateRank(() => { throw Error('must remain cached'); }, { path, now, recompute: true })).toEqual(first);
      for (let day = 1; day < 35; day++) updateRank(() => [], { path, now: new Date(+now + day * 86400000) });
      expect(readRank(path)?.history).toHaveLength(30);
      const edited = readRank(path)!;
      edited.enrolled.push('manual-repo');
      writeFileSync(path, JSON.stringify(edited));
      const updated = updateRank(() => [], { path, now: new Date(+now + 35 * 86400000) });
      expect(updated.enrolled).toContain('manual-repo');
      expect(updated.rankings.some(r => r.repo === 'manual-repo')).toBe(true);
      expect(validRank({ ...first, rankings: [] })).toBe(false);
      expect(validRank({ ...first, weights: { prior: -1, recency: 0, leverage: 0 } })).toBe(false);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

test('restock ranks ready evidence across repos and respects an owner pause', () => {
  const source = readFileSync(new URL('../contrib/mac/restock.py', import.meta.url), 'utf8');
  const end = source.indexOf('for i, j, attrs, text, raw in ranked_records(recs)');
  expect(end).toBeGreaterThan(0);
  const helper = source.slice(source.indexOf('def ranked_records('), end);
  const script = `import json, re, math, tempfile, time
from pathlib import Path
import work_market
ordk = lambda r: r[0]
${helper}
records = [(i, str(i), 'repo=phantom' if i < 100 else 'repo=locus, impact=10', '', '') for i in range(200)]
with tempfile.TemporaryDirectory() as H:
    Q = Path(H) / 'queue'
    Q.mkdir()
    ordered = ranked_records(records)
    assert ordered[0][2].startswith('repo=locus')
    assert 54 <= sum(r[2].startswith('repo=locus') for r in ordered[:100]) <= 62
    period = int(time.time()) // (7 * 86400)
    (Q / 'repo-freshness.json').write_text(json.dumps({'schema': 'repo-freshness.v1', 'repos': {
        'ashlrai/phantom': {'site': {'period': period, 'verdict': 'unhealthy'},
                           'docs': {'period': period, 'verdict': 'drift'}}
    }}))
    assert ranked_records(records)[0][2] == 'repo=phantom'
    path = Path(H) / '.ashlr/repo-priority'
    path.mkdir(parents=True)
    (path / 'ashlrai@locus').write_text('pause')
    assert ranked_records(records) == records[:100]
print('ok')`;
  expect(execFileSync('python3', ['-c', script], { cwd: new URL('../contrib/mac/', import.meta.url), encoding: 'utf8' }).trim()).toBe('ok');
});

test('local Git merge evidence recognizes squash PRs without a network', () => {
  const dir = mkdtempSync(join(tmpdir(), 'rank-git-'));
  const git = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  try {
    git('init', '-q', '-b', 'master');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'Improve dispatch (#42)');
    const evidence = localMerges([{ repo: 'phantom', path: dir }]);
    expect(evidence).toHaveLength(1);
    expect(evidence[0].title).toBe('Improve dispatch (#42)');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'ordinary direct commit');
    expect(localMerges([{ repo: 'phantom', path: dir }])).toHaveLength(1);
    git('checkout', '-qb', 'unmerged');
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '-qm', 'Unmerged radar (#99)');
    expect(localMerges([{ repo: 'phantom', path: dir }])).toHaveLength(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('configured weights can promote recent leverage over the seed prior', () => {
  const previous = computeRank([], now);
  previous.weights = { prior: 0, recency: 0.5, leverage: 0.5 };
  const input = [{ repo: 'ashlr-md', mergedAt: now.toISOString(), title: 'radar' }];
  expect(computeRank(input, now, previous).rankings[0].repo).toBe('ashlr-md');
  expect(computeRank(input, now, previous)).toEqual(computeRank(input, now, previous));
});
