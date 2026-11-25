import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Gh } from '../src/core/autopilot/github.js';
import { cmdPublish } from '../src/cli/publish.js';
import { scanPublishStrands, sweepPublishResumes, PUBLISH_RESUME_RETRY_MS } from '../src/core/fleet/publish-resume-sweep.js';

const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(d => rm(d, { recursive: true, force: true }))); });

const NOW = Date.UTC(2026, 10, 19, 12);
const SHA = 'a'.repeat(40);

async function runsDir(logs: Record<string, string>) {
  const dir = await mkdtemp(join(tmpdir(), 'publish-sweep-')); dirs.push(dir);
  for (const [job, body] of Object.entries(logs)) await writeFile(join(dir, `${job}.publish`), body);
  return dir;
}
async function aged(dir: string, job: string, hours: number) {
  const t = new Date(NOW - hours * 3600_000); await utimes(join(dir, `${job}.publish`), t, t);
}

const hint = (job: string, repo = 'phantom') =>
  `remote: Create a pull request for 'codex-bridge/${job}' on GitHub by visiting:\nremote:      https://github.com/masonwyatt23/${repo}/pull/new/codex-bridge/${job}\nremote:\n`;
const abortPr = (job: string) => `${hint(job)}RESULT ABORT pr\n`;
const published = (job: string) => `${hint(job)}RESULT PR https://github.com/ashlrai/phantom/pull/9\n`;

interface World {
  refs?: Array<{ ref: string; object: { sha: string } }>;
  prs?: Array<Record<string, unknown>>;
  compare?: Record<string, unknown>;
  failReads?: boolean;
}
/** A fake GitHub behind the `gh` wrapper; records every call. `failReads` makes every read look like a 503. */
function fakeGh(w: World) {
  const calls: string[][] = [];
  const gh: Gh = async (args) => {
    calls.push(args);
    const line = args.join(' ');
    if (w.failReads) throw new Error('gh api: HTTP 503 Service Unavailable');
    if (args[0] === 'pr') return '';
    if (args.includes('POST')) return JSON.stringify({ number: 42 });
    if (line.endsWith(' user')) return JSON.stringify({ login: 'mine' });
    if (line.includes('/git/matching-refs/')) return JSON.stringify(w.refs ?? []);
    if (line.includes('/pulls?')) return JSON.stringify(w.prs ?? []);
    if (line.includes('/compare/')) return JSON.stringify(w.compare ?? {});
    if (line.endsWith('repos/ashlrai/phantom')) return JSON.stringify({ default_branch: 'master' });
    throw new Error(`unexpected call: ${line}`);
  };
  return { gh, calls };
}
const onFork = (job: string) => ({ refs: [{ ref: `refs/heads/codex-bridge/${job}`, object: { sha: SHA } }] });
const ahead = { ahead_by: 1, files: [{ filename: 'a.ts' }], commits: [{ commit: { message: 'Add the thing\n\nWhy it matters.' } }] };
const retry = { sleep: async () => {} };

