/** RQ-PHX-MERGEACTORRECOVER171: recovered merge attribution from #5130 (evidence: 39fc2f54ee).
 * gh is mocked at the autopilot boundary, so nothing here reaches the network. */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdFleet } from '../src/cli/fleet.js';
import { cmdFleetMergeIdentity } from '../src/cli/fleet-merge-identity.js';
import { classifyMerge, readMerges, summarizeMerges, type MergeRecord } from '../src/core/prs/merge-identity.js';

const gh = vi.hoisted(() => ({ run: vi.fn<(args: string[]) => Promise<string>>() }));
vi.mock('../src/core/autopilot/github.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/autopilot/github.js')>()),
  defaultGh: (args: string[]) => gh.run(args),
}));

const user = (login: string) => ({ login, type: 'User' });
const bot = (login: string) => ({ login, type: 'Bot' });
const QUEUE = bot('github-merge-queue');
const records: MergeRecord[] = [
  { number: 1, mergedAt: '2026-11-02T10:00:00Z', mergedBy: user('mason'), enqueuer: null },
  { number: 2, mergedAt: '2026-11-03T10:00:00Z', mergedBy: bot('ashlr-release[bot]'), enqueuer: null },
  { number: 3, mergedAt: '2026-11-04T10:00:00Z', mergedBy: QUEUE, enqueuer: bot('ashlr-release') },
  { number: 4, mergedAt: '2026-11-05T10:00:00Z', mergedBy: QUEUE, enqueuer: user('mason') },
  { number: 5, mergedAt: '2026-11-06T10:00:00Z', mergedBy: QUEUE, enqueuer: null },
  { number: 6, mergedAt: '2026-11-07T10:00:00Z', mergedBy: null, enqueuer: null },
  { number: 7, mergedAt: '2026-11-08T10:00:00Z', mergedBy: user('lane-bot-acct'), enqueuer: null },
];

const node = (r: MergeRecord) => ({
  number: r.number,
  mergedAt: r.mergedAt,
  mergedBy: r.mergedBy && { __typename: r.mergedBy.type, login: r.mergedBy.login },
  timelineItems: { nodes: r.enqueuer ? [{ enqueuer: { __typename: r.enqueuer.type, login: r.enqueuer.login } }] : [] },
});

/** Injected gh: serves `pages` by cursor; `hasNextPage` stays true while pages remain. */
function pagedGh(pages: MergeRecord[][]) {
  return async (args: string[]) => {
    if (args[0] === 'repo') return JSON.stringify({ nameWithOwner: 'ashlrai/phantom' });
    const cursor = args.find(a => a.startsWith('cursor='));
    const i = cursor ? Number(cursor.slice('cursor='.length)) : 0;
    return JSON.stringify({ data: { search: {
      pageInfo: { hasNextPage: i + 1 < pages.length, endCursor: String(i + 1) },
      nodes: [...pages[i]!.map(node), { notAPr: true }],
    } } });
  };
}

const LOADERS = { 'merge-identity': () => import('../src/cli/fleet-merge-identity.js') };

afterEach(() => { vi.restoreAllMocks(); gh.run.mockReset(); });

describe('classifyMerge', () => {
  it('credits a queue merge to its enqueuer, never the queue relay', () => {
    expect(classifyMerge(records[2]!)).toEqual({ number: 3, mergedAt: records[2]!.mergedAt, class: 'automation', actor: 'ashlr-release', via: 'queue-enqueuer' });
    expect(classifyMerge(records[3]!)).toMatchObject({ class: 'human', actor: 'mason', via: 'queue-enqueuer' });
  });
  it('classifies a direct Bot merge as automation and a User merge as human', () => {
    expect(classifyMerge(records[1]!)).toMatchObject({ class: 'automation', via: 'merged-by' });
    expect(classifyMerge(records[0]!)).toMatchObject({ class: 'human', via: 'merged-by' });
  });
  it('honors a named automation login case- and [bot]-insensitively', () => {
    expect(classifyMerge(records[6]!, ['Lane-Bot-Acct[bot]']).class).toBe('automation');
    expect(classifyMerge(records[6]!).class).toBe('human');
  });
  it('is unknown with a null actor when GitHub recorded no merger or no enqueuer', () => {
    expect(classifyMerge(records[4]!)).toMatchObject({ class: 'unknown', actor: null, via: 'none' });
    expect(classifyMerge(records[5]!)).toMatchObject({ class: 'unknown', actor: null, via: 'none' });
  });
});

