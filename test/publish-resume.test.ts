import { describe, expect, it, vi } from 'vitest';
import type { Gh } from '../src/core/autopilot/github.js';
import { listPublishOrphans, prTitle, resolveBranch, resumePublish } from '../src/core/publish/resume.js';
import { cmdPublish } from '../src/cli/publish.js';

const SHA = 'a'.repeat(40);
const BRANCH = 'codex-bridge/RQ-DEMO';

interface World {
  refs?: Array<{ ref: string; object: { sha: string } }>;
  prs?: Array<Record<string, unknown>>;
  compare?: Record<string, unknown>;
  mergeFails?: boolean;
  commitDates?: Record<string, string>;
}

/** A fake GitHub behind the `gh` wrapper: answers by URL, records every call. */
function fakeGh(w: World) {
  const calls: string[][] = [];
  const gh: Gh = async (args) => {
    calls.push(args);
    const line = args.join(' ');
    if (args[0] === 'pr') { if (w.mergeFails) throw new Error('gh pr merge: not allowed'); return ''; }
    if (args.includes('POST')) return JSON.stringify({ number: 42 });
    if (line.endsWith(' user')) return JSON.stringify({ login: 'mine' });
    if (line.includes('/git/matching-refs/')) return JSON.stringify(w.refs ?? []);
    if (line.includes('/pulls?')) return JSON.stringify(w.prs ?? []);
    if (line.includes('/compare/')) return JSON.stringify(w.compare ?? {});
    const commit = line.match(/\/commits\/([0-9a-f]{40})$/);
    if (commit) return JSON.stringify({ commit: { committer: { date: w.commitDates?.[commit[1]!] ?? '2026-11-19T10:00:00Z' } } });
    if (line.endsWith('repos/ashlrai/phantom')) return JSON.stringify({ default_branch: 'master' });
    throw new Error(`unexpected call: ${line}`);
  };
  return { gh, calls };
}
const onFork = { refs: [{ ref: `refs/heads/${BRANCH}`, object: { sha: SHA } }] };
const ahead = { ahead_by: 1, files: [{ filename: 'a.ts' }], commits: [{ commit: { message: 'Add the thing\n\nWhy it matters.' } }] };
const pr = (over: Record<string, unknown>) => ({ number: 7, html_url: 'https://github.com/ashlrai/phantom/pull/7', state: 'open', merged_at: null, head: { ref: BRANCH }, ...over });

describe('phm publish resume', () => {
  it('missing: branch is not on the fork', async () => {
    const { gh, calls } = fakeGh({});
    expect(await resumePublish({ branch: BRANCH }, gh)).toMatchObject({ schema: 'publish.resume.v1', status: 'missing', pr_url: null });
    expect(calls.some((c) => c.includes('POST'))).toBe(false);
  });
  it('already-open: returns the open PR and opens nothing', async () => {
    const { gh, calls } = fakeGh({ ...onFork, prs: [pr({})] });
    expect(await resumePublish({ branch: BRANCH }, gh)).toMatchObject({ status: 'already-open', pr_url: 'https://github.com/ashlrai/phantom/pull/7' });
    expect(calls.some((c) => c.includes('POST'))).toBe(false);
  });
  it('already-merged: a merged PR wins', async () => {
    const { gh } = fakeGh({ ...onFork, prs: [pr({ state: 'closed', merged_at: '2026-11-19T11:00:00Z' })] });
    expect(await resumePublish({ branch: BRANCH }, gh)).toMatchObject({ status: 'already-merged', pr_url: 'https://github.com/ashlrai/phantom/pull/7' });
  });
  it('already-on-main: no commits ahead, or ahead with no file changes', async () => {
    for (const compare of [{ ahead_by: 0, files: [], commits: [] }, { ahead_by: 2, files: [], commits: [] }]) {
      const { gh, calls } = fakeGh({ ...onFork, compare });
      expect(await resumePublish({ branch: BRANCH }, gh)).toMatchObject({ status: 'already-on-main', pr_url: null });
      expect(calls.some((c) => c.includes('POST'))).toBe(false);
    }
  });
  it('opened: bridge title, body, merge-queue auto-merge pinned to the head, never admin', async () => {
    const { gh, calls } = fakeGh({ ...onFork, compare: ahead });
    const r = await resumePublish({ branch: 'RQ-DEMO' }, gh);
    expect(r).toMatchObject({ status: 'opened', pr_url: 'https://github.com/ashlrai/phantom/pull/42', repo: 'ashlrai/phantom', auto_merge: { on: true } });
    const create = calls.find((c) => c.includes('POST'))!;
    expect(create).toContain('title=bridge(RQ-DEMO): Add the thing');
    expect(create).toContain(`head=mine:${BRANCH}`);
    expect(create).toContain('base=master');
    expect(create.find((a) => a.startsWith('body='))).toContain('Why it matters.');
    const merge = calls.find((c) => c[0] === 'pr')!;
    expect(merge).toEqual(['pr', 'merge', '42', '--repo', 'ashlrai/phantom', '--squash', '--auto', '--match-head-commit', SHA]);
    expect(calls.flat().join(' ')).not.toContain('--admin');
  });
  it('opened: a refused auto-merge is reported, the PR still counts', async () => {
    const { gh } = fakeGh({ ...onFork, compare: ahead, mergeFails: true });
    const r = await resumePublish({ branch: BRANCH }, gh);
    expect(r.status).toBe('opened');
    expect(r.auto_merge?.on).toBe(false);
  });
  it('a closed, unmerged PR does not block a fresh one', async () => {
    const { gh } = fakeGh({ ...onFork, prs: [pr({ state: 'closed' })], compare: ahead });
    expect((await resumePublish({ branch: BRANCH }, gh)).status).toBe('opened');
  });
  it('refuses branches outside codex-bridge/ and repos outside the allowlist', async () => {
    const { gh } = fakeGh({});
    await expect(resumePublish({ branch: 'feature/x' }, gh)).rejects.toThrow(/codex-bridge/);
    await expect(resumePublish({ branch: BRANCH, repo: 'other-repo' }, gh)).rejects.toThrow(/not one of/);
    expect(resolveBranch('RQ-X')).toBe('codex-bridge/RQ-X');
    expect(prTitle(BRANCH, ['bridge(RQ-DEMO): already shaped'])).toBe('bridge(RQ-DEMO): already shaped');
  });
});

