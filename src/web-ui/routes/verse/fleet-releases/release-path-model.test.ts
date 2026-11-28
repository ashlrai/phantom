import { expect, it } from 'vitest';
import type { OpsRepoReleaseV1 } from '../../../../core/verse/ops-types.js';
import type { ReleasePr } from '../fleet/release-pr-query.js';
import { releasePath, waitingHeadline } from './release-path-model.js';

const NOW = Date.parse('2026-10-31T12:00:00Z');
const repo = (over: Partial<OpsRepoReleaseV1> = {}): OpsRepoReleaseV1 => ({
  repo: 'ashlrai/phantom', path: '/fixture', version: '3.30.0', latestTag: 'v3.30.0', releaseWorkflow: 'release.yml',
  commitsSinceTag: 12, notes: [],
  gh: { latestRelease: { tag: 'v3.30.0', name: null, publishedAt: '2026-10-31T10:00:00Z', draft: false, prerelease: false },
    latestRun: { workflow: 'Release', status: 'completed', conclusion: 'success', at: '2026-10-31T10:00:00Z' } },
  ...over,
});
const pr = (over: Partial<ReleasePr> = {}): ReleasePr => ({
  number: 7, title: 'release 3.31.0', url: 'https://github.com/ashlrai/phantom/pull/7', version: '3.31.0',
  openedAt: '2026-10-31T11:00:00Z', updatedAt: '2026-10-31T11:30:00Z', mergeable: 'MERGEABLE',
  checks: [], failing: [], pending: 0, blocked: false, summary: '3.31.0 ready', ...over,
});
const cell = (stations: ReturnType<typeof releasePath>, id: string) => {
  const { value, detail, tone } = stations.find(station => station.id === id)!;
  return { value, detail, tone };
};

it('draws the four stations in pipeline order from recorded facts', () => {
  const stations = releasePath(repo(), { pr: pr(), blockMerge: false }, NOW);
  expect(stations.map(station => station.label)).toEqual(['Unreleased', 'Release PR', 'Release run', 'Published']);
  expect(cell(stations, 'unreleased')).toEqual({ value: '12 commits', detail: 'since v3.30.0', tone: 'active' });
  expect(cell(stations, 'pr')).toEqual({ value: '#7 checks green', detail: 'open since 1h ago', tone: 'ok' });
  expect(cell(stations, 'run')).toEqual({ value: 'success', detail: 'Release · 2h ago', tone: 'ok' });
  expect(cell(stations, 'published')).toEqual({ value: 'v3.30.0', detail: '2h ago', tone: 'ok' });
});

it('keeps a missing reading unknown and a recorded nothing idle', () => {
  const unread = releasePath(repo({ commitsSinceTag: null, gh: null }), undefined, NOW);
  expect(unread.map(station => [station.value, station.tone])).toEqual(Array(4).fill(['unknown', 'unknown']));
  const quiet = releasePath(repo({ commitsSinceTag: 0, gh: { latestRelease: null, latestRun: null } }), { pr: null, blockMerge: false }, NOW);
  expect(quiet.map(station => [station.value, station.tone])).toEqual([
    ['0 commits', 'idle'], ['none open', 'idle'], ['none recorded', 'idle'], ['none', 'idle']]);
  expect(cell(releasePath(repo({ commitsSinceTag: 1, latestTag: null }), undefined, NOW), 'unreleased'))
    .toEqual({ value: '1 commit', detail: 'since unknown tag', tone: 'active' });
});

it.each([
  [pr({ pending: 2 }), false, '#7 checks running', 'warn'],
  [pr({ blocked: true }), false, '#7 blocked', 'danger'],
  [pr({ failing: ['Lint'] }), false, '#7 blocked', 'danger'],
  [pr({ mergeable: 'CONFLICTING' }), false, '#7 merge conflicts', 'danger'],
  [pr(), true, '#7 version downgrade', 'danger'],
] as const)('names why the release PR cannot merge', (value, blockMerge, text, tone) => {
  expect(cell(releasePath(repo(), { pr: value, blockMerge }, NOW), 'pr')).toMatchObject({ value: text, tone });
});

it('tones the run and a draft or prerelease by what was recorded', () => {
  const run = (status: string, conclusion: string | null) => cell(releasePath(repo({
    gh: { latestRelease: null, latestRun: { workflow: 'Release', status, conclusion, at: null } } }), undefined, NOW), 'run');
  expect(run('in_progress', null)).toEqual({ value: 'in progress', detail: 'Release · time unknown', tone: 'active' });
  expect(run('completed', 'timed_out')).toMatchObject({ value: 'timed out', tone: 'danger' });
  expect(run('completed', 'skipped')).toMatchObject({ value: 'skipped', tone: 'warn' });
  const draft = repo({ gh: { latestRun: null, latestRelease: { tag: 'v4.0.0', name: 'Four', publishedAt: null, draft: true, prerelease: false } } });
  expect(cell(releasePath(draft, undefined, NOW), 'published')).toEqual({ value: 'v4.0.0 draft', detail: 'Four · time unknown', tone: 'warn' });
});

it('sums what is waiting and never folds an unknown count into zero', () => {
  expect(waitingHeadline([])).toBe('No repos reported.');
  expect(waitingHeadline([repo({ commitsSinceTag: null }), repo({ commitsSinceTag: undefined })])).toBe('Unreleased commits are unknown for every repo.');
  expect(waitingHeadline([repo({ commitsSinceTag: 0 }), repo({ commitsSinceTag: 0 })])).toBe('Nothing is waiting for a release.');
  expect(waitingHeadline([repo({ commitsSinceTag: 0 }), repo({ commitsSinceTag: null })])).toBe('Nothing is waiting for a release, 1 unknown.');
  expect(waitingHeadline([repo(), repo({ commitsSinceTag: 1 }), repo({ commitsSinceTag: 0 }), repo({ commitsSinceTag: null })]))
    .toBe('13 commits waiting for a release in 2 of 4 repos, 1 unknown.');
});