describe('scanPublishStrands', () => {
  it('finds abort-after-push and killed publishes; skips published, pre-push, excluded and too-old logs', async () => {
    const dir = await runsDir({
      'RQ-PR': abortPr('RQ-PR'),
      'RQ-KILLED': hint('RQ-KILLED'),
      'RQ-DONE': published('RQ-DONE'),
      'RQ-FETCH': `${hint('RQ-FETCH')}RESULT ABORT default-fetch\n`,
      'RQ-IM': `${hint('RQ-IM')}RESULT ABORT integrated-receipt-consume\n`,
      'RQ-OLD': abortPr('RQ-OLD'),
      'RQ-PRE': 'fatal: nope\nRESULT ABORT secret-shape\n',
      'RQ-HOLD': `${hint('RQ-HOLD')}RESULT HOLD needs-human\n`,
      'RQ-NOLINK': `remote: Create a pull request for 'codex-bridge/RQ-NOLINK' on GitHub by visiting:\nRESULT ABORT pr\n`,
      'RQ-BADREPO': abortPr('RQ-BADREPO').replace('/phantom/', '/notallowed/'),
    });
    await aged(dir, 'RQ-PR', 2); await aged(dir, 'RQ-KILLED', 5); await aged(dir, 'RQ-DONE', 1);
    await aged(dir, 'RQ-FETCH', 3); await aged(dir, 'RQ-IM', 4); await aged(dir, 'RQ-OLD', 72);
    await aged(dir, 'RQ-PRE', 2); await aged(dir, 'RQ-HOLD', 2); await aged(dir, 'RQ-NOLINK', 2); await aged(dir, 'RQ-BADREPO', 2);
    const scan = await scanPublishStrands(dir, { now: NOW });
    expect(scan.scanned).toBe(10);
    expect(scan.published).toBe(1);
    expect(scan.unreadable).toEqual([]);
    // Oldest strand first: the killed publish (5h) then the pr abort (2h).
    expect(scan.strands).toEqual([
      { job: 'RQ-KILLED', branch: 'codex-bridge/RQ-KILLED', repo: 'phantom', reason: 'no-result', ageHours: 5 },
      { job: 'RQ-PR', branch: 'codex-bridge/RQ-PR', repo: 'phantom', reason: 'pr', ageHours: 2 },
    ]);
    expect(scan.skipped).toEqual([
      { job: 'RQ-BADREPO', why: 'repo-not-allowlisted' },
      { job: 'RQ-FETCH', why: 'fetch-race-requeue' },
      { job: 'RQ-HOLD', why: 'other-result' },
      { job: 'RQ-IM', why: 'integrated-mode' },
      { job: 'RQ-NOLINK', why: 'no-push-link' },
      { job: 'RQ-OLD', why: 'too-old' },
    ]);
  });

  it('marks unreadable logs unknown instead of clean', async () => {
    const dir = await runsDir({ 'RQ-PR': abortPr('RQ-PR') });
    await writeFile(join(dir, 'RQ-BIG.publish'), 'x'.repeat(2 * 1024 * 1024 + 1));
    const scan = await scanPublishStrands(dir, { now: NOW });
    expect(scan.unreadable).toEqual(['RQ-BIG']);
    expect(scan.strands.map((s) => s.job)).toEqual(['RQ-PR']);
  });
});