describe('phm publish orphans', () => {
  it('lists recent fork branches with no PR, newest first', async () => {
    const other = 'b'.repeat(40), old = 'c'.repeat(40), covered = 'd'.repeat(40);
    const refs = [
      { ref: 'refs/heads/codex-bridge/RQ-OLD', object: { sha: old } },
      { ref: 'refs/heads/codex-bridge/RQ-HAS-PR', object: { sha: covered } },
      { ref: `refs/heads/${BRANCH}`, object: { sha: SHA } },
      { ref: 'refs/heads/codex-bridge/RQ-NEWER', object: { sha: other } },
    ];
    const base = fakeGh({ refs, commitDates: { [SHA]: '2026-11-19T10:00:00Z', [other]: '2026-11-19T11:00:00Z', [old]: '2026-11-10T00:00:00Z', [covered]: '2026-11-19T09:00:00Z' } });
    const gh: Gh = async (args) => {
      const line = args.join(' ');
      if (line.includes('/pulls?') && line.includes('RQ-HAS-PR')) return JSON.stringify([pr({ head: { ref: 'codex-bridge/RQ-HAS-PR' } })]);
      return base.gh(args);
    };
    const r = await listPublishOrphans({ now: () => new Date('2026-11-19T12:00:00Z') }, gh);
    expect(r.schema).toBe('publish.orphans.v1');
    expect(r.orphans.map((o) => o.branch)).toEqual(['codex-bridge/RQ-NEWER', BRANCH]);
    expect(r.orphans[0]).toMatchObject({ age_hours: 1, sha: other });
  });
});

describe('cmdPublish', () => {
  it('prints schema-tagged JSON and exits 1 only for a missing branch', async () => {
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdPublish(['resume', '--branch', BRANCH, '--json'], fakeGh({}).gh)).toBe(1);
    expect(JSON.parse(out.mock.calls[0]![0] as string)).toMatchObject({ schema: 'publish.resume.v1', status: 'missing', pr_url: null });
    expect(await cmdPublish(['orphans', '--json'], fakeGh({}).gh)).toBe(0);
    expect(JSON.parse(out.mock.calls[1]![0] as string)).toMatchObject({ schema: 'publish.orphans.v1', orphans: [] });
    out.mockRestore();
  });
  it('rejects bad usage with exit 2', async () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(await cmdPublish(['resume'])).toBe(2);
    expect(await cmdPublish(['orphans', '--branch', 'x'])).toBe(2);
    expect(await cmdPublish(['bogus'])).toBe(2);
    err.mockRestore();
  });
});
