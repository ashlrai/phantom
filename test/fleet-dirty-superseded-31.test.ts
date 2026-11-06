/**
 * RQ-PHX-DIRTYSUPERSEDED31 — `--superseded` mode of scripts/fleet-dirty-triage.ts.
 *
 * With 271 open PRs and publish throttled over 250, 63 of today's DIRTY PRs
 * are mostly superseded by content: the branch can't merge cleanly, yet every
 * file it touches already equals master byte-for-byte. `--superseded` answers
 * that with plain `gh` (no Locus pin): list open DIRTY PRs, compare each
 * changed file's head content against the base tip, and emit
 * `{number, verdict, evidence}` JSON. It must never close, comment or push —
 * every call is a GET.
 *
 * Fixtures only: the `gh` dependency is injected; no network, no locus.
 */
import { describe, expect, it } from 'vitest';

import {
  fleetDirtySuperseded,
  pullChangedFiles,
  supersededVerdict,
  type CompareWithFiles,
  type DirtyPull,
  type PullFile,
} from '../scripts/fleet-dirty-triage.ts';

const NOW = Date.parse('2026-10-31T12:00:00Z');
const DAY = 86_400_000;
const REPO = 'ashlrai/phantom';
const BASE = 'f'.repeat(40); // current master tip
const oid = (n: number) => n.toString(16).padStart(40, '0');
const iso = (daysAgo: number) => new Date(NOW - daysAgo * DAY).toISOString();

const pull = (number: number, extra: Partial<DirtyPull> = {}): DirtyPull => ({
  number, title: `PR ${number}`, url: `https://example.invalid/pull/${number}`,
  state: 'OPEN', isDraft: false, isCrossRepository: false, autoMergeRequest: null,
  mergeStateStatus: 'DIRTY', headRefOid: oid(number),
  headRepository: { nameWithOwner: REPO },
  baseRefName: 'master', baseRefOid: BASE, updatedAt: iso(1), ...extra,
});

interface RepoData {
  prs: DirtyPull[];
  compares?: Record<string, CompareWithFiles>;
  files?: Record<number, PullFile[]>;
}
function fixture(data: RepoData, opts: {
  failCompare?: Record<string, string>; failFiles?: Record<number, string>;
} = {}) {
  const calls: string[][] = [];
  const gh = async (args: string[]) => {
    calls.push(args);
    if (args[0] === 'pr' && args[1] === 'list') return JSON.stringify(data.prs ?? []);
    if (args[0] === 'api') {
      const path = args.find(a => a.startsWith('repos/'))!;
      if (path === 'repos/{owner}/{repo}') return JSON.stringify({ full_name: REPO });
      if (path.includes('/compare/')) {
        const head = path.split('..')[1]!;
        if (opts.failCompare?.[head])
          throw Object.assign(new Error('gh api failed'), { stderr: opts.failCompare[head] });
        const cmp = data.compares?.[head];
        if (!cmp) throw Object.assign(new Error('gh api failed'), { stderr: 'sensitive-404-body' });
        return JSON.stringify(cmp);
      }
      if (path.includes('/pulls/') && path.endsWith('/files?per_page=100')) {
        const n = Number(path.split('/')[4]);
        if (opts.failFiles?.[n])
          throw Object.assign(new Error('gh api failed'), { stderr: opts.failFiles[n] });
        return (data.files?.[n] ?? []).map(f => JSON.stringify(f)).join('\n'); // --jq '.[]' NDJSON
      }
    }
    throw new Error(`unexpected call: ${args.join(' ')}`);
  };
  return { calls, deps: { gh, now: () => NOW } };
}

const expectReadOnly = (calls: string[][]) => {
  for (const c of calls) {
    expect(['pr', 'api']).toContain(c[0]);
    if (c[0] === 'pr') expect(c[1]).toBe('list');
    if (c[0] === 'api') {
      const m = c.indexOf('--method');
      expect(m === -1 || c[m + 1] === 'GET').toBe(true);
      for (const a of c) expect(['-f', '-F', '--field', '--input']).not.toContain(a);
      expect(c.some(a => a.startsWith('repos/'))).toBe(true);
    }
    for (const verb of ['close', 'comment', 'merge', 'push', 'edit', 'delete', 'review'])
      expect(c).not.toContain(verb);
  }
};