describe('sweepPublishResumes', () => {
  it('dry run plans without any GitHub call or state write', async () => {
    const dir = await runsDir({ 'RQ-PR': abortPr('RQ-PR'), 'RQ-KILLED': hint('RQ-KILLED') });
    await aged(dir, 'RQ-PR', 2); await aged(dir, 'RQ-KILLED', 5);
    const { gh, calls } = fakeGh({ failReads: true });
    const r = await sweepPublishResumes({ runsDir: dir, now: () => NOW, gh, retry });
    expect(r).toMatchObject({ schema: 'publish.resume-sweep.v1', apply: false, status: 'ok', candidates: 2, stateWrite: 'skipped' });
    expect(r.planned.map((p) => p.job)).toEqual(['RQ-KILLED', 'RQ-PR']);
    expect(r.resumed).toEqual([]);
    expect(calls).toEqual([]);
    await expect(readFile(join(dir, 'queue', 'publish-resume.json'), 'utf8')).rejects.toThrow();
  });

  it('apply opens the PR but never arms auto-merge, and records the outcome', async () => {
    const dir = await runsDir({ 'RQ-PR': abortPr('RQ-PR') });
    await aged(dir, 'RQ-PR', 2);
    const { gh, calls } = fakeGh({ ...onFork('RQ-PR'), compare: ahead });
    const r = await sweepPublishResumes({ runsDir: dir, apply: true, now: () => NOW, gh, retry });
    expect(r.resumed).toEqual([{ job: 'RQ-PR', branch: 'codex-bridge/RQ-PR', repo: 'phantom', status: 'opened', pr_url: 'https://github.com/ashlrai/phantom/pull/42' }]);
    expect(r.stateWrite).toBe('ok');
    expect(calls.some((c) => c.includes('POST'))).toBe(true);
    expect(calls.some((c) => c[0] === 'pr')).toBe(false);
    const state = JSON.parse(await readFile(join(dir, 'queue', 'publish-resume.json'), 'utf8'));
    expect(state.branches['phantom:codex-bridge/RQ-PR']).toMatchObject({ status: 'opened' });
    // A second pass does not re-attempt a terminal outcome.
    const again = await sweepPublishResumes({ runsDir: dir, apply: true, now: () => NOW, gh, retry });
    expect(again.resumed).toEqual([]);
    expect(again.skipped).toContainEqual({ job: 'RQ-PR', why: 'already-recorded' });
  });

  it('bounds attempts per pass, oldest first, and defers the rest', async () => {
    const dir = await runsDir({
      'RQ-1': abortPr('RQ-1'), 'RQ-2': abortPr('RQ-2'), 'RQ-3': abortPr('RQ-3'), 'RQ-4': abortPr('RQ-4'), 'RQ-5': abortPr('RQ-5'),
    });
    for (const [i, job] of ['RQ-1', 'RQ-2', 'RQ-3', 'RQ-4', 'RQ-5'].entries()) await aged(dir, job, 10 - i);
    // Give every branch a fork ref + empty PR list + ahead compare so each resume opens.
    const refs = ['RQ-1', 'RQ-2', 'RQ-3', 'RQ-4', 'RQ-5'].map((j) => ({ ref: `refs/heads/codex-bridge/${j}`, object: { sha: SHA } }));
    const { gh } = fakeGh({ refs, compare: ahead });
    const r = await sweepPublishResumes({ runsDir: dir, apply: true, limit: 2, now: () => NOW, gh, retry });
    // Oldest strand first: RQ-1 (10h) and RQ-2 (9h) resume; the rest wait for a later pass.
    expect(r.resumed.map((o) => o.job)).toEqual(['RQ-1', 'RQ-2']);
    expect(r.deferred).toEqual([
      { job: 'RQ-3', why: 'over-limit' }, { job: 'RQ-4', why: 'over-limit' }, { job: 'RQ-5', why: 'over-limit' },
    ]);
  });

  it('a deferred outcome backs off instead of retrying every pass', async () => {
    const dir = await runsDir({ 'RQ-PR': abortPr('RQ-PR') });
    await aged(dir, 'RQ-PR', 2);
    const down = fakeGh({ failReads: true });
    const first = await sweepPublishResumes({ runsDir: dir, apply: true, now: () => NOW, gh: down.gh, retry });
    expect(first.resumed[0]).toMatchObject({ job: 'RQ-PR', status: 'deferred' });
    const callsAfterFirst = down.calls.length;
    const second = await sweepPublishResumes({ runsDir: dir, apply: true, now: () => NOW + 60_000, gh: down.gh, retry });
    expect(second.resumed).toEqual([]);
    expect(second.deferred).toContainEqual({ job: 'RQ-PR', why: 'backoff' });
    expect(down.calls.length).toBe(callsAfterFirst);
    const later = await sweepPublishResumes({ runsDir: dir, apply: true, now: () => NOW + PUBLISH_RESUME_RETRY_MS + 1, gh: down.gh, retry });
    expect(later.resumed).toHaveLength(1);
  });

  it('a thrown resume is recorded as error and never stops the sweep', async () => {
    const dir = await runsDir({ 'RQ-A': abortPr('RQ-A'), 'RQ-B': abortPr('RQ-B') });
    await aged(dir, 'RQ-A', 3); await aged(dir, 'RQ-B', 2);
    const { gh } = fakeGh({ refs: [{ ref: 'refs/heads/codex-bridge/RQ-A', object: { sha: SHA } }], compare: ahead });
    // RQ-B has no fork ref → resumePublish answers 'missing', not a throw; force a throw via an unexpected call instead.
    const throwing: Gh = async (args) => {
      if (args.join(' ').includes('codex-bridge/RQ-B')) throw new Error('gh api: unexpected');
      return gh(args);
    };
    const r = await sweepPublishResumes({ runsDir: dir, apply: true, now: () => NOW, gh: throwing, retry });
    expect(r.resumed.map((o) => [o.job, o.status])).toEqual([['RQ-A', 'opened'], ['RQ-B', 'error']]);
    expect(r.resumed[1]!.error).toContain('unexpected');
  });
});

describe('cmdPublish sweep', () => {
  it('prints the JSON report and exits 1 on unreadable logs or a missing runs dir, 2 on bad usage', async () => {
    const dir = await runsDir({ 'RQ-BIG': 'x'.repeat(2 * 1024 * 1024 + 1) });
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdPublish(['sweep', '--runs-dir', dir, '--json'])).toBe(1);
    expect(JSON.parse(log.mock.calls[0]![0])).toMatchObject({ schema: 'publish.resume-sweep.v1', status: 'unknown', unreadable: ['RQ-BIG'] });
    expect(await cmdPublish(['sweep', '--runs-dir', join(tmpdir(), 'no-such-publish-sweep-dir'), '--json'])).toBe(1);
    expect(JSON.parse(log.mock.calls[1]![0])).toMatchObject({ status: 'unknown', reason: 'Publish directory is unreadable.' });
    expect(await cmdPublish(['sweep', '--runs-dir', dir, '--limit', '0'])).toBe(2);
    expect(await cmdPublish(['sweep', '--bogus'])).toBe(2);
    expect(err).toHaveBeenCalled();
  });
});
