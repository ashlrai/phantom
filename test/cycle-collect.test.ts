/** Synthetic GitHub-shaped cases; these are not recorded production fixtures. */
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error -- plain ESM script without type declarations
import { REPOS, collect, collectRepo, githubClient, insertId, pages, parseArgs, stagesForPr } from '../scripts/cycle/collect.mjs';
// @ts-expect-error -- plain ESM script without type declarations
import { capture, validateEvent } from '../scripts/cycle/capture.mjs';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const at = (minute: number) => new Date(Date.UTC(2026, 9, 26, 0, minute)).toISOString();
const owner = { login: 'masonwyatt23' };
const comment = (body: string, login = 'masonwyatt23', minute = 3) => ({ __typename: 'IssueComment', createdAt: at(minute), body, author: { login }, authorAssociation: login === owner.login ? 'OWNER' : 'NONE' });
const timelineEvent = (name: string, minute: number) => ({ __typename: name, createdAt: at(minute) });
function pr(overrides: Record<string, any> = {}) {
  return {
    number: 42, createdAt: at(0), mergedAt: at(10), updatedAt: at(11), headRefOid: 'a'.repeat(40),
    timelineItems: { nodes: [comment('LGTM'), timelineEvent('AddedToMergeQueueEvent', 6)] },
    checkSuites: { nodes: [{ id: 'suite1', createdAt: at(1), app: { slug: 'github-actions' }, checkRuns: { nodes: [
      { name: 'required', isRequired: true, startedAt: at(1), completedAt: at(5), status: 'COMPLETED', conclusion: 'SUCCESS' },
    ] } }] },
    ...overrides,
  };
}
function stageMap(repo: string, value: any) {
  return Object.fromEntries(stagesForPr(repo, value).map((event: any) => [event.properties.stage, event.properties]));
}
function diskOptions(value = pr()) {
  const dir = mkdtempSync(join(tmpdir(), 'cycle-collect-'));
  dirs.push(dir);
  const fixture = join(dir, 'fixture.json');
  writeFileSync(fixture, JSON.stringify({ repositories: { phantom: [value] } }));
  return parseArgs(['--repo', 'phantom', '--cursor', join(dir, 'cursor.json'), '--spool', join(dir, 'spool.jsonl'), '--fixture', fixture]);
}
function spoolEvents(options: any): any[] {
  return readFileSync(options.spool, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}
const connection = (values: any[], next: string | null = null) => ({ nodes: values, pageInfo: { hasNextPage: next !== null, endCursor: next } });

describe('cycle stage extraction', () => {
  it('measures final-head rework, CI, review, enqueue and merge in seconds', () => {
    const stages = stageMap('phantom', pr());
    expect(Object.fromEntries(Object.entries(stages).map(([stage, value]: any) => [stage, value.duration_s])))
      .toEqual({ rework: 60, ci_pr: 240, review: 180, green_to_enqueue: 60, merge_group: 240 });
    expect(stages.ci_pr).toMatchObject({ schema: 'cycle_stage.v1', job_id: 'pr-phantom-42', pool: 'none', repo: 'phantom', pr: 42, source: 'backfill', attempt: 1, ts_start: at(1), ts_end: at(5) });
  });
  it('uses one green_to_merged stage for repos without queues', () => {
    expect(REPOS).toEqual(['phantom', 'phantom-secrets', 'locus', 'lexicon', 'ashlr-md', 'ashlr-stack', 'ashlr-plugin']);
    for (const repo of REPOS.filter((name: string) => !['phantom', 'ashlr-md'].includes(name))) {
      const stages = stageMap(repo, pr());
      expect(stages.green_to_merged.duration_s).toBe(300);
      expect(stages).not.toHaveProperty('green_to_enqueue');
      expect(stages).not.toHaveProperty('merge_group');
    }
    expect(stageMap('ashlr-md', pr())).toHaveProperty('merge_group');
  });
  it('omits unknown review and downstream green boundaries', () => {
    const stages = stageMap('phantom', pr({ timelineItems: { nodes: [timelineEvent('AddedToMergeQueueEvent', 6)] } }));
    expect(Object.keys(stages)).toEqual(['rework', 'ci_pr', 'merge_group']);
    expect(stageMap('locus', pr({ timelineItems: { nodes: [] } }))).not.toHaveProperty('green_to_merged');
  });
  it('omits CI samples if a required run is still incomplete', () => {
    const value = pr();
    value.checkSuites.nodes[0].checkRuns.nodes[0].status = 'IN_PROGRESS';
    const stages = stageMap('phantom', value);
    expect(stages).toHaveProperty('rework');
    expect(stages).not.toHaveProperty('ci_pr');
    expect(stages).not.toHaveProperty('green_to_enqueue');
  });
  it('uses required runs rather than late optional checks', () => {
    const value = pr();
    value.checkSuites.nodes[0].checkRuns.nodes.push({ name: 'optional', isRequired: false, startedAt: at(1), completedAt: at(9), status: 'COMPLETED', conclusion: 'SUCCESS' });
    expect(stageMap('phantom', value).ci_pr.duration_s).toBe(240);
    for (const run of value.checkSuites.nodes[0].checkRuns.nodes) run.isRequired = false;
    expect(stageMap('phantom', value).ci_pr.duration_s).toBe(480);
  });
  it('replaces a stale required attempt with its latest successful run', () => {
    const value: any = pr({ timelineItems: { nodes: [comment('LGTM'), timelineEvent('AddedToMergeQueueEvent', 8)] } });
    const original = value.checkSuites.nodes[0];
    original.workflowRun = { workflow: { id: 'workflow-ci' } };
    original.checkRuns.nodes[0].status = 'IN_PROGRESS';
    value.checkSuites.nodes.push({
      ...original, id: 'suite-rerun', createdAt: at(2),
      checkRuns: { nodes: [{ ...original.checkRuns.nodes[0], startedAt: at(2), completedAt: at(7), status: 'COMPLETED', conclusion: 'SUCCESS' }] },
    });
    const stages = stageMap('phantom', value);
    expect(stages.ci_pr).toMatchObject({ ts_start: at(1), ts_end: at(7), duration_s: 360 });
    expect(stages.green_to_enqueue.duration_s).toBe(60);
  });
  it('does not collapse identically named required checks from different workflows', () => {
    const value: any = pr();
    const original = value.checkSuites.nodes[0];
    original.workflowRun = { workflow: { id: 'workflow-one' } };
    value.checkSuites.nodes.push({
      ...original, id: 'second-workflow', createdAt: at(2), workflowRun: { workflow: { id: 'workflow-two' } },
      checkRuns: { nodes: [{ ...original.checkRuns.nodes[0], startedAt: at(2), completedAt: at(4), status: 'COMPLETED', conclusion: 'SUCCESS' }] },
    });
    expect(stageMap('phantom', value).ci_pr.ts_end).toBe(at(5));
  });
  it('records completed failed required CI duration without asserting green', () => {
    const value = pr();
    value.checkSuites.nodes[0].checkRuns.nodes[0].conclusion = 'FAILURE';
    const stages = stageMap('phantom', value);
    expect(stages.ci_pr.duration_s).toBe(240);
    expect(stages).not.toHaveProperty('green_to_enqueue');
    expect(stageMap('locus', value)).not.toHaveProperty('green_to_merged');
  });
  it('ignores non-Actions suites and CI created after merge', () => {
    const value = pr();
    value.checkSuites.nodes.push({ ...value.checkSuites.nodes[0], id: 'other', app: { slug: 'external-app' }, createdAt: at(0) });
    value.checkSuites.nodes.push({ ...value.checkSuites.nodes[0], id: 'postmerge', createdAt: at(11) });
    expect(stageMap('phantom', value).rework.duration_s).toBe(60);
    expect(stageMap('phantom', value).ci_pr.duration_s).toBe(240);
  });
  it('starts review at ready_for_review and accepts the first owner formal review', () => {
    const value = pr({ timelineItems: { nodes: [
      comment('LGTM', owner.login, 1), timelineEvent('ReadyForReviewEvent', 2),
      { __typename: 'PullRequestReview', submittedAt: at(4), state: 'COMMENTED', author: owner, authorAssociation: 'OWNER' },
      comment('LGTM', owner.login, 5),
    ] } });
    expect(stageMap('phantom', value).review).toMatchObject({ ts_start: at(2), ts_end: at(4), duration_s: 120 });
  });
  it.each(['LGTM', 'Approved', 'Looks good', 'ship it'])('recognizes owner review comment %s', body => {
    expect(stageMap('phantom', pr({ timelineItems: { nodes: [comment(body)] } })).review.duration_s).toBe(180);
  });
  it.each(['No actionable comments', 'Review passed', 'No issues found'])('recognizes CodeRabbit pass %s', body => {
    expect(stageMap('phantom', pr({ timelineItems: { nodes: [comment(body, 'coderabbitai[bot]')] } })).review.duration_s).toBe(180);
  });
  it('rejects ordinary comments and CodeRabbit review-in-progress notices', () => {
    for (const item of [comment('please inspect this'), comment('LGTM', 'untrusted-user'), comment('Review in progress', 'coderabbitai[bot]')]) {
      expect(stageMap('phantom', pr({ timelineItems: { nodes: [item] } }))).not.toHaveProperty('review');
    }
  });
  it.each([
    ['not approved', 'masonwyatt23'], ['LGTM but changes requested', 'masonwyatt23'],
    ['please approve this', 'masonwyatt23'], ['Review complete: 3 actionable issues', 'coderabbitai[bot]'],
    ['No issues found but pending manual review', 'coderabbitai[bot]'],
  ])('rejects negative or non-final review wording: %s', (body, login) => {
    expect(stageMap('phantom', pr({ timelineItems: { nodes: [comment(body, login)] } }))).not.toHaveProperty('review');
  });
  it('starts review at the latest re-ready boundary', () => {
    const value = pr({ timelineItems: { nodes: [
      timelineEvent('ReadyForReviewEvent', 1), comment('LGTM', owner.login, 2),
      timelineEvent('ConvertToDraftEvent', 3), timelineEvent('ReadyForReviewEvent', 4), comment('LGTM', owner.login, 5),
    ] } });
    expect(stageMap('phantom', value).review).toMatchObject({ ts_start: at(4), ts_end: at(5), duration_s: 60 });
  });
  it('recognizes a CodeRabbit status line despite unrelated footer instructions', () => {
    const body = '**Actionable comments posted: 0**\n\nWalkthrough: do not edit generated files, but check the docs.';
    expect(stageMap('phantom', pr({ timelineItems: { nodes: [comment(body, 'coderabbitai[bot]')] } })).review.duration_s).toBe(180);
  });
  it('uses the updated timestamp of edited review comments', () => {
    const review = { ...comment('No actionable comments', 'coderabbitai[bot]', 1), updatedAt: at(4) };
    expect(stageMap('phantom', pr({ timelineItems: { nodes: [review] } })).review).toMatchObject({ ts_end: at(4), duration_s: 240 });
    review.updatedAt = at(11);
    expect(stageMap('phantom', pr({ timelineItems: { nodes: [review] } }))).not.toHaveProperty('review');
  });
  it('uses the final surviving merge queue entry after removal and reentry', () => {
    const value = pr({ timelineItems: { nodes: [comment('LGTM'), timelineEvent('AddedToMergeQueueEvent', 4), timelineEvent('RemovedFromMergeQueueEvent', 5), timelineEvent('AddedToMergeQueueEvent', 7)] } });
    expect(stageMap('phantom', value).merge_group.duration_s).toBe(180);
    expect(stageMap('phantom', value).green_to_enqueue.duration_s).toBe(120);
  });
  it('does not invent queue-entry evidence from auto-merge alone', () => {
    const value = pr({ timelineItems: { nodes: [comment('LGTM'), timelineEvent('AutoMergeEnabledEvent', 7)] } });
    const stages = stageMap('phantom', value);
    expect(stages.green_to_enqueue.duration_s).toBe(120);
    expect(stages).not.toHaveProperty('merge_group');
  });
  it('does not emit an inverted green-to-enqueue interval', () => {
    const stages = stageMap('phantom', pr({ timelineItems: { nodes: [comment('LGTM'), timelineEvent('AddedToMergeQueueEvent', 2)] } }));
    expect(stages).not.toHaveProperty('green_to_enqueue');
    expect(stages.merge_group.duration_s).toBe(480);
  });
  it('creates deterministic schema hashes and never copies free text', () => {
    const value = pr({ title: 'private title', body: 'private body', path: '/private/path' });
    const first = stagesForPr('phantom', value);
    expect(first).toEqual(stagesForPr('phantom', value));
    const props = first[0].properties;
    expect(props.$insert_id).toBe(createHash('sha256').update(`phantom|42|pr-phantom-42|${'a'.repeat(40)}|rework|1`).digest('hex').slice(0, 32));
    expect(insertId({ ...props, attempt: 2 })).not.toBe(props.$insert_id);
    expect(JSON.stringify(first)).not.toMatch(/private title|private body|private\/path|LGTM/);
  });
  it('rejects invalid identities and timestamps', () => {
    expect(() => stagesForPr('other', pr())).toThrow('Invalid PR identity');
    expect(() => stagesForPr('phantom', pr({ number: 0 }))).toThrow('Invalid PR identity');
    expect(() => stagesForPr('phantom', pr({ headRefOid: 'short' }))).toThrow('Invalid PR identity');
    expect(() => stagesForPr('phantom', pr({ mergedAt: 'invalid' }))).toThrow('Invalid PR timestamps');
  });
});

describe('GitHub collection', () => {
  it('paginates connections without silently truncating', () => {
    const fetchPage = vi.fn((after: string | null) => after === null ? connection([1, 2], 'next') : connection([3]));
    expect(pages(fetchPage)).toEqual([1, 2, 3]);
    expect(fetchPage.mock.calls).toEqual([[null], ['next']]);
  });
  it('refuses null nodes, partial connections and repeated cursors', () => {
    expect(() => pages(() => connection([null]))).toThrow('Incomplete GitHub connection');
    expect(() => pages(() => ({ nodes: [] }))).toThrow('Incomplete GitHub connection');
    expect(() => pages(() => connection([], 'same'))).toThrow('Invalid GitHub pagination');
  });
  it('keeps query failures sanitized and rejects GraphQL partial data', () => {
    expect(() => githubClient(() => { throw new Error('sensitive subprocess output'); })('query', {})).toThrow('GitHub query failed');
    expect(() => githubClient(() => JSON.stringify({ data: {}, errors: [{ message: 'private' }] }))('query', {})).toThrow('GitHub returned incomplete data');
    expect(() => githubClient(() => 'not json')('query', {})).toThrow('GitHub query failed');
    const run = vi.fn(() => JSON.stringify({ data: { ok: true } }));
    expect(githubClient(run)('safe query', { repo: 'phantom', pr: 42, after: null })).toEqual({ ok: true });
    expect(run).toHaveBeenCalledWith('gh', ['api', 'graphql', '-f', 'query=safe query', '-f', 'repo=phantom', '-F', 'pr=42']);
  });
  it('passes strings beginning with @ as raw fields instead of gh file inputs', () => {
    const run = vi.fn(() => JSON.stringify({ data: { ok: true } }));
    expect(githubClient(run)('safe query', { repo: '@/private/path', after: '@/another/private/path', pr: 42 })).toEqual({ ok: true });
    expect(run).toHaveBeenCalledWith('gh', ['api', 'graphql', '-f', 'query=safe query', '-f', 'repo=@/private/path', '-f', 'after=@/another/private/path', '-F', 'pr=42']);
  });
  it('fetches all PR pages even when an older merge was updated recently', () => {
    const value = pr();
    const query = vi.fn((queryText: string, variables: any) => {
      if (queryText.includes('pullRequests(')) return { repository: { pullRequests: variables.after === null ? connection([{ ...value, number: 1, mergedAt: at(-10) }], 'more') : connection([value]) } };
      if (queryText.includes('timelineItems(')) return { repository: { pullRequest: { timelineItems: connection(value.timelineItems.nodes) } } };
      if (queryText.includes('checkSuites(')) return { repository: { object: { checkSuites: connection(value.checkSuites.nodes.map(suite => ({ ...suite, checkRuns: undefined }))) } } };
      return { node: { checkRuns: connection(value.checkSuites.nodes[0].checkRuns.nodes) } };
    });
    const result = collectRepo('phantom', at(0), query);
    expect(result).toHaveLength(1);
    expect(result[0].number).toBe(42);
    expect(stageMap('phantom', result[0]).ci_pr.duration_s).toBe(240);
    expect(query.mock.calls.filter(([text]) => text.includes('pullRequests('))).toHaveLength(2);
  });
});

describe('durable spool and cursor', () => {
  it('defaults to dry-run and validates options', () => {
    expect(parseArgs([])).toMatchObject({ send: false, repos: REPOS });
    expect(parseArgs(['--send', '--dry-run']).send).toBe(false);
    expect(parseArgs(['--repo', 'ashlrai/phantom,locus']).repos).toEqual(['phantom', 'locus']);
    expect(() => parseArgs(['--repo', 'other'])).toThrow('Invalid collector options');
    expect(() => parseArgs(['--since', 'invalid'])).toThrow('Invalid collector options');
    expect(() => parseArgs(['--cursor', '/same', '--spool', '/same'])).toThrow('Invalid collector options');
    expect(() => parseArgs(['--wat'])).toThrow('Invalid collector arguments');
  });
  it('replays the explicit synthetic fixture with independently calculated durations', () => {
    const options = diskOptions();
    options.fixture = fileURLToPath(new URL('./fixtures/cycle/synthetic-merged-prs.json', import.meta.url));
    options.repos = REPOS;
    expect(collect(options)).toMatchObject({ mode: 'dry-run', emitted: 14, pending: 14 });
    const events = spoolEvents(options);
    const durations = (repo: string) => Object.fromEntries(events.filter(event => event.properties.repo === repo).map(event => [event.properties.stage, event.properties.duration_s]));
    expect(durations('phantom')).toEqual({ rework: 60, ci_pr: 240, review: 180, green_to_enqueue: 60, merge_group: 240 });
    expect(durations('ashlr-md')).toEqual({ rework: 60, ci_pr: 240, review: 180, green_to_enqueue: 60, merge_group: 240 });
    expect(durations('locus')).toEqual({ rework: 60, ci_pr: 240, review: 180, green_to_merged: 300 });
    expect(collect(options)).toMatchObject({ emitted: 0, pending: 14 });
  });
  it('revisits incomplete PR evidence older than the latest merge cursor', () => {
    const old = pr();
    old.checkSuites.nodes[0].checkRuns.nodes[0].status = 'IN_PROGRESS';
    const recent = pr({ number: 43, mergedAt: at(20), updatedAt: at(21) });
    const options = diskOptions();
    writeFileSync(options.fixture, JSON.stringify({ repositories: { phantom: [old, recent] } }));
    expect(collect(options)).toMatchObject({ emitted: 8 });
    expect(JSON.parse(readFileSync(options.cursor, 'utf8')).repos.phantom).toBe(at(20));
    old.checkSuites.nodes[0].checkRuns.nodes[0].status = 'COMPLETED';
    writeFileSync(options.fixture, JSON.stringify({ repositories: { phantom: [old, recent] } }));
    expect(collect(options)).toMatchObject({ emitted: 2 });
    const oldEvents = spoolEvents(options).filter(event => event.properties.pr === 42);
    expect(oldEvents).toHaveLength(5);
    expect(new Set(oldEvents.map(event => event.properties.$insert_id)).size).toBe(5);
    expect(collect(options)).toMatchObject({ emitted: 0 });
  });
  it('compares timezone-bearing since cutoffs numerically', () => {
    const options = diskOptions();
    options.since = '2026-10-25T20:15:00-04:00';
    writeFileSync(options.fixture, JSON.stringify({ repositories: { phantom: [pr(), pr({ number: 43, mergedAt: at(20), updatedAt: at(21) })] } }));
    expect(collect(options)).toMatchObject({ emitted: 5 });
    expect(spoolEvents(options).every(event => event.properties.pr === 43)).toBe(true);
    expect(JSON.parse(readFileSync(options.cursor, 'utf8')).repos.phantom).toBe(at(20));
    expect(collect(options)).toMatchObject({ emitted: 0 });
  });
  it('rejects a missing fixture before any injected GitHub or sender call', () => {
    const options = diskOptions();
    options.fixture = join(dirs[dirs.length - 1], 'absent.json');
    const query = vi.fn();
    const run = vi.fn();
    expect(() => collect({ ...options, send: true }, { query, run })).toThrow('Invalid cycle fixture');
    expect(query).not.toHaveBeenCalled();
    expect(run).not.toHaveBeenCalled();
  });
  it.each([
    { schema: 'cycle_cursor.v1', repos: [], sent: [] },
    { schema: 'cycle_cursor.v1', repos: { phantom: 'invalid timestamp' }, sent: [] },
    { schema: 'cycle_cursor.v1', repos: { other: at(10) }, sent: [] },
    { schema: 'cycle_cursor.v1', repos: {}, sent: [123] },
    { schema: 'cycle_cursor.v1', repos: {}, sent: ['malformed-id'] },
    { schema: 'cycle_cursor.v1', repos: {}, sent: [], pending: [] },
  ])('rejects malformed cursor state before sending: %j', state => {
    const options = diskOptions();
    writeFileSync(options.cursor, JSON.stringify(state));
    const run = vi.fn();
    const query = vi.fn();
    expect(() => collect({ ...options, send: true }, { run, query })).toThrow('Invalid cycle cursor');
    expect(run).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
  });
  it('rejects fully written spool events containing unapproved free text', () => {
    const options = diskOptions();
    const event = stagesForPr('phantom', pr())[0];
    writeFileSync(options.spool, `${JSON.stringify({ ...event, title: 'private title' })}\n`);
    const run = vi.fn();
    const query = vi.fn();
    expect(() => collect({ ...options, send: true }, { run, query })).toThrow('Invalid cycle event');
    expect(run).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    writeFileSync(options.spool, `${JSON.stringify({ ...event, properties: { ...event.properties, body: 'private body' } })}\n`);
    expect(() => collect({ ...options, send: true }, { run, query })).toThrow('Invalid cycle event');
    expect(run).not.toHaveBeenCalled();
  });
  it('spools once and emits zero duplicate IDs on rerun', () => {
    const options = diskOptions();
    const run = vi.fn();
    expect(collect(options, { run })).toEqual({ mode: 'dry-run', emitted: 5, sent: 0, pending: 5 });
    const before = readFileSync(options.spool, 'utf8');
    expect(collect(options, { run })).toEqual({ mode: 'dry-run', emitted: 0, sent: 0, pending: 5 });
    expect(readFileSync(options.spool, 'utf8')).toBe(before);
    expect(new Set(spoolEvents(options).map(event => event.properties.$insert_id)).size).toBe(5);
    expect(JSON.parse(readFileSync(options.cursor, 'utf8'))).toMatchObject({ repos: { phantom: at(10) }, sent: [] });
    expect(run).not.toHaveBeenCalled();
  });
  it('dry-run then send drains through phantom exec and persists only acknowledgments', () => {
    const options = diskOptions();
    collect(options);
    const run = vi.fn((_command: string, _args: string[], opts: any) => {
      const event = JSON.parse(opts.input);
      return `Phantom connection ready\nCYCLE_RECEIPT ${JSON.stringify({ sent: true, insert_id: event.properties.$insert_id })}\n`;
    });
    expect(collect({ ...options, send: true }, { run })).toEqual({ mode: 'send', emitted: 0, sent: 5, pending: 0 });
    expect(run).toHaveBeenCalledTimes(5);
    expect(run.mock.calls[0][0]).toBe('phantom');
    expect(run.mock.calls[0][1].slice(0, 4)).toEqual(['exec', '--', 'node', expect.stringMatching(/capture\.mjs$/)]);
    expect(collect({ ...options, send: true }, { run })).toEqual({ mode: 'send', emitted: 0, sent: 0, pending: 0 });
    expect(run).toHaveBeenCalledTimes(5);
  });
  it('retains the outbox after sender failure without leaking output', () => {
    const options = diskOptions();
    const run = vi.fn(() => { throw new Error('private sender output'); });
    expect(() => collect({ ...options, send: true }, { run })).toThrow('Telemetry sender failed; events remain spooled');
    expect(spoolEvents(options)).toHaveLength(5);
    expect(JSON.parse(readFileSync(options.cursor, 'utf8')).sent).toEqual([]);
    expect(collect(options)).toMatchObject({ emitted: 0, pending: 5 });
  });
  it('persists partial successful delivery and resumes only pending IDs', () => {
    const options = diskOptions();
    let attempts = 0;
    const partial = vi.fn((_command: string, _args: string[], opts: any) => {
      attempts++;
      if (attempts === 3) throw new Error('sender interrupted');
      return `CYCLE_RECEIPT ${JSON.stringify({ sent: true, insert_id: JSON.parse(opts.input).properties.$insert_id })}\n`;
    });
    expect(() => collect({ ...options, send: true }, { run: partial })).toThrow('Telemetry sender failed; events remain spooled');
    const acknowledged = JSON.parse(readFileSync(options.cursor, 'utf8')).sent;
    expect(acknowledged).toHaveLength(2);
    expect(spoolEvents(options)).toHaveLength(5);
    const resumedIds: string[] = [];
    const resume = vi.fn((_command: string, _args: string[], opts: any) => {
      const id = JSON.parse(opts.input).properties.$insert_id;
      resumedIds.push(id);
      return `CYCLE_RECEIPT ${JSON.stringify({ sent: true, insert_id: id })}\n`;
    });
    expect(collect({ ...options, send: true }, { run: resume })).toEqual({ mode: 'send', emitted: 0, sent: 3, pending: 0 });
    expect(resume).toHaveBeenCalledTimes(3);
    expect(resumedIds.some(id => acknowledged.includes(id))).toBe(false);
    expect(new Set([...acknowledged, ...resumedIds]).size).toBe(5);
  });
  it('does not mark a missing-key or mismatched receipt as delivered', () => {
    const options = diskOptions();
    const run = vi.fn(() => 'CYCLE_RECEIPT {"sent":false,"insert_id":"unknown"}\n');
    expect(collect({ ...options, send: true }, { run })).toMatchObject({ sent: 0, pending: 5 });
    expect(JSON.parse(readFileSync(options.cursor, 'utf8')).sent).toEqual([]);
    expect(collect({ ...options, send: true }, { run: () => 'CYCLE_RECEIPT {"sent":true,"insert_id":"other"}\n' })).toMatchObject({ sent: 0, pending: 5 });
  });
  it('rejects truncated spool and malformed state before sending', () => {
    const options = diskOptions();
    writeFileSync(options.spool, '{"partial":');
    const run = vi.fn();
    expect(() => collect({ ...options, send: true }, { run })).toThrow('Incomplete cycle spool');
    writeFileSync(options.spool, '');
    writeFileSync(options.cursor, '{}');
    expect(() => collect({ ...options, send: true }, { run })).toThrow('Invalid cycle cursor');
    expect(run).not.toHaveBeenCalled();
  });
});

describe('capture child security boundary', () => {
  it('does not send without a key', async () => {
    const event = stagesForPr('phantom', pr())[0];
    const fetchImpl = vi.fn();
    await expect(capture(event, { env: {}, fetchImpl })).resolves.toEqual({ sent: false, insert_id: event.properties.$insert_id });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('never sends a Phantom placeholder as the project key', async () => {
    const event = stagesForPr('phantom', pr())[0];
    const fetchImpl = vi.fn();
    await expect(capture(event, { env: { POSTHOG_PROJECT_KEY: 'phm_synthetic-placeholder' }, fetchImpl })).resolves.toMatchObject({ sent: false });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
  it('sends an allowlisted event and returns only its acknowledgment', async () => {
    const event = stagesForPr('phantom', pr())[0];
    const fetchImpl = vi.fn(async (_url: string, _options: any) => ({ ok: true, status: 200 }));
    const receipt = await capture(event, { env: { POSTHOG_PROJECT_KEY: 'synthetic-test-key' }, fetchImpl });
    expect(receipt).toEqual({ sent: true, insert_id: event.properties.$insert_id });
    expect(fetchImpl.mock.calls[0][0]).toBe('https://us.i.posthog.com/capture/');
    expect(JSON.parse((fetchImpl.mock.calls[0] as any)[1].body)).toEqual({ api_key: 'synthetic-test-key', ...event });
    expect(JSON.stringify(receipt)).not.toContain('synthetic-test-key');
  });
  it('prints only an HTTP status for rejected captures', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const event = stagesForPr('phantom', pr())[0];
    const response = { ok: false, status: 429, text: vi.fn(() => 'synthetic-test-key private body') };
    expect(await capture(event, { env: { POSTHOG_PROJECT_KEY: 'synthetic-test-key' }, fetchImpl: async () => response })).toMatchObject({ sent: false });
    expect(error.mock.calls).toEqual([['Cycle capture HTTP 429']]);
    expect(response.text).not.toHaveBeenCalled();
  });
  it('does not print sensitive fetch exceptions', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    const event = stagesForPr('phantom', pr())[0];
    expect(await capture(event, { env: { POSTHOG_PROJECT_KEY: 'synthetic-test-key' }, fetchImpl: async () => { throw new Error('synthetic-test-key private request body'); } })).toMatchObject({ sent: false });
    expect(error.mock.calls).toEqual([['Cycle capture failed']]);
  });
  it('refuses extra fields and forged IDs before network access', async () => {
    const event = stagesForPr('phantom', pr())[0];
    expect(validateEvent(event)).toBe(event);
    expect(() => validateEvent({ ...event, title: 'private' })).toThrow('Invalid cycle event');
    expect(() => validateEvent({ ...event, properties: { ...event.properties, body: 'private' } })).toThrow('Invalid cycle event');
    const fetchImpl = vi.fn();
    await expect(capture({ ...event, properties: { ...event.properties, $insert_id: 'forged' } }, { env: {}, fetchImpl })).rejects.toThrow('Invalid cycle event');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
