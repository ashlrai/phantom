import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import { cmdFleetQueueLatency } from '../src/cli/fleet-queue-latency.js';
import { liveQueueSummary, parseLiveRepos } from '../src/core/fleet/queue-latency-live.js';

const recorded = JSON.parse(readFileSync(new URL('./fixtures/queue-latency-live-gh.json', import.meta.url), 'utf8')) as Record<string, unknown[]>;
const now = Date.parse('2026-11-03T12:00:00Z');
const calls: string[][] = [];
const gh = async (args: string[]) => {
  calls.push(args);
  if (args[0] === '--version') return { ok: true, stdout: 'gh', stderr: '' };
  const rows = recorded[args[args.indexOf('--repo') + 1]!];
  return rows ? { ok: true, stdout: JSON.stringify(rows), stderr: '' } : { ok: false, stdout: '', stderr: '' };
};

async function run(args: string[], extra = {}) {
  let out = '';
  const code = await cmdFleetQueueLatency(args, { gh, now, output: t => { out = t; }, ...extra });
  return { code, out };
}

it('counts queued, conflicting, behind and merged PRs and summarises in plain words', async () => {
  const { code, out } = await run(['--live', '--json', '--repos', 'phantom,lexicon']);
  const r = JSON.parse(out);
  expect(code).toBe(0);
  expect(r.live.counts).toEqual({ open: 4, waitingOnChecks: 1, conflicting: 2, behind: 1 });
  expect(r.prs).toHaveLength(4);
  expect(r.live.summary).toBe('4 open PRs: 1 waiting on checks, 2 conflicting (0 recuts planned), 1 behind');
  expect(r.live.recover).toBeNull();
  expect(calls.some(c => c[0] === 'pr' && c.includes('merge'))).toBe(false);
});

it('plans recuts only for conflicting phantom heads and never merges on a dry run', async () => {
  const inspect = async () => [11, 12, 13].map(n => ({ number: n, title: `bridge: RQ-PHX-T${n}`, head: String(n % 10).repeat(40), base: 'master',
    class: 'needs-recut' as const, changedPaths: ['a.ts'], landedPaths: [], remainingPaths: ['a.ts'] }));
  const view = { number: 12, title: 'bridge: RQ-PHX-T12', state: 'OPEN', headRefOid: '2'.repeat(40), baseRefName: 'master', isDraft: false, mergeStateStatus: 'DIRTY', autoMergeRequest: null };
  const planGh = async (a: string[]) => {
    calls.push(a);
    if (a[0] === 'pr' && a[1] === 'view') return { ok: true, stdout: JSON.stringify(view), stderr: '' };
    if (a[0] === 'pr' && a[1] === 'list' && a.includes('--state') && a[a.indexOf('--state') + 1] === 'all') return { ok: true, stdout: '[]', stderr: '' };
    return gh(a);
  };
  calls.length = 0;
  const { code, out } = await run(['--live', '--json', '--repos', 'phantom,lexicon', '--recover'],
    { gh: planGh, recover: { inspect, exists: async () => false, reserve: async () => true } });
  const r = JSON.parse(out);
  expect(code).toBe(0);
  expect(r.live.recover).toEqual({ dryRun: true, ok: true, rows: [{ pr: 12, action: 'queue-recut' }] });
  expect(r.live.summary).toBe('4 open PRs: 1 waiting on checks, 2 conflicting (1 recut planned), 1 behind');
  expect(calls.some(c => c.includes('merge'))).toBe(false);
});

it('exits 2 with a plain message when gh is unavailable or arguments are wrong', async () => {
  const err = vi.spyOn(console, 'error').mockImplementation(() => {});
  const none = async () => ({ ok: false, stdout: '', stderr: '' });
  expect((await run(['--live'], { gh: none })).code).toBe(2);
  expect(String(err.mock.calls[0]![0])).toMatch(/GitHub CLI \(gh\)/);
  expect((await run(['--recover'])).code).toBe(2);
  expect((await run(['--live', '--apply'])).code).toBe(2);
  expect((await run(['--live', '--repos', 'bad name'])).code).toBe(2);
  err.mockRestore();
});

it('helpers: repo parsing and singular wording', () => {
  expect(parseLiveRepos('phantom, a/b')).toEqual(['ashlrai/phantom', 'a/b']);
  expect(parseLiveRepos('')).toBeNull();
  expect(liveQueueSummary({ open: 1, waitingOnChecks: 0, conflicting: 1, behind: 0 }, 1)).toBe('1 open PR: 0 waiting on checks, 1 conflicting (1 recut planned), 0 behind');
});