describe('fleet-dirty-superseded-31: content-level verdicts', () => {
  it('classifies superseded, partial, diverged (deleted on base) and unreadable DIRTY PRs', async () => {
    const prs: DirtyPull[] = [
      pull(101), // superseded: every touched file matches; master moved elsewhere
      pull(102), // partial: two of three touched files match
      pull(103), // diverged: the only touched file is deleted on master
      pull(104), // superseded: PR deletes a file master already deleted
      pull(105), // unreadable: file list fetch fails
      pull(106, { headRepository: null }), // unreadable: fork gone, no calls needed
      pull(107), // unreadable: compare fetch fails
      pull(108, { mergeStateStatus: 'CLEAN' }),
      pull(109, { state: 'CLOSED' }),
    ];
    const files: RepoData['files'] = {
      101: [{ filename: 'src/a.ts', status: 'modified' }, { filename: 'docs/b.md', status: 'added' }],
      102: [{ filename: 'src/a.ts', status: 'modified' }, { filename: 'src/b.ts', status: 'modified' }, { filename: 'src/c.ts', status: 'added' }],
      103: [{ filename: 'docs/gone.md', status: 'modified' }],
      104: [{ filename: 'docs/old.md', status: 'removed' }],
      105: [{ filename: 'src/x.ts', status: 'modified' }],
      107: [{ filename: 'src/y.ts', status: 'modified' }],
    };
    const compares: RepoData['compares'] = {
      [oid(101)]: { status: 'diverged', ahead_by: 2, behind_by: 5, files: [{ filename: 'src/unrelated.ts', status: 'modified' }] },
      [oid(102)]: { status: 'diverged', ahead_by: 3, behind_by: 4, files: [{ filename: 'src/b.ts', status: 'modified' }, { filename: 'src/unrelated.ts', status: 'modified' }] },
      [oid(103)]: { status: 'diverged', ahead_by: 1, behind_by: 8, files: [{ filename: 'docs/gone.md', status: 'added' }] },
      [oid(104)]: { status: 'diverged', ahead_by: 1, behind_by: 2, files: [{ filename: 'src/elsewhere.ts', status: 'modified' }] },
      [oid(105)]: { status: 'diverged', ahead_by: 1, behind_by: 1, files: [{ filename: 'src/x.ts', status: 'modified' }] },
    };
    const f = fixture({ prs, compares, files }, { failCompare: { [oid(107)]: 'sensitive-token' }, failFiles: { 105: 'sensitive-files' } });
    const report = await fleetDirtySuperseded([], f.deps);

    const repo = report.repos[0]!;
    expect(repo.repo).toBe(REPO);
    expect(repo.scanned).toBe(9);
    expect(repo.dirty).toBe(7);
    expect(repo.counts).toEqual({ superseded: 2, partial: 1, diverged: 1, unreadable: 3 });
    expect(report.counts).toEqual({ superseded: 2, partial: 1, diverged: 1, unreadable: 3 });
    expect(report.mode).toBe('superseded');

    const byNumber = new Map(repo.prs.map(p => [p.number, p]));
    // superseded: both PR-touched paths match the base tip; master's own churn is ignored
    expect(byNumber.get(101)?.verdict).toBe('superseded');
    expect(byNumber.get(101)?.evidence.matched).toEqual(['src/a.ts', 'docs/b.md']);
    expect(byNumber.get(101)?.evidence.differing).toEqual([]);
    expect(byNumber.get(101)?.evidence.changedFiles).toBe(2);
    // partial: src/b.ts still differs; the rest already match
    expect(byNumber.get(102)?.verdict).toBe('partial');
    expect(byNumber.get(102)?.evidence.matched).toEqual(['src/a.ts', 'src/c.ts']);
    expect(byNumber.get(102)?.evidence.differing).toEqual([{ path: 'src/b.ts', status: 'modified' }]);
    // diverged: docs/gone.md exists at the head but is deleted on master
    expect(byNumber.get(103)?.verdict).toBe('diverged');
    expect(byNumber.get(103)?.evidence.matched).toEqual([]);
    expect(byNumber.get(103)?.evidence.differing).toEqual([{ path: 'docs/gone.md', status: 'added' }]);
    // superseded: deleting a file master already deleted is a no-op at head
    expect(byNumber.get(104)?.verdict).toBe('superseded');
    expect(byNumber.get(104)?.evidence.matched).toEqual(['docs/old.md']);
    // unreadable verdicts carry a stage note, never stderr text
    expect(byNumber.get(105)?.verdict).toBe('unreadable');
    expect(byNumber.get(105)?.evidence.note).toBe('files unreadable');
    expect(byNumber.get(106)?.verdict).toBe('unreadable');
    expect(byNumber.get(106)?.evidence.note).toBe('head unreadable');
    expect(byNumber.get(107)?.verdict).toBe('unreadable');
    expect(byNumber.get(107)?.evidence.note).toBe('compare unreadable');
    // sorted superseded-first, then partial, diverged, unreadable; number breaks ties
    expect(repo.prs.map(p => p.number)).toEqual([101, 104, 102, 103, 105, 106, 107]);
    expect(JSON.stringify(report)).not.toContain('sensitive');
    expectReadOnly(f.calls);
  });

  it('PRs with deleted or missing heads need no API calls at all', async () => {
    const f = fixture({
      prs: [pull(201, { headRepository: null }), pull(202, { headRefOid: 'not-a-sha' })],
    });
    const report = await fleetDirtySuperseded([], f.deps);
    expect(report.repos[0]!.prs.map(p => [p.number, p.verdict]))
      .toEqual([[201, 'unreadable'], [202, 'unreadable']]);
    expect(f.calls.filter(c => c[0] === 'api')).toHaveLength(1); // repo discovery only
  });

  it('a truncated compare file list is unreadable, never a false superseded', async () => {
    const many = Array.from({ length: 300 }, (_, i) => ({ filename: `src/f${i}.ts`, status: 'modified' }));
    const f = fixture({
      prs: [pull(301)],
      compares: { [oid(301)]: { status: 'diverged', ahead_by: 5, behind_by: 5, files: many } },
      files: { 301: [{ filename: 'src/f0.ts', status: 'modified' }] },
    });
    const repo = (await fleetDirtySuperseded([], f.deps)).repos[0]!;
    expect(repo.prs[0]!.verdict).toBe('unreadable');
    expect(repo.prs[0]!.evidence.note).toContain('capped');
  });

  it('identical trees supersede without a single differing path', async () => {
    const f = fixture({
      prs: [pull(401)],
      compares: { [oid(401)]: { status: 'identical', ahead_by: 0, behind_by: 0, files: [] } },
      files: { 401: [{ filename: 'src/a.ts', status: 'modified' }] },
    });
    const repo = (await fleetDirtySuperseded([], f.deps)).repos[0]!;
    expect(repo.prs[0]!.verdict).toBe('superseded');
    expect(repo.prs[0]!.evidence.matched).toEqual(['src/a.ts']);
  });

  it('--repo targets an explicit repository', async () => {
    const f = fixture({
      prs: [pull(501)],
      compares: { [oid(501)]: { status: 'diverged', ahead_by: 1, behind_by: 0, files: [] } },
      files: { 501: [{ filename: 'src/a.ts', status: 'modified' }] },
    });
    const report = await fleetDirtySuperseded(['--repo', REPO], f.deps);
    expect(report.repos[0]!.prs[0]!.verdict).toBe('superseded');
    expect(f.calls.some(c => c.includes('repos/{owner}/{repo}'))).toBe(false);
    expect(f.calls.find(c => c[0] === 'pr')).toContain(REPO);
    expectReadOnly(f.calls);
  });

  it('rejects unknown flags and invalid repos before any call', async () => {
    const f = fixture({ prs: [] });
    for (const args of [['--bogus'], ['--repo'], ['--repo', 'noslash'], ['--stale-days', '0']])
      await expect(fleetDirtySuperseded(args, f.deps)).rejects.toThrow();
    expect(f.calls).toEqual([]);
  });

  it('supersededVerdict folds matched/differing counts into the verdict', () => {
    expect(supersededVerdict(3, 0)).toBe('superseded');
    expect(supersededVerdict(0, 0)).toBe('superseded'); // no changed files: vacuously applied
    expect(supersededVerdict(2, 1)).toBe('partial');
    expect(supersededVerdict(0, 2)).toBe('diverged');
  });

  it('pullChangedFiles streams paginated NDJSON', async () => {
    const gh = async (args: string[]) => {
      expect(args).toEqual(['api', '--paginate', '--jq', '.[]',
        'repos/ashlrai/phantom/pulls/9/files?per_page=100']);
      return '{"filename":"a.ts"}\n{"filename":"b.ts","status":"renamed"}\n';
    };
    expect(await pullChangedFiles(gh, 'repos/ashlrai/phantom', 9))
      .toEqual([{ filename: 'a.ts' }, { filename: 'b.ts', status: 'renamed' }]);
  });
});