describe('summarizeMerges window', () => {
  it('includes since and excludes until (half-open)', () => {
    const s = summarizeMerges(records, { repo: 'ashlrai/phantom', since: '2026-11-03T10:00:00Z', until: '2026-11-05T10:00:00Z' });
    expect(s.total).toBe(2);
    expect(s.counts).toEqual({ automation: 2, human: 0, unknown: 0 });
  });
  it('counts by class and actor across an open-ended window', () => {
    const s = summarizeMerges(records, { repo: 'ashlrai/phantom', since: '2026-11-01' });
    expect(s).toMatchObject({ total: 7, until: null, truncated: false, counts: { automation: 2, human: 3, unknown: 2 } });
    // Ties sort by login; `[bot]` and bare spellings of one actor share a row.
    expect(s.actors).toEqual([
      { login: 'ashlr-release[bot]', class: 'automation', count: 2 },
      { login: 'mason', class: 'human', count: 2 },
      { login: 'lane-bot-acct', class: 'human', count: 1 },
    ]);
  });
});

describe('readMerges pagination', () => {
  it('follows cursors across pages and skips non-PR nodes', async () => {
    const calls: string[][] = [];
    const runner = pagedGh([records.slice(0, 3), records.slice(3, 5), records.slice(5)]);
    const out = await readMerges('ashlrai/phantom', '2026-11-01', { gh: async (args) => { calls.push(args); return runner(args); } });
    expect(out.records.map(r => r.number)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(out.truncated).toBe(false);
    expect(calls).toHaveLength(3);
    expect(calls[0]).toContain('q=repo:ashlrai/phantom is:pr is:merged merged:>=2026-11-01');
  });
  it('stops at the page cap and reports truncation', async () => {
    const gh1 = vi.fn(pagedGh(Array.from({ length: 50 }, () => [records[0]!])));
    const out = await readMerges('ashlrai/phantom', '2026-11-01', { gh: gh1 });
    expect(gh1).toHaveBeenCalledTimes(10);
    expect(out).toMatchObject({ truncated: true });
    expect(out.records).toHaveLength(10);
  });
  it('rejects a malformed repo before any gh call', async () => {
    const runner = vi.fn(pagedGh([records]));
    await expect(readMerges('not a repo', '2026-11-01', { gh: runner })).rejects.toThrow(/Invalid repository/);
    expect(runner).not.toHaveBeenCalled();
  });
});

describe('merge-identity command', () => {
  const capture = () => {
    const out: string[] = [], err: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((m: unknown) => { out.push(String(m)); });
    vi.spyOn(console, 'error').mockImplementation((m: unknown) => { err.push(String(m)); });
    return { out, err };
  };

  it('returns the JSON summary through convention dispatch, honoring --automation-login', async () => {
    gh.run.mockImplementation(pagedGh([records.slice(0, 4), records.slice(4)]));
    const { out } = capture();
    const code = await cmdFleet(['merge-identity', '--since', '2026-11-01', '--until', '2026-11-09', '--repo', 'ashlrai/phantom', '--automation-login', 'lane-bot-acct', '--json'], LOADERS);
    expect(code).toBe(0);
    expect(JSON.parse(out.join('\n'))).toMatchObject({ v: 1, repo: 'ashlrai/phantom', total: 7, counts: { automation: 3, human: 2, unknown: 2 }, truncated: false });
  });
  it('prints help and rejects bad usage with zero network calls', async () => {
    capture();
    expect(await cmdFleet(['merge-identity', '--help'], LOADERS)).toBe(0);
    expect(await cmdFleetMergeIdentity(['--help'], { gh: gh.run })).toBe(0);
    for (const args of [[], ['--since', 'yesterday'], ['--since', '2026-11-01', '--bogus'], ['--since', '2026-11-01', '--until', 'x']]) {
      expect(await cmdFleet(['merge-identity', ...args], LOADERS)).toBe(2);
    }
    expect(gh.run).not.toHaveBeenCalled();
  });
});
