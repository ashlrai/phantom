import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleetMergeIdentity } from '../src/cli/fleet-merge-identity.js';
import { classifyMerge, readMerges, summarizeMerges, type MergeRecord } from '../src/core/prs/merge-identity.js';

const user = (login: string) => ({ login, type: 'User' });
const bot = (login: string) => ({ login, type: 'Bot' });
const queue = bot('github-merge-queue');

const records: MergeRecord[] = [
  { number: 1, mergedAt: '2026-11-02T10:00:00Z', mergedBy: user('mason'), enqueuer: null },
  { number: 2, mergedAt: '2026-11-03T10:00:00Z', mergedBy: queue, enqueuer: bot('ashlr-release') },
  { number: 3, mergedAt: '2026-11-04T10:00:00Z', mergedBy: queue, enqueuer: user('mason') },
  { number: 4, mergedAt: '2026-11-05T10:00:00Z', mergedBy: queue, enqueuer: user('lane-bot-acct') },
  { number: 5, mergedAt: '2026-11-06T10:00:00Z', mergedBy: queue, enqueuer: null },
  { number: 6, mergedAt: '2026-11-07T10:00:00Z', mergedBy: null, enqueuer: null },
  { number: 7, mergedAt: '2026-10-01T10:00:00Z', mergedBy: user('mason'), enqueuer: null },
];

describe('classifyMerge', () => {
  it('credits a queue merge to the enqueuer, not the relay', () => {
    expect(classifyMerge(records[1]!)).toMatchObject({ class: 'automation', actor: 'ashlr-release', via: 'queue-enqueuer' });
    expect(classifyMerge(records[2]!)).toMatchObject({ class: 'human', actor: 'mason', via: 'queue-enqueuer' });
  });
  it('treats a direct merge by a user as human and by a bot as automation', () => {
    expect(classifyMerge(records[0]!)).toMatchObject({ class: 'human', via: 'merged-by' });
    expect(classifyMerge({ ...records[0]!, mergedBy: bot('ashlr-release[bot]') }).class).toBe('automation');
  });
  it('honors named automation logins, case and [bot] suffix insensitive', () => {
    expect(classifyMerge(records[3]!, ['Lane-Bot-Acct']).class).toBe('automation');
    expect(classifyMerge(records[3]!).class).toBe('human');
  });
  it('is unknown when GitHub recorded no actor', () => {
    expect(classifyMerge(records[4]!)).toMatchObject({ class: 'unknown', actor: null, via: 'none' });
    expect(classifyMerge(records[5]!).class).toBe('unknown');
  });
});

describe('summarizeMerges', () => {
  it('counts by class and actor inside the window only', () => {
    const s = summarizeMerges(records, { repo: 'o/r', since: '2026-11-01T00:00:00Z' });
    expect(s.total).toBe(6);
    expect(s.counts).toEqual({ automation: 1, human: 3, unknown: 2 });
    expect(s.actors[0]).toEqual({ login: 'mason', class: 'human', count: 2 });
  });
  it('applies until as an exclusive bound', () => {
    const s = summarizeMerges(records, { repo: 'o/r', since: '2026-11-01', until: '2026-11-04T10:00:00Z' });
    expect(s.total).toBe(2);
  });
});

function node(r: MergeRecord) {
  return {
    number: r.number,
    mergedAt: r.mergedAt,
    mergedBy: r.mergedBy && { __typename: r.mergedBy.type, login: r.mergedBy.login },
    timelineItems: { nodes: r.enqueuer ? [{ enqueuer: { __typename: r.enqueuer.type, login: r.enqueuer.login } }] : [] },
  };
}

function fakeGh(pages: MergeRecord[][], calls: string[][] = []) {
  return async (args: string[]) => {
    calls.push(args);
    if (args[0] === 'repo') return JSON.stringify({ nameWithOwner: 'ashlrai/phantom' });
    const cursor = args.find(a => a.startsWith('cursor='));
    const index = cursor ? Number(cursor.slice(7)) : 0;
    return JSON.stringify({ data: { search: {
      pageInfo: { hasNextPage: index + 1 < pages.length, endCursor: String(index + 1) },
      nodes: [...pages[index]!.map(node), { notAPr: true }],
    } } });
  };
}

describe('readMerges', () => {
  it('pages through the search and ignores non-PR nodes', async () => {
    const calls: string[][] = [];
    const out = await readMerges('ashlrai/phantom', '2026-11-01T00:00:00Z', { gh: fakeGh([records.slice(0, 3), records.slice(3)], calls) });
    expect(out.records.map(r => r.number)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(out.truncated).toBe(false);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('q=repo:ashlrai/phantom is:pr is:merged merged:>=2026-11-01T00:00:00Z');
  });
  it('flags truncation at the page cap', async () => {
    const out = await readMerges('ashlrai/phantom', '2026-11-01', { gh: fakeGh(Array.from({ length: 50 }, () => [records[0]!])) });
    expect(out.truncated).toBe(true);
  });
  it('rejects a malformed repo before calling gh', async () => {
    const gh = vi.fn();
    await expect(readMerges('not a repo', '2026-11-01', { gh })).rejects.toThrow(/Invalid repository/);
    expect(gh).not.toHaveBeenCalled();
  });
});

describe('fleet merge-identity', () => {
  afterEach(() => { vi.restoreAllMocks(); });
  const run = async (args: string[], gh = fakeGh([records])) => {
    const out: string[] = [], err: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((m: unknown) => { out.push(String(m)); });
    vi.spyOn(console, 'error').mockImplementation((m: unknown) => { err.push(String(m)); });
    const code = await cmdFleetMergeIdentity(args, { gh });
    return { code, out: out.join('\n'), err: err.join('\n') };
  };

  it('prints one JSON summary and defaults the repo from gh', async () => {
    const { code, out } = await run(['--since', '2026-11-01T00:00:00Z', '--json']);
    expect(code).toBe(0);
    expect(JSON.parse(out)).toMatchObject({ v: 1, repo: 'ashlrai/phantom', total: 6, counts: { automation: 1, human: 3, unknown: 2 }, truncated: false });
  });
  it('moves a named login to automation', async () => {
    const { out } = await run(['--since', '2026-11-01', '--repo', 'ashlrai/phantom', '--automation-login', 'lane-bot-acct', '--json']);
    expect(JSON.parse(out).counts).toEqual({ automation: 2, human: 2, unknown: 2 });
  });
  it('prints a human line without --json', async () => {
    const { out } = await run(['--since', '2026-11-01']);
    expect(out).toContain('6 merged since 2026-11-01: 1 automation, 3 human, 2 unknown.');
  });
  it('uses exit 2 for bad usage and never calls gh', async () => {
    const gh = vi.fn();
    for (const args of [['nope'], [], ['--since', 'yesterday'], ['--since', '2026-11-01', '--bogus'], ['--since', '2026-11-01', '--until', 'x']]) {
      expect((await run(args, gh)).code).toBe(2);
    }
    expect(gh).not.toHaveBeenCalled();
  });
  it('exits 1 with a short error when gh fails', async () => {
    const { code, err } = await run(['--since', '2026-11-01'], async () => { throw new Error('gh api graphql: boom'); });
    expect(code).toBe(1);
    expect(err).toContain('boom');
  });
  it('prints help with exit 0', async () => {
    expect((await run(['--help'])).code).toBe(0);
  });
});
