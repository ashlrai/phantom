import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { collectRepo, eventsForPr, parseArgs, run, gh } from '../scripts/cycle-collect.mjs';
import { sendSpool } from '../scripts/cycle-send.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/cycle-collect/gh.json', import.meta.url), 'utf8'));
function request(query: string) {
  const data = structuredClone(fixture);
  if (query.includes('search(query:')) return { search: data.search };
  if (query.includes('timelineItems(')) return { repository: { pullRequest: { timelineItems: data.timelineItems } } };
  if (query.includes('object(oid:')) return { repository: { object: { checkSuites: data.checkSuites } } };
  return { node: { checkRuns: data.checkRuns } };
}
const repo = 'ashlrai/phantom';
const prs = () => collectRepo(repo, '2026-10-25T00:00:00Z', '2026-10-26T00:00:00Z', request);
const dirs: string[] = [];
function options() {
  const dir = mkdtempSync(join(tmpdir(), 'cycle-collect-'));
  dirs.push(dir);
  return { repos: [repo], state: join(dir, 'cursor.json'), spool: join(dir, 'events.jsonl'), since: '2026-10-25T00:00:00.000Z', until: '2026-10-26T00:00:00.000Z' };
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe('cycle metrics from fixture gh JSON', () => {
  it('matches hand-calculated baseline boundaries for final-head Actions suites', () => {
    const events = eventsForPr(repo, prs()[0]);
    expect(events.map(e => [e.properties.stage, e.properties.duration_s])).toEqual([
      ['rework', 2400], ['ci_pr', 1200], ['review', 600], ['green_to_enqueue', 600], ['merge_group', 1200],
    ]);
    const event = events[0];
    expect(event.properties.$insert_id).toBe(createHash('sha256').update(`${repo}|42|RQ-CYCLE-1|abcdef0123456789abcdef0123456789abcdef01|rework|1`).digest('hex').slice(0, 32));
    expect(event.distinct_id).toBe('cycle:ashlrai/phantom:42');
    expect(event.properties).toMatchObject({ schema: 'cycle_stage.v1', pool: 'none', source: 'backfill', attempt: 1 });
    expect(JSON.stringify(events)).not.toContain('private-title-sentinel');
    expect(event.properties.ts_start).toBe('2026-10-25T10:00:00.000Z');
  });

  it('combines S7/S8 on repos without a merge queue and provides the job fallback', () => {
    const pr = prs()[0];
    pr.headRefName = 'fix/no-job';
    const events = eventsForPr('ashlrai/locus', pr);
    expect(events.at(-1).properties).toMatchObject({ stage: 'green_to_merged', duration_s: 1800, job_id: 'pr-locus-42' });
  });

  it('accepts owner formal reviews and comment reviews, ignoring other authors', () => {
    const pr = prs()[0];
    pr.timeline = [
      { __typename: 'IssueComment', author: { login: 'stranger' }, createdAt: '2026-10-25T10:01:00Z' },
      { __typename: 'PullRequestReview', author: { login: 'masonwyatt23' }, state: 'COMMENTED', submittedAt: '2026-10-25T10:10:00Z' },
    ];
    expect(eventsForPr(repo, pr).find(e => e.properties.stage === 'review').properties.duration_s).toBe(600);
    pr.timeline[1] = { __typename: 'IssueComment', author: { login: 'masonwyatt23' }, createdAt: '2026-10-25T10:12:00Z' };
    expect(eventsForPr(repo, pr).find(e => e.properties.stage === 'review').properties.duration_s).toBe(720);
  });

  it('does not fabricate review, CI, or green boundaries from missing evidence', () => {
    const pr = prs()[0];
    pr.timeline = [];
    pr.checkSuites = [];
    expect(eventsForPr(repo, pr)).toEqual([]);
    pr.checkSuites = prs()[0].checkSuites;
    pr.checkSuites[0].checkRuns[0].status = 'IN_PROGRESS';
    expect(eventsForPr(repo, pr).map(e => e.properties.stage)).toEqual(['rework']);
  });

  it('never treats failed CI as green, and rejects backwards or post-merge spans', () => {
    const pr = prs()[0];
    pr.checkSuites[0].checkRuns[0].conclusion = 'FAILURE';
    expect(eventsForPr(repo, pr).map(e => e.properties.stage)).not.toContain('green_to_enqueue');
    pr.checkSuites[0].createdAt = '2026-10-25T09:00:00Z';
    pr.checkSuites[0].checkRuns[0].completedAt = '2026-10-26T00:00:00Z';
    expect(eventsForPr(repo, pr).map(e => e.properties.stage)).not.toContain('ci_pr');
    expect(eventsForPr(repo, pr).map(e => e.properties.stage)).not.toContain('rework');
  });

  it('uses the final queue admission even when admission precedes green', () => {
    const pr = prs()[0];
    pr.timeline.push(
      { __typename: 'RemovedFromMergeQueueEvent', createdAt: '2026-10-25T11:12:00Z' },
      { __typename: 'AddedToMergeQueueEvent', createdAt: '2026-10-25T11:20:00Z' },
    );
    expect(eventsForPr(repo, pr).at(-1).properties.duration_s).toBe(600);
    pr.timeline = pr.timeline.filter(e => !['AddedToMergeQueueEvent', 'RemovedFromMergeQueueEvent'].includes(e.__typename));
    pr.timeline.push({ __typename: 'AddedToMergeQueueEvent', createdAt: '2026-10-25T10:50:00Z' });
    const events = eventsForPr(repo, pr);
    expect(events.map(e => e.properties.stage)).not.toContain('green_to_enqueue');
    expect(events.at(-1).properties).toMatchObject({ stage: 'merge_group', duration_s: 2400 });
    pr.timeline.push({ __typename: 'AutoMergeEnabledEvent', createdAt: '2026-10-25T11:05:00Z' });
    expect(eventsForPr(repo, pr).find(e => e.properties.stage === 'green_to_enqueue').properties.duration_s).toBe(300);
  });

  it('uses required external checks and the latest run of a retried check', () => {
    const pr = prs()[0];
    pr.checkSuites[0].checkRuns = [
      { name: 'test', startedAt: '2026-10-25T10:40:00Z', completedAt: '2026-10-25T10:45:00Z', status: 'COMPLETED', conclusion: 'FAILURE' },
      { name: 'test', startedAt: '2026-10-25T10:46:00Z', completedAt: '2026-10-25T10:55:00Z', status: 'COMPLETED', conclusion: 'SUCCESS' },
    ];
    expect(eventsForPr(repo, pr).map(e => e.properties.stage)).toContain('green_to_enqueue');
    pr.checkSuites[1].checkRuns = [{ isRequired: true, status: 'IN_PROGRESS', conclusion: null, completedAt: null }];
    expect(eventsForPr(repo, pr).map(e => e.properties.stage)).not.toContain('ci_pr');
  });

  it('deduplicates reruns and recovers spool writes made before a cursor commit', () => {
    const opts = options();
    expect(run(opts, { collect: prs }).events).toBe(5);
    const before = readFileSync(opts.spool, 'utf8');
    expect(run(opts, { collect: prs }).events).toBe(0);
    rmSync(opts.state);
    expect(run(opts, { collect: prs }).events).toBe(0);
    expect(readFileSync(opts.spool, 'utf8')).toBe(before);
    expect(JSON.parse(readFileSync(opts.state, 'utf8')).insertIds).toHaveLength(5);
  });

  it('does not commit any state when a repository fails', () => {
    const opts = { ...options(), repos: [repo, 'ashlrai/locus'] };
    expect(() => run(opts, { collect: (name: string) => { if (name !== repo) throw new Error('offline'); return prs(); } })).toThrow('offline');
    expect(existsSync(opts.state)).toBe(false);
    expect(existsSync(opts.spool)).toBe(false);
    expect(existsSync(`${opts.state}.lock`)).toBe(false);
  });

  it('fails closed on corrupt state, corrupt spool and concurrent runs', () => {
    const opts = options();
    writeFileSync(opts.state, '{}');
    expect(() => run(opts, { collect: prs })).toThrow('Invalid collector state');
    rmSync(opts.state);
    writeFileSync(opts.spool, '{bad json');
    expect(() => run(opts, { collect: prs })).toThrow('Cannot recover');
    writeFileSync(`${opts.state}.lock`, '');
    expect(() => run(opts, { collect: prs })).toThrow('locked');
  });

  it('uses inclusive cursor overlap and respects explicit backfill ranges', () => {
    const opts = options();
    run(opts, { collect: prs });
    const collect = vi.fn(prs);
    const { since: _since, ...resume } = opts;
    run(resume, { collect });
    expect(collect.mock.calls[0][1]).toBe('2026-10-24T11:30:00.000Z');
    const filtered = options();
    filtered.until = '2026-10-25T11:00:00.000Z';
    expect(run(filtered, { collect: prs }).events).toBe(0);
  });

  it('paginates nested connections and refuses truncated or looping GitHub results', () => {
    const calls: string[] = [];
    const paginated = (query: string, vars: Record<string, unknown>) => {
      calls.push(query);
      if (query.includes('timelineItems(') && !vars.cursor) return { repository: { pullRequest: { timelineItems: { nodes: [], pageInfo: { hasNextPage: true, endCursor: 'next' } } } } };
      return request(query);
    };
    expect(collectRepo(repo, '2026-10-25', '2026-10-26', paginated)[0].timeline).toHaveLength(5);
    expect(calls.filter(q => q.includes('timelineItems('))).toHaveLength(2);
    expect(() => collectRepo(repo, '2026-10-25', '2026-10-26', () => ({ search: { ...fixture.search, issueCount: 1001 } }))).toThrow('narrower');
    expect(() => collectRepo(repo, '2026-10-25', '2026-10-26', () => ({ search: { ...fixture.search, pageInfo: { hasNextPage: true, endCursor: 'same' } } }))).toThrow('pagination');
  });

  it.each(['search', 'checkSuites', 'checkRuns'])('paginates %s connections', connection => {
    const seen: string[] = [];
    const paginated = (query: string, vars: Record<string, unknown>) => {
      const isConnection = connection === 'search' ? query.includes('search(query:') : connection === 'checkSuites' ? query.includes('object(oid:') : query.includes('node(id:');
      if (!isConnection) return request(query);
      seen.push(String(vars.cursor));
      const data = request(query);
      const page = connection === 'search' ? data.search : connection === 'checkSuites' ? data.repository.object.checkSuites : data.node.checkRuns;
      if (!vars.cursor) { page.nodes = []; page.pageInfo = { hasNextPage: true, endCursor: 'second' }; }
      return data;
    };
    expect(collectRepo(repo, '2026-10-25', '2026-10-26', paginated)).toHaveLength(1);
    expect(seen).toContain('second');
  });

  it('constructs read-only gh commands and suppresses failure payloads', () => {
    const execute = vi.fn().mockReturnValue(JSON.stringify({ data: { success: true } }));
    expect(gh('query Fixture {}', { number: 42, cursor: null, owner: 'ashlrai' }, execute)).toEqual({ success: true });
    expect(execute.mock.calls[0][0]).toBe('gh');
    expect(execute.mock.calls[0][1]).toEqual(['api', 'graphql', '-f', 'query=query Fixture {}', '-F', 'number=42', '-f', 'owner=ashlrai']);
    execute.mockImplementation(() => { throw new Error('fixture-secret'); });
    expect(() => gh('query Fixture {}', {}, execute)).toThrow('gh GraphQL request failed (details suppressed)');
    execute.mockReturnValue(JSON.stringify({ errors: [{ message: 'fixture-secret' }] }));
    expect(() => gh('query Fixture {}', {}, execute)).toThrow('gh GraphQL returned errors');
  });

  it('rejects invalid identities and ignores unproven bot approvals', () => {
    const pr = prs()[0];
    expect(() => eventsForPr(repo, { ...pr, headRefOid: 'bad' })).toThrow('Invalid PR identity');
    pr.timeline = [{ __typename: 'IssueComment', author: { login: 'coderabbitai' }, body: 'Not approved; review in progress', createdAt: '2026-10-25T10:15:00Z' }];
    expect(eventsForPr(repo, pr).map(e => e.properties.stage)).not.toContain('review');
  });

  it('validates CLI arguments and defaults to a local spool', () => {
    expect(parseArgs([]).repos).toHaveLength(7);
    expect(parseArgs([]).send).toBeUndefined();
    expect(parseArgs(['--repo', repo, '--since', '2026-10-25', '--dry-run']).since).toBe('2026-10-25T00:00:00.000Z');
    for (const args of [['--repo', '-bad'], ['--since', 'bad'], ['--since', '2026-02-30'], ['--state'], ['--unknown'], ['--since', '2026-10-26', '--until', '2026-10-25']]) expect(() => parseArgs(args)).toThrow();
    expect(parseArgs(['--help'])).toBeNull();
  });
});

describe('vault-side spool delivery (offline)', () => {
  it('keeps a spool without a key and sends each event only once with a key', async () => {
    const opts = options();
    run(opts, { collect: prs });
    const request = vi.fn().mockResolvedValue({ ok: true });
    expect(await sendSpool(opts.spool, { request })).toEqual({ sent: 0, unavailable: true });
    expect(request).not.toHaveBeenCalled();
    expect(await sendSpool(opts.spool, { key: 'fixture-key', request })).toMatchObject({ sent: 5 });
    expect(await sendSpool(opts.spool, { key: 'fixture-key', request })).toMatchObject({ sent: 0 });
    expect(request).toHaveBeenCalledTimes(5);
    expect(JSON.parse(request.mock.calls[0][1].body).properties).toMatchObject({ distinct_id: 'cycle:ashlrai/phantom:42', schema: 'cycle_stage.v1' });
    expect(request.mock.calls[0][1].redirect).toBe('error');
    expect(readFileSync(opts.spool, 'utf8')).not.toContain('fixture-key');
    expect(readFileSync(`${opts.spool}.sent`, 'utf8')).not.toContain('fixture-key');
  });

  it('rejects tampered events before sending any network request', async () => {
    const opts = options();
    run(opts, { collect: prs });
    const event = JSON.parse(readFileSync(opts.spool, 'utf8').split('\n')[0]);
    event.properties.body = 'must-never-upload';
    writeFileSync(opts.spool, JSON.stringify(event) + '\n');
    const request = vi.fn();
    await expect(sendSpool(opts.spool, { key: 'fixture-key', request })).rejects.toThrow('Invalid cycle event');
    expect(request).not.toHaveBeenCalled();
  });

  it('retains failed events for retry without exposing transport details', async () => {
    const opts = options();
    run(opts, { collect: prs });
    const request = vi.fn().mockRejectedValue(new Error('fixture-secret'));
    await expect(sendSpool(opts.spool, { key: 'fixture-key', request })).rejects.toThrow('Capture transport failed');
    expect(existsSync(`${opts.spool}.sent`)).toBe(false);
    expect(existsSync(`${opts.spool}.send.lock`)).toBe(false);
    request.mockResolvedValue({ ok: false, status: 503 });
    await expect(sendSpool(opts.spool, { key: 'fixture-key', request })).rejects.toThrow('Capture status 503');
  });
});
