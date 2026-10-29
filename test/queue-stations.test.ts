import { describe, expect, it, vi } from 'vitest';
import {
  boxStationEvents, parseStationEvent, publicationReceipt, QUEUE_STATIONS, stationCoverage, stationEvent, validateStationLineage,
  type PublicationReceipt,
} from '../src/core/observability/router-queue.js';
import { pollQueueGithub, type QueueGh } from '../src/core/observability/router-queue-github.js';

const NOW = '2026-10-26T12:00:00.000Z';
const LATER = '2026-10-26T12:01:00.000Z';
const HEAD = 'a'.repeat(40);
const MERGE = 'b'.repeat(40);
const OTHER = 'c'.repeat(40);
const JOB = { jobId: 'RQ-QUEUE-2', repo: 'ashlrai/phantom', attempt: 'claim-1' };
const PUBLICATION: PublicationReceipt = { ...JOB, pr: 42, headSha: HEAD, publishedAt: NOW };
const PULL = {
  number: 42, url: 'https://github.com/ashlrai/phantom/pull/42', state: 'OPEN', headRefOid: HEAD,
  baseRefName: 'master', isCrossRepository: false, headRepository: { name: 'phantom' },
  headRepositoryOwner: { login: 'ashlrai' }, mergeCommit: null,
  statusCheckRollup: [{ name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS' }],
};
const RELEASE = { id: 700, tag_name: 'v1.2.3', draft: false, prerelease: false, published_at: NOW };
const RUN = { databaseId: 900, headSha: MERGE, headBranch: 'master', event: 'push', status: 'completed', conclusion: 'failure' };

interface Fixture {
  pull?: Record<string, unknown>;
  queue?: unknown;
  releases?: unknown;
  compare?: unknown;
  runs?: unknown;
  repository?: unknown;
  fail?: 'pr' | 'queue' | 'releases' | 'compare' | 'runs' | 'repository';
}
function github(fixture: Fixture = {}) {
  const calls: string[][] = [];
  const gh: QueueGh = vi.fn(async args => {
    calls.push(args);
    let kind: Fixture['fail']; let value: unknown;
    if (args[0] === 'pr') { kind = 'pr'; value = fixture.pull ?? PULL; }
    else if (args[0] === 'run') { kind = 'runs'; value = fixture.runs ?? [RUN]; }
    else if (args[1] === 'graphql') {
      kind = 'queue';
      value = fixture.queue ?? { data: { repository: { pullRequest: { headRefOid: HEAD, mergeQueueEntry: { id: 'MQE_job42' } } } } };
    } else if (args[1]?.includes('/compare/')) {
      kind = 'compare'; value = fixture.compare ?? { status: 'ahead', merge_base_commit: { sha: MERGE } };
    } else if (args[1]?.includes('/releases?')) { kind = 'releases'; value = fixture.releases ?? [RELEASE]; }
    else if (args[1] === 'repos/ashlrai/phantom') { kind = 'repository'; value = fixture.repository ?? { full_name: 'ashlrai/phantom', default_branch: 'master' }; }
    else throw new Error('Unexpected GitHub command');
    return fixture.fail === kind ? { ok: false, stdout: 'synthetic-private-failure' } : { ok: true, stdout: JSON.stringify(value) };
  });
  return { gh, calls };
}
function snapshot(overrides: Record<string, unknown> = {}) {
  return { schemaVersion: 1, queue: [{ ...JOB, status: 'READY' }], claims: [{ ...JOB, claimedAt: NOW }], publications: [PUBLICATION], ...overrides };
}
const merged = (overrides: Record<string, unknown> = {}) => ({ ...PULL, state: 'MERGED', mergeCommit: { oid: MERGE }, ...overrides });

describe('router queue station acceptance', () => {
  it('observes every station for one end-to-end job with exact GitHub evidence', async () => {
    const local = boxStationEvents(snapshot(), NOW);
    const openGithub = github();
    const open = await pollQueueGithub(PUBLICATION, openGithub.gh, NOW);
    const mergedGithub = github({ pull: merged() });
    const landed = await pollQueueGithub(PUBLICATION, mergedGithub.gh, LATER);
    const all = [...local, ...open.events, ...landed.events];
    expect(open.unavailable).toEqual([]);
    expect(landed.unavailable).toEqual([]);
    expect(stationCoverage(all, JOB)).toEqual({ seen: [...QUEUE_STATIONS], missing: [], complete: true });
    expect(new Set(all.map(event => event.eventId)).size).toBe(9);
    expect(openGithub.calls[0]).toEqual(['pr', 'view', '42', '--repo', 'ashlrai/phantom', '--json',
      'number,url,state,headRefOid,baseRefName,isCrossRepository,headRepository,headRepositoryOwner,mergeCommit,statusCheckRollup']);
    expect(openGithub.calls[1]).toContain('number=42');
    expect(openGithub.calls[1]?.join(' ')).toContain('mergeQueueEntry{id}');
    expect(mergedGithub.calls).toContainEqual(['api', `repos/ashlrai/phantom/compare/${MERGE}...v1.2.3`]);
    expect(mergedGithub.calls).toContainEqual(['run', 'list', '--repo', 'ashlrai/phantom', '--branch', 'master',
      '--commit', MERGE, '--event', 'push', '--limit', '100', '--json', 'databaseId,headSha,headBranch,event,status,conclusion']);
    for (const event of all) expect(parseStationEvent(event)).toEqual(event);
  });

  it('replays unchanged snapshots without new identities, while retaining a CI transition', async () => {
    const first = boxStationEvents(snapshot(), NOW);
    const replay = boxStationEvents(snapshot(), LATER);
    expect(replay.map(event => event.eventId)).toEqual(first.map(event => event.eventId));
    const pending = await pollQueueGithub(PUBLICATION, github({ pull: { ...PULL, statusCheckRollup: [{ status: 'IN_PROGRESS', conclusion: '' }] } }).gh, NOW);
    const success = await pollQueueGithub(PUBLICATION, github().gh, LATER);
    expect(pending.events.find(event => event.station === 'pr-ci')?.evidence['ci']).toBe('pending');
    expect(success.events.find(event => event.station === 'pr-ci')?.evidence['ci']).toBe('success');
    expect(pending.events[0]?.eventId).not.toBe(success.events[0]?.eventId);
  });

  it('keeps attempts independent and reports missing stations without inventing them', () => {
    const events = boxStationEvents(snapshot(), NOW);
    expect(stationCoverage(events, { ...JOB, attempt: 'claim-2' })).toEqual({ seen: [], missing: [...QUEUE_STATIONS], complete: false });
    const later = boxStationEvents(snapshot({ queue: [{ ...JOB, status: 'done' }], claims: [], publications: [] }), NOW);
    expect(later.map(event => event.station)).toEqual(['planned']);
    expect(stationCoverage(later, JOB).missing).toContain('READY');
    expect(boxStationEvents(snapshot({ queue: [], claims: [], publications: [PUBLICATION] }), NOW).map(event => event.station)).toEqual(['publish']);
  });

  it('drops descriptions, titles, command output and synthetic private content', async () => {
    const privateMarker = 'synthetic-private-marker';
    const local = boxStationEvents(snapshot({ queue: [{ ...JOB, status: 'READY', description: privateMarker }],
      publications: [{ ...PUBLICATION, output: privateMarker }] }), NOW);
    const remote = await pollQueueGithub(PUBLICATION, github({ pull: { ...PULL, title: privateMarker, body: privateMarker } }).gh, NOW);
    expect(JSON.stringify([...local, ...remote.events])).not.toContain(privateMarker);
  });
});

describe('queue snapshot validation', () => {
  it.each([
    { schemaVersion: 2 }, { queue: undefined }, { claims: null }, { publications: {} },
    { queue: [{ ...JOB, status: 'ready' }] }, { queue: [{ ...JOB, status: 'READY' }, { ...JOB, status: 'planned' }] },
    { queue: [{ ...JOB, repo: '../../private', status: 'READY' }] },
    { claims: [{ ...JOB, claimedAt: '2026-99-26T12:00:00.000Z' }] },
    { publications: [{ ...PUBLICATION, pr: 0 }] }, { publications: [{ ...PUBLICATION, headSha: 'short' }] },
    { publications: [{ ...PUBLICATION, publishedAt: 'yesterday' }] },
  ])('rejects malformed or partial snapshots atomically: %j', override => {
    expect(() => boxStationEvents(snapshot(override), NOW)).toThrow();
  });

  it('rejects oversized input lists and unsafe identities', () => {
    expect(() => boxStationEvents(snapshot({ queue: Array.from({ length: 10_001 }, () => ({ ...JOB, status: 'READY' })) }), NOW)).toThrow();
    expect(() => publicationReceipt({ ...PUBLICATION, attempt: 'unsafe\nidentifier' })).toThrow();
    expect(() => publicationReceipt({ ...PUBLICATION, repo: 'ashlrai/..' })).toThrow();
  });

  it('normalizes repository case and generates canonical evidence identities', () => {
    expect(publicationReceipt({ ...PUBLICATION, repo: 'AshlrAI/Phantom' }).repo).toBe('ashlrai/phantom');
    const one = stationEvent(JOB, 'publish', NOW, 'publish.sh', { pr: 42, headSha: HEAD, publishedAt: NOW });
    const two = stationEvent(JOB, 'publish', LATER, 'publish.sh', { publishedAt: NOW, headSha: HEAD, pr: 42 });
    expect(one.eventId).toBe(two.eventId);
  });

  it('rejects tampered persisted event identity, source and extra payload', () => {
    const event = boxStationEvents(snapshot(), NOW)[0]!;
    expect(() => parseStationEvent({ ...event, eventId: '0'.repeat(64) })).toThrow();
    expect(() => parseStationEvent({ ...event, source: 'github' })).toThrow();
    expect(() => parseStationEvent({ ...event, privatePayload: 'not allowed' })).toThrow();
    expect(() => parseStationEvent({ ...event, evidence: { privatePayload: 'not allowed' } })).toThrow();
  });

  it.each([
    { pr: 43, headSha: HEAD }, { pr: 42, headSha: OTHER },
  ])('refuses a conflicting delivery pin within one attempt: %j', pin => {
    const published = boxStationEvents(snapshot(), NOW).find(event => event.station === 'publish')!;
    const rewritten = stationEvent(JOB, 'pr-ci', LATER, 'github', { ...pin, ci: 'success' });
    expect(() => validateStationLineage([published, rewritten])).toThrow('Conflicting job attempt delivery identity');
    const retry = stationEvent({ ...JOB, attempt: 'claim-2' }, 'pr-ci', LATER, 'github', { ...pin, ci: 'success' });
    expect(() => validateStationLineage([published, retry])).not.toThrow();
  });

  it('refuses conflicting merge commits within one attempt', () => {
    const one = stationEvent(JOB, 'merged', NOW, 'github', { pr: 42, headSha: HEAD, mergeSha: MERGE });
    const two = stationEvent(JOB, 'released', LATER, 'github', { pr: 42, mergeSha: OTHER, releaseId: 700, tag: 'v1.2.3' });
    expect(() => validateStationLineage([one, two])).toThrow('Conflicting job attempt delivery identity');
  });
});

describe('GitHub station evidence boundaries', () => {
  it.each([
    { number: 43 }, { url: 'https://github.com/foreign/phantom/pull/42' }, { headRefOid: OTHER },
    { isCrossRepository: true }, { headRepositoryOwner: { login: 'foreign' } }, { state: 'UNKNOWN' },
  ])('refuses foreign or stale PR evidence: %j', async override => {
    const fixture = github({ pull: { ...PULL, ...override } });
    expect(await pollQueueGithub(PUBLICATION, fixture.gh, NOW)).toEqual({ events: [], unavailable: ['pr-identity-mismatch'] });
    expect(fixture.calls).toHaveLength(1);
  });

  it.each([[], null, [{}], [{ status: 'COMPLETED', conclusion: 'UNKNOWN' }]].map(statusCheckRollup => ({ statusCheckRollup })))('keeps absent or unknown checks unknown: %j', async ({ statusCheckRollup }) => {
    const result = await pollQueueGithub(PUBLICATION, github({ pull: { ...PULL, statusCheckRollup } }).gh, NOW);
    expect(result.events.map(event => event.station)).toEqual(['merge-queue']);
    expect(result.unavailable).toEqual(['pr-ci-unavailable']);
  });

  it('records failed checks and legacy commit statuses without retaining check names', async () => {
    const result = await pollQueueGithub(PUBLICATION, github({ pull: { ...PULL, statusCheckRollup: [
      { context: 'synthetic-private-check', state: 'SUCCESS' }, { status: 'COMPLETED', conclusion: 'FAILURE' },
    ] } }).gh, NOW);
    expect(result.events[0]?.evidence['ci']).toBe('failure');
    expect(JSON.stringify(result)).not.toContain('synthetic-private-check');
  });

  it('does not mistake auto-merge intent for a merge-queue entry', async () => {
    const queue = { data: { repository: { pullRequest: { headRefOid: HEAD, mergeQueueEntry: null, autoMergeRequest: { enabledAt: NOW } } } } };
    const result = await pollQueueGithub(PUBLICATION, github({ queue }).gh, NOW);
    expect(result.events.map(event => event.station)).toEqual(['pr-ci']);
    expect(result.unavailable).toEqual([]);
  });

  it('accepts base64 queue entry IDs and release tags with build metadata', async () => {
    const queue = { data: { repository: { pullRequest: { headRefOid: HEAD, mergeQueueEntry: { id: 'MQE_job42+=' } } } } };
    const open = await pollQueueGithub(PUBLICATION, github({ queue }).gh, NOW);
    expect(open.events.find(event => event.station === 'merge-queue')?.evidence['entryId']).toBe('MQE_job42+=');
    const fixture = github({ pull: merged(), releases: [{ ...RELEASE, tag_name: 'v1.2.3+build.4' }] });
    const landed = await pollQueueGithub(PUBLICATION, fixture.gh, NOW);
    expect(landed.events.find(event => event.station === 'released')?.evidence['tag']).toBe('v1.2.3+build.4');
    expect(landed.unavailable).toEqual([]);
    expect(fixture.calls).toContainEqual(['api', `repos/ashlrai/phantom/compare/${MERGE}...v1.2.3%2Bbuild.4`]);
  });

  it.each([
    { data: { repository: { pullRequest: { headRefOid: OTHER, mergeQueueEntry: { id: 'MQE_other' } } } } },
    { data: { repository: { pullRequest: { headRefOid: HEAD } } } },
    { errors: [{ message: 'synthetic-private-error' }], data: { repository: { pullRequest: { headRefOid: HEAD, mergeQueueEntry: { id: 'MQE_partial' } } } } },
  ])('preserves independently verified CI when queue evidence is incomplete: %j', async queue => {
    const result = await pollQueueGithub(PUBLICATION, github({ queue }).gh, NOW);
    expect(result.events.map(event => event.station)).toEqual(['pr-ci']);
    expect(result.unavailable).toEqual(['merge-queue-unavailable']);
    expect(JSON.stringify(result)).not.toContain('synthetic-private-error');
  });

  it.each(['pr', 'queue'] as const)('reports failed %s polling without exposing output', async fail => {
    const result = await pollQueueGithub(PUBLICATION, github({ fail }).gh, NOW);
    expect(result.unavailable).toContain(fail === 'pr' ? 'pr-unavailable' : 'merge-queue-unavailable');
    expect(JSON.stringify(result)).not.toContain('synthetic-private-failure');
  });

  it('treats thrown, malformed and oversized responses as unavailable', async () => {
    for (const gh of [async () => { throw new Error('synthetic-private-error'); },
      async () => ({ ok: true, stdout: '{' }), async () => ({ ok: true, stdout: ' '.repeat(2 * 1024 * 1024 + 1) })]) {
      expect(await pollQueueGithub(PUBLICATION, gh, NOW)).toEqual({ events: [], unavailable: ['pr-unavailable'] });
    }
  });

  it('does not infer merged/released/main-failure stations for a closed unmerged PR', async () => {
    const fixture = github({ pull: { ...PULL, state: 'CLOSED' } });
    const result = await pollQueueGithub(PUBLICATION, fixture.gh, NOW);
    expect(result.events.map(event => event.station)).toEqual(['pr-ci']);
    expect(fixture.calls).toHaveLength(1);
  });

  it('keeps a merged PR with a missing merge SHA unknown', async () => {
    const result = await pollQueueGithub(PUBLICATION, github({ pull: merged({ mergeCommit: null }) }).gh, NOW);
    expect(result.events.map(event => event.station)).toEqual(['pr-ci']);
    expect(result.unavailable).toEqual(['merge-commit-unavailable']);
  });

  it.each([
    { status: 'behind', merge_base_commit: { sha: MERGE } },
    { status: 'diverged', merge_base_commit: { sha: OTHER } },
    { status: 'ahead', merge_base_commit: { sha: OTHER } },
  ])('requires release ancestry to contain the exact merge: %j', async compare => {
    const result = await pollQueueGithub(PUBLICATION, github({ pull: merged(), compare }).gh, NOW);
    expect(result.events.map(event => event.station)).toEqual(['pr-ci', 'merged', 'fix-main']);
  });

  it('ignores drafts, prereleases and unpublished releases without querying ancestry', async () => {
    const fixture = github({ pull: merged(), releases: [{ ...RELEASE, draft: true }, { ...RELEASE, prerelease: true }, { ...RELEASE, published_at: null }] });
    const result = await pollQueueGithub(PUBLICATION, fixture.gh, NOW);
    expect(result.events.some(event => event.station === 'released')).toBe(false);
    expect(fixture.calls.some(args => args[1]?.includes('/compare/'))).toBe(false);
  });

  it('accepts GitHub release timestamps with second precision', async () => {
    const result = await pollQueueGithub(PUBLICATION, github({ pull: merged(), releases: [{ ...RELEASE, published_at: '2026-10-26T12:00:00Z' }] }).gh, NOW);
    expect(result.events.some(event => event.station === 'released')).toBe(true);
    expect(result.unavailable).toEqual([]);
  });

  it.each([
    {}, { ...RELEASE, draft: 'false' }, { ...RELEASE, published_at: 'invalid-date' },
  ])('keeps malformed release rows unknown while preserving main-CI evidence: %j', release => {
    return pollQueueGithub(PUBLICATION, github({ pull: merged(), releases: [release] }).gh, NOW).then(result => {
      expect(result.events.some(event => event.station === 'released')).toBe(false);
      expect(result.events.some(event => event.station === 'fix-main')).toBe(true);
      expect(result.unavailable).toContain('release-unavailable');
    });
  });

  it.each(['releases', 'compare', 'runs'] as const)('retains independent evidence after failed %s polling', async fail => {
    const result = await pollQueueGithub(PUBLICATION, github({ pull: merged(), fail }).gh, NOW);
    expect(result.events.map(event => event.station)).toContain('merged');
    expect(result.events.map(event => event.station)).toContain(fail === 'runs' ? 'released' : 'fix-main');
    expect(result.unavailable).toContain(fail === 'runs' ? 'main-ci-unavailable' : 'release-unavailable');
  });

  it('bounds release ancestry requests and makes truncated searches explicit', async () => {
    const fixture = github({ pull: merged(), releases: Array.from({ length: 20 }, (_, i) => ({ ...RELEASE, id: i + 1, tag_name: `v1.0.${i}` })),
      compare: { status: 'behind', merge_base_commit: { sha: OTHER } } });
    const result = await pollQueueGithub(PUBLICATION, fixture.gh, NOW);
    expect(fixture.calls.filter(args => args[1]?.includes('/compare/'))).toHaveLength(5);
    expect(result.unavailable).toContain('release-search-bounded');
    expect(result.events.some(event => event.station === 'released')).toBe(false);
  });

  it.each([
    { headSha: OTHER }, { headBranch: 'feature' }, { event: 'pull_request' }, { status: 'in_progress' },
    { conclusion: 'success' }, { conclusion: 'cancelled' },
  ])('does not attribute unrelated or unfinished main CI to the job: %j', async override => {
    const result = await pollQueueGithub(PUBLICATION, github({ pull: merged(), runs: [{ ...RUN, ...override }] }).gh, NOW);
    expect(result.events.some(event => event.station === 'fix-main')).toBe(false);
  });

  it('never labels failures on a non-default PR base as fix-main', async () => {
    const fixture = github({ pull: merged({ baseRefName: 'release/1.x' }) });
    const result = await pollQueueGithub(PUBLICATION, fixture.gh, NOW);
    expect(result.events.some(event => event.station === 'fix-main')).toBe(false);
    expect(fixture.calls.some(args => args[0] === 'run')).toBe(false);
    expect(result.unavailable).toEqual([]);
  });

  it.each([
    { full_name: 'foreign/phantom', default_branch: 'master' },
    { full_name: 'ashlrai/phantom' },
  ])('keeps repository metadata failures unknown: %j', async repository => {
    const fixture = github({ pull: merged(), repository });
    const result = await pollQueueGithub(PUBLICATION, fixture.gh, NOW);
    expect(result.events.some(event => event.station === 'fix-main')).toBe(false);
    expect(result.unavailable).toContain('main-ci-unavailable');
    expect(fixture.calls.some(args => args[0] === 'run')).toBe(false);
  });

  it('retains release evidence when repository metadata polling fails', async () => {
    const fixture = github({ pull: merged(), fail: 'repository' });
    const result = await pollQueueGithub(PUBLICATION, fixture.gh, NOW);
    expect(result.events.map(event => event.station)).toContain('released');
    expect(result.unavailable).toContain('main-ci-unavailable');
    expect(fixture.calls.some(args => args[0] === 'run')).toBe(false);
  });

  it.each([
    {}, { ...RUN, headSha: 'short' }, { ...RUN, databaseId: 0 }, { ...RUN, conclusion: 'unknown' },
  ])('keeps malformed main-CI rows unknown: %j', run => {
    return pollQueueGithub(PUBLICATION, github({ pull: merged(), runs: [run] }).gh, NOW).then(result => {
      expect(result.events.some(event => event.station === 'fix-main')).toBe(false);
      expect(result.events.some(event => event.station === 'released')).toBe(true);
      expect(result.unavailable).toContain('main-ci-unavailable');
    });
  });

  it('reports a full main-CI page as bounded rather than complete negative evidence', async () => {
    const result = await pollQueueGithub(PUBLICATION, github({ pull: merged(), runs: Array.from({ length: 100 }, () => ({ ...RUN, conclusion: 'success' })) }).gh, NOW);
    expect(result.unavailable).toContain('main-ci-search-bounded');
    expect(result.events.some(event => event.station === 'fix-main')).toBe(false);
  });
});
