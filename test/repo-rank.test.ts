import { describe, test, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { computeRank, SEEDS, updateRank, readRank, validRank, localMerges } from '../src/core/fleet/repo-rank.js';
const now = new Date('2026-11-04T12:00:00Z');
describe('repository ranking', () => {
  test('seed order, normalized shares and top floor', () => {
    const s = computeRank([], now);
    expect(s.rankings.map(r => r.repo)).toEqual(SEEDS);
    expect(s.rankings[0].weight).toBeGreaterThanOrEqual(0.4);
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
    expect(s.rankings[0].recency).toBe(0.5);
    expect(s.rankings[0].leverage).toBe(2);
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

test('restock rank consumer preserves fallback and apportions available work', () => {
  const source = readFileSync(new URL('../contrib/mac/restock.py', import.meta.url), 'utf8');
  const helper = source.slice(source.indexOf('def ranked_records('), source.indexOf('for i, j, attrs, text, raw in ranked_records(recs):'));
  const script = `import json, re, math
from datetime import datetime
H = '/unused'
ordk = lambda r: r[0]
raw = ''
def rd(path): return raw
${helper}
records = [(i, str(i), 'repo=' + ('phantom' if i < 100 else 'locus'), '', '') for i in range(200)]
assert ranked_records(records) == records
raw = '{"schemaVersion":1,"enrolled":["phantom","locus"],"rankings":[{"repo":"phantom","weight":0.7},{"repo":"locus","weight":0.3}]}'
state = json.loads(raw)
state.update(generatedAt='2026-11-04T12:00:00Z', weights={'prior': 0.5, 'recency': 0.25, 'leverage': 0.25}, proposals=[], history=[])
raw = json.dumps(state)
ordered = ranked_records(records)
assert ordered[0][2] == 'repo=phantom'
assert 68 <= sum(r[2] == 'repo=phantom' for r in ordered[:100]) <= 72
raw = '{"schemaVersion":1,"enrolled":["phantom"],"rankings":[{"repo":"phantom","weight":-1}]}'
assert ranked_records(records) == records
print('ok')`;
  expect(execFileSync('python3', ['-c', script], { encoding: 'utf8' }).trim()).toBe('ok');
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
