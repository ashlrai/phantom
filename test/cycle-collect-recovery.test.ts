import { existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
// @ts-expect-error -- standalone ESM CLI has no declaration file
import { collect, collectRepo, parseArgs, stagesForPr } from '../scripts/cycle/collect.mjs';

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const at = (minute: number) => new Date(Date.UTC(2026, 9, 26, 0, minute)).toISOString();
const connection = (nodes: any[], cursor: string | null = null) => ({ nodes, pageInfo: { hasNextPage: cursor !== null, endCursor: cursor } });
const identity = { number: 42, createdAt: at(0), mergedAt: at(10), updatedAt: at(11), headRefOid: 'a'.repeat(40) };
const review = { __typename: 'IssueComment', createdAt: at(3), body: 'LGTM', author: { login: 'masonwyatt23' } };
const queue = { __typename: 'AddedToMergeQueueEvent', createdAt: at(6) };
const run = { name: 'required', isRequired: true, status: 'COMPLETED', conclusion: 'SUCCESS', startedAt: at(1), completedAt: at(5) };
const suite = { id: 'suite', createdAt: at(1), app: { slug: 'github-actions' }, workflowRun: { workflow: { id: 'workflow' } }, checkRuns: { nodes: [run] } };

function options() {
  const dir = mkdtempSync(join(tmpdir(), 'cycle-recovery-'));
  dirs.push(dir);
  const fixture = join(dir, 'prs.json');
  writeFileSync(fixture, JSON.stringify({ repositories: { phantom: [{ ...identity, timelineItems: { nodes: [review, queue] }, checkSuites: { nodes: [suite] } }] } }));
  return parseArgs(['--repo', 'phantom', '--fixture', fixture, '--cursor', join(dir, 'cursor.json'), '--spool', join(dir, 'spool.jsonl')]);
}

describe('cycle collector recovery and nested pagination', () => {
  it('preserves pre-merge CI evidence when a check is rerun after merge', () => {
    const rerun = { ...run, startedAt: at(11), completedAt: at(12) };
    const events = stagesForPr('phantom', {
      ...identity, timelineItems: { nodes: [review, queue] },
      checkSuites: { nodes: [{ ...suite, checkRuns: { nodes: [run, rerun] } }] },
    });
    expect(events.find((event: any) => event.properties.stage === 'ci_pr').properties.duration_s).toBe(240);
    expect(events.find((event: any) => event.properties.stage === 'green_to_enqueue').properties.duration_s).toBe(60);
  });
  it('recovers an outbox written before the first cursor checkpoint without duplicate IDs', () => {
    const opts = options();
    expect(collect(opts).emitted).toBe(5);
    const before = readFileSync(opts.spool, 'utf8');
    unlinkSync(opts.cursor);
    expect(collect(opts)).toMatchObject({ emitted: 0, pending: 5 });
    expect(readFileSync(opts.spool, 'utf8')).toBe(before);
  });

  it('refuses a lost outbox before advancing its watermark or sending', () => {
    const opts = options();
    collect(opts);
    const before = readFileSync(opts.cursor, 'utf8');
    unlinkSync(opts.spool);
    const query = vi.fn();
    const sender = vi.fn();
    expect(() => collect({ ...opts, send: true }, { query, run: sender })).toThrow('Cycle spool missing for existing cursor');
    expect(readFileSync(opts.cursor, 'utf8')).toBe(before);
    expect(query).not.toHaveBeenCalled();
    expect(sender).not.toHaveBeenCalled();
    expect(existsSync(`${opts.cursor}.lock`)).toBe(false);
  });

  it('rejects corrupt retry identities even for an unselected repository', () => {
    const opts = options();
    writeFileSync(opts.cursor, JSON.stringify({ schema: 'cycle_cursor.v1', repos: {}, sent: [], pending: { locus: [{ ...identity, headRefOid: 'invalid' }] } }));
    const query = vi.fn();
    expect(() => collect(opts, { query })).toThrow('Invalid PR identity');
    expect(query).not.toHaveBeenCalled();
  });

  it('paginates timelines, suites and runs separately and queries only the final SHA', () => {
    const queries: Array<{ query: string; variables: any }> = [];
    const query = (text: string, variables: any) => {
      queries.push({ query: text, variables });
      if (text.includes('pullRequests(')) return { repository: { pullRequests: connection([identity]) } };
      if (text.includes('timelineItems(')) return { repository: { pullRequest: { timelineItems: variables.after ? connection([queue]) : connection([review], 'timeline-next') } } };
      if (text.includes('checkSuites(')) return { repository: { object: { checkSuites: variables.after ? connection([suite]) : connection([{ id: 'external', app: { slug: 'other-app' } }], 'suite-next') } } };
      if (text.includes('checkRuns(')) return { node: { checkRuns: variables.after ? connection([run]) : connection([], 'run-next') } };
      throw new Error('Unexpected query');
    };
    const prs = collectRepo('phantom', at(0), query);
    expect(prs).toHaveLength(1);
    expect(prs[0].timelineItems.nodes).toEqual([review, queue]);
    expect(prs[0].checkSuites.nodes[1].checkRuns.nodes).toEqual([run]);
    expect(queries.filter(call => call.query.includes('checkSuites(')).map(call => call.variables))
      .toEqual([{ repo: 'phantom', sha: identity.headRefOid, after: null }, { repo: 'phantom', sha: identity.headRefOid, after: 'suite-next' }]);
    expect(queries.filter(call => call.query.includes('checkRuns(')).map(call => call.variables))
      .toEqual([{ id: 'suite', pr: 42, after: null }, { id: 'suite', pr: 42, after: 'run-next' }]);
    expect(queries.filter(call => call.query.includes('checkRuns(')).every(call => call.query.includes('checkType:ALL'))).toBe(true);
  });

  it('uses immutable PR ordering and scans past old summaries for recently merged old PRs', () => {
    const query = vi.fn((text: string, variables: any) => {
      if (text.includes('pullRequests(')) {
        expect(text).toContain('field:CREATED_AT');
        const old = { ...identity, number: 1, mergedAt: at(-10), updatedAt: at(-5) };
        return { repository: { pullRequests: variables.after ? connection([identity]) : connection([old], 'older-created-prs') } };
      }
      if (text.includes('timelineItems(')) return { repository: { pullRequest: { timelineItems: connection([review, queue]) } } };
      if (text.includes('checkSuites(')) return { repository: { object: { checkSuites: connection([suite]) } } };
      return { node: { checkRuns: connection([run]) } };
    });
    expect(collectRepo('phantom', at(0), query).map((pr: any) => pr.number)).toEqual([42]);
    expect(query.mock.calls.filter(([text]) => text.includes('pullRequests('))).toHaveLength(2);
  });

  it('defers merges newer than scan start so they cannot advance the watermark past a gap', () => {
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(at(8)));
    const query = vi.fn((text: string) => {
      if (text.includes('pullRequests(')) return { repository: { pullRequests: connection([identity]) } };
      if (text.includes('timelineItems(')) return { repository: { pullRequest: { timelineItems: connection([review, queue]) } } };
      if (text.includes('checkSuites(')) return { repository: { object: { checkSuites: connection([suite]) } } };
      return { node: { checkRuns: connection([run]) } };
    });
    expect(collectRepo('phantom', at(0), query)).toEqual([]);
    expect(query).toHaveBeenCalledTimes(1);
    clock.mockReturnValue(Date.parse(at(20)));
    expect(collectRepo('phantom', at(0), query).map((pr: any) => pr.number)).toEqual([42]);
  });

  it('does not persist a partial multi-repository collection when GitHub fails', () => {
    const opts = options();
    delete opts.fixture;
    opts.repos = ['phantom', 'locus'];
    const query = (text: string, variables: any) => {
      if (variables.repo === 'locus') throw new Error('GitHub unavailable');
      if (text.includes('pullRequests(')) return { repository: { pullRequests: connection([identity]) } };
      if (text.includes('timelineItems(')) return { repository: { pullRequest: { timelineItems: connection([review, queue]) } } };
      if (text.includes('checkSuites(')) return { repository: { object: { checkSuites: connection([suite]) } } };
      return { node: { checkRuns: connection([run]) } };
    };
    expect(() => collect(opts, { query })).toThrow('GitHub unavailable');
    expect(existsSync(opts.cursor)).toBe(false);
    expect(existsSync(opts.spool)).toBe(false);
    expect(existsSync(`${opts.cursor}.lock`)).toBe(false);
  });
});
