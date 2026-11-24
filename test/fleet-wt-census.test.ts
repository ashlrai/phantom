/** Hermetic tests for `phm fleet wt-census` — every reader is injected, and
 * the one real-git case builds a throwaway repo under the OS temp dir. */
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ageBucketOf, censusClassify, formatWtCensus, readWtCensus, repoFromGitText,
  type WtCensusDeps, type WtCensusGit,
} from '../src/core/fleet/wt-census.js';
import type { WtAuditFs, WtAuditState } from '../src/core/fleet/wt-audit.js';
import { cmdFleetWtCensus } from '../src/cli/fleet-wt-census.js';
import type { MaintRoots } from '../src/core/disk-maint/protect.js';
import type { KeptWorktrees } from '../src/core/worktree-retention.js';
import { readFleetDiskAttribution, formatFleetDiskAttribution } from '../src/core/fleet/disk-attribution.js';

const NOW = Date.parse('2026-11-15T12:00:00Z');
const HOUR = 3_600_000;
const HOME = '/home';
const WT = '/wt';
const RUNS = '/runs';
const RUNS_WT = `${RUNS}/wt`;
const RUN = `${RUNS}/queue/run`;
const QUEUE = `${RUNS}/queue`;

const MAINT_ROOTS: MaintRoots = {
  home: HOME, ashlrDir: `${HOME}/.ashlr`, runsDir: RUNS,
  wtDir: WT, sideProjectsDir: `${HOME}/side`, hubDir: null,
};

const iso = (ms: number) => new Date(ms).toISOString();
const launch = (job: string, hours: number) => ({ event: 'launch', job, ts: iso(NOW - hours * HOUR) });
const finish = (job: string, hours: number, empty = false) =>
  ({ event: 'finish', job, empty, ts: iso(NOW - hours * HOUR) });
const outcome = (job: string, state: string, hours = 1, url?: string) =>
  ({ event: 'outcome', job, state, ts: iso(NOW - hours * HOUR), ...(url ? { url } : {}) });
const jobsText = (rows: unknown[]) => rows.map(r => JSON.stringify(r)).join('\n') + '\n';
const baseText = (job: string, pool = 'devin', wt = `${WT}/${job}`) => `deadbeef main ${wt} ${pool}\n`;
const gitText = (job: string, repo = 'phantom') => `gitdir: /repos/${repo}/.git/worktrees/${job}\n`;

interface FakeSpec {
  dirs?: Record<string, string[]>;
  entries?: Record<string, string[] | null>;
  files?: Record<string, string>;
  mtimes?: Record<string, number>;
  failDirs?: boolean;
}
const fakeFs = (spec: FakeSpec): WtAuditFs => ({
  dirs: async path => (spec.failDirs ? null : (spec.dirs?.[path] ?? [])),
  entries: async path => spec.entries?.[path] ?? null,
  text: async path => spec.files?.[path] ?? null,
  mtime: async path => spec.mtimes?.[path] ?? null,
  real: async path => path,
});

interface FakeOptions extends WtCensusDeps {
  rows?: unknown[];
  psText?: string | null;
  pins?: KeptWorktrees;
  bytes?: number;
  dirty?: boolean | null;
  commitMs?: number | null;
}

const old = NOW - 60 * 24 * HOUR;
const cleanGit = (over: Partial<WtCensusGit> = {}): WtCensusGit => ({
  lastCommitMs: async () => NOW - 50 * HOUR,
  dirty: async () => false,
  ...over,
});

/** A fully-readable fake host: healthy jobs/status/keep/run/ps/pins unless
 * overridden. Mirrors the wt-audit suite's fake plus .git file content. */
const healthyDeps = (spec: FakeSpec, options: FakeOptions = {}): WtCensusDeps => {
  const {
    rows = [], psText = 'node dispatchd.py --tick\n', pins = { paths: [], valid: true },
    bytes = 1e9, dirty = false, commitMs = NOW - 50 * HOUR, ...rest
  } = options;
  const files = { [`${QUEUE}/status.json`]: '{}', ...spec.files };
  const children = (dir: string) => Object.keys(files)
    .filter(p => p.slice(0, p.lastIndexOf('/')) === dir)
    .map(p => p.slice(p.lastIndexOf('/') + 1));
  const listed = (dir: string, fallback: string[]): string[] | null =>
    spec.entries && Object.hasOwn(spec.entries, dir) ? (spec.entries[dir] ?? null) : fallback;
  const runsListing = listed(RUNS, children(RUNS));
  const queueListing = listed(QUEUE, children(QUEUE));
  return {
    now: NOW,
    home: HOME,
    wtRoot: WT,
    runsRoot: RUNS,
    maintRoots: MAINT_ROOTS,
    fs: fakeFs({
      dirs: spec.dirs,
      entries: {
        [RUNS]: runsListing === null ? null : [...runsListing, 'queue'],
        [QUEUE]: queueListing === null ? null : [...queueListing, 'run'],
        [RUN]: listed(RUN, []),
      },
      files,
      mtimes: {
        ...Object.fromEntries((spec.dirs?.[WT] ?? []).map(d => [`${WT}/${d}`, old])),
        ...Object.fromEntries((spec.dirs?.[RUNS_WT] ?? []).map(d => [`${RUNS_WT}/${d}`, old])),
        ...spec.mtimes,
      },
      failDirs: spec.failDirs,
    }),
    readJobs: async () => ({ state: 'healthy', text: jobsText(rows) }),
    ps: () => psText,
    readPins: () => pins,
    measure: () => ({ bytes, complete: true }),
    git: cleanGit({ dirty: async () => dirty, lastCommitMs: async () => commitMs }),
    ...rest,
  };
};

const classify = (state: WtAuditState, over: Partial<Parameters<typeof censusClassify>[0]> = {}) =>
  censusClassify({ state, reapable: false, protectedReason: null, dirty: null, ...over });

describe('repoFromGitText', () => {
  it('names the repo a worktree .git pointer resolves into', () => {
    expect(repoFromGitText('gitdir: /Users/m/Projects/ashlrai/phantom/.git/worktrees/RQ-1\n')).toBe('phantom');
    expect(repoFromGitText('gitdir: C:\\code\\locus\\.git\\worktrees\\RQ-2')).toBe('locus');
  });
  it('rejects plain .git dirs, bare repos, foreign layouts and junk', () => {
    expect(repoFromGitText(null)).toBeNull();
    expect(repoFromGitText('')).toBeNull();
    expect(repoFromGitText('not a git file')).toBeNull();
    expect(repoFromGitText('gitdir: /repo/.git\n')).toBeNull();
    expect(repoFromGitText('gitdir: /repos/phantom/.git/worktrees/\n')).toBeNull();
    expect(repoFromGitText('gitdir: /repos/phantom/.git/modules/x/worktrees/RQ-1\n')).toBe('x');
  });
});

describe('ageBucketOf', () => {
  it('buckets by whole-day age, null to unknown', () => {
    expect(ageBucketOf(null)).toBe('unknown');
    expect(ageBucketOf(0)).toBe('<1d');
    expect(ageBucketOf(23.9)).toBe('<1d');
    expect(ageBucketOf(24)).toBe('1-7d');
    expect(ageBucketOf(6 * 24)).toBe('1-7d');
    expect(ageBucketOf(7 * 24)).toBe('7-30d');
    expect(ageBucketOf(29 * 24)).toBe('7-30d');
    expect(ageBucketOf(30 * 24)).toBe('30-90d');
    expect(ageBucketOf(90 * 24)).toBe('>90d');
  });
});

describe('censusClassify', () => {
  it('safe-reap only for merged/published/empty + reapable + clean + unprotected', () => {
    for (const state of ['merged', 'published', 'empty'] as const) {
      expect(classify(state, { reapable: true, dirty: false })).toEqual({ census: 'safe-reap', blockers: [] });
    }
  });
  it('holds uncommitted work and publishes not yet recorded', () => {
    expect(classify('merged', { reapable: true, dirty: true }))
      .toEqual({ census: 'hold', blockers: ['uncommitted-changes'] });
    expect(classify('finished', { reapable: true, dirty: false }))
      .toEqual({ census: 'hold', blockers: ['publish-pending'] });
  });
  it('unknown when the dirty check could not run, and unknown states stay unknown', () => {
    expect(classify('merged', { reapable: true, dirty: null }))
      .toEqual({ census: 'unknown', blockers: ['dirty-unproven'] });
    expect(classify('unknown').census).toBe('unknown');
    expect(classify('orphaned').census).toBe('unknown');
    // A merged-looking worktree without eligibility was stripped by degraded
    // evidence — insufficient evidence, so unknown (which means hold anyway).
    expect(classify('merged', { reapable: false }).census).toBe('unknown');
  });
  it('positive-hold states stay hold', () => {
    for (const state of ['running', 'reaping', 'publishing', 'held', 'archived', 'open', 'ended', 'recorded', 'finished', 'invalid', 'excluded'] as const) {
      expect(classify(state).census, state).toBe('hold');
    }
  });
  it('the protect-list always wins, even over a clean merged worktree', () => {
    const verdict = classify('merged', { reapable: true, dirty: false, protectedReason: 'protected-name:secrets' });
    expect(verdict.census).toBe('hold');
    expect(verdict.blockers[0]).toBe('protect-list:protected-name:secrets');
    expect(classify('orphaned', { protectedReason: 'protected-root:bin' }).census).toBe('hold');
  });
});

describe('readWtCensus', () => {
  const spec: FakeSpec = {
    dirs: { [WT]: ['RQ-MERGED', 'RQ-PUB', 'RQ-FIN', 'RQ-DIRTY', 'RQ-RUN', 'RQ-HELD', 'RQ-ORPH', 'secrets'], [RUNS_WT]: ['RQ-RUNSWT'] },
    entries: {
      [RUNS]: ['RQ-MERGED.base', 'RQ-MERGED.publish', 'RQ-PUB.base', 'RQ-PUB.publish', 'RQ-FIN.base', 'RQ-DIRTY.base', 'RQ-RUNSWT.base'],
      [RUN]: ['RQ-RUN.dispatched', 'RQ-FIN.rc', 'RQ-FIN.fin', 'RQ-MERGED.fin'],
    },
    files: {
      [`${WT}/RQ-MERGED/.git`]: gitText('RQ-MERGED', 'phantom'),
      [`${WT}/RQ-PUB/.git`]: gitText('RQ-PUB', 'ashlr-md'),
      [`${WT}/RQ-FIN/.git`]: gitText('RQ-FIN', 'phantom'),
      [`${WT}/RQ-DIRTY/.git`]: gitText('RQ-DIRTY', 'phantom'),
      [`${RUNS_WT}/RQ-RUNSWT/.git`]: gitText('RQ-RUNSWT', 'locus'),
      [`${RUNS}/RQ-MERGED.base`]: baseText('RQ-MERGED'),
      [`${RUNS}/RQ-MERGED.publish`]: 'RESULT PR https://github.com/o/r/pull/1\n',
      [`${RUNS}/RQ-PUB.base`]: baseText('RQ-PUB'),
      [`${RUNS}/RQ-PUB.publish`]: 'RESULT PR https://github.com/o/r/pull/2\n',
      [`${RUNS}/RQ-FIN.base`]: baseText('RQ-FIN'),
      [`${RUNS}/RQ-DIRTY.base`]: baseText('RQ-DIRTY'),
      [`${RUNS_WT}/RQ-RUNSWT.base`]: baseText('RQ-RUNSWT', 'devin', `${RUNS_WT}/RQ-RUNSWT`),
      [`${QUEUE}/status.json`]: JSON.stringify({ kept_worktrees: ['RQ-HELD'] }),
    },
    mtimes: { [`${WT}/RQ-ORPH`]: NOW - 100 * 24 * HOUR },
  };
  const rows = [
    launch('RQ-MERGED', 30), finish('RQ-MERGED', 20), outcome('RQ-MERGED', 'MERGED', 15, 'https://github.com/o/r/pull/1'),
    launch('RQ-PUB', 12), finish('RQ-PUB', 9), launch('RQ-FIN', 8), finish('RQ-FIN', 5),
    launch('RQ-DIRTY', 40), finish('RQ-DIRTY', 30), outcome('RQ-DIRTY', 'MERGED', 25),
    launch('RQ-RUNSWT', 50), finish('RQ-RUNSWT', 45), outcome('RQ-RUNSWT', 'MERGED', 40),
  ];

  it('attributes disk use and ranks safe candidates while retaining active jobs and their artifacts', async () => {
    const deps = { ...healthyDeps(spec, { rows, git: cleanGit({ dirty: async dir => dir.endsWith('RQ-DIRTY') }),
      measure: dir => ({ bytes: dir.endsWith('RQ-RUNSWT') ? 3e9 : 1e9, complete: true }) }),
    artifactBytes: async () => 123 };
    const report = await readFleetDiskAttribution(deps);
    expect(report.schema).toBe('fleet.disk-attribution.v1');
    expect(report.readOnly).toBe(true);
    expect(report.cleanupCandidates.map(c => c.job)).toEqual(['RQ-RUNSWT', 'RQ-MERGED', 'RQ-PUB']);
    expect(report.entries.find(c => c.job === 'RQ-RUN')).toMatchObject({ bytes: 1e9, cleanup: 'retain', reason: expect.stringContaining('running') });
    expect(report.entries.filter(c => c.kind === 'job-artifact').every(c => c.cleanup === 'retain' && c.bytes === 123)).toBe(true);
    expect(report.categories[0]).toMatchObject({ count: 9, bytes: 11e9, complete: true });
    expect(report.categories[0]?.reclaimable).toEqual({ bytes: null, provenBytes: 5e9, candidates: 3, complete: false });
    expect(report.categories[1]?.reclaimable).toEqual({ bytes: null, provenBytes: 0, candidates: 0, complete: false });
    expect(report.cleanupCandidates.map(c => c.via)).toEqual(['worktree-remove', 'worktree-remove', 'reap-one']);
    expect(report.entries.filter(c => c.cleanup === 'retain').every(c => c.via === null)).toBe(true);
    expect(JSON.stringify(await readFleetDiskAttribution(deps))).toBe(JSON.stringify(report));
    const reordered = { ...deps, fs: { ...deps.fs!, entries: async (path: string) => (await deps.fs!.entries(path))?.reverse() ?? null } };
    expect(JSON.stringify(await readFleetDiskAttribution(reordered))).toBe(JSON.stringify(report));
    expect(formatFleetDiskAttribution(report).join('\n')).toContain('Largest safe cleanup candidates: 3');
    expect(formatFleetDiskAttribution(report).join('\n')).toContain('reclaimable: unknown (at least 5.00 GB proven)');
    expect(formatFleetDiskAttribution(report).join('\n')).toContain('preview: phm disk-maint --json');
  });

  it('reports missing paths and partial measurements as unknown, never as safe zero-byte cleanup', async () => {
    const absent = await readFleetDiskAttribution(healthyDeps({ failDirs: true, entries: { [RUNS]: null } }));
    expect(absent.categories.every(c => c.bytes === null && !c.complete)).toBe(true);
    expect(absent.cleanupCandidates).toEqual([]);
    expect(absent.categories.every(c => c.reclaimable.bytes === null && !c.reclaimable.complete)).toBe(true);
    const partial = await readFleetDiskAttribution({ ...healthyDeps(spec, { rows,
      measure: () => ({ bytes: 42, complete: false }) }), artifactBytes: async () => null });
    expect(partial.categories.every(c => c.bytes === null && !c.complete)).toBe(true);
    expect(partial.categories[0].measuredBytes).toBe(9 * 42);
    expect(partial.cleanupCandidates).toEqual([]);
    expect(partial.categories[0]?.reclaimable).toEqual({ bytes: null, provenBytes: 0, candidates: 0, complete: false });
    expect(formatFleetDiskAttribution(partial).join('\n')).toContain('unknown (measured at least');
  });

  it('totals all candidates beyond the top ten and excludes active and protected merged trees', async () => {
    const safe = Array.from({ length: 12 }, (_, i) => `RQ-SAFE-${i}`);
    const held = ['RQ-ACTIVE', 'secrets', 'models'];
    const names = [...safe, ...held];
    const deps = healthyDeps({ dirs: { [WT]: names }, entries: { [RUN]: ['RQ-ACTIVE.dispatched'] } }, {
      rows: names.flatMap(name => [launch(name, 30), finish(name, 20), outcome(name, 'MERGED', 15)]),
    });
    const report = await readFleetDiskAttribution(deps);
    expect(report.categories[0]?.reclaimable).toEqual({ bytes: 12e9, provenBytes: 12e9, candidates: 12, complete: true });
    expect(report.cleanupCandidates).toHaveLength(10);
    for (const name of held) {
      expect(report.entries.find(e => e.job === name)).toMatchObject({ cleanup: 'retain', via: null });
    }
    expect(report.entries.find(e => e.job === 'RQ-ACTIVE')?.reason).toContain('running');
    expect(report.entries.find(e => e.job === 'secrets')?.reason).toContain('protect-list:');
    expect(report.entries.find(e => e.job === 'models')?.reason).toContain('protect-list:');
    expect(formatFleetDiskAttribution(report).join('\n')).toContain('reclaimable: 12.00 GB');
  });

  it('does not mistake unread safety evidence or unproven git state for zero reclaimable bytes', async () => {
    const deps = healthyDeps({ dirs: { [WT]: ['RQ-MERGED'] } }, { rows });
    for (const over of [
      { readJobs: async () => ({ state: 'degraded' as const, text: '' }) },
      { ps: () => null }, { readPins: () => ({ paths: [], valid: false }) },
      { git: cleanGit({ dirty: async () => null }) },
    ]) {
      const report = await readFleetDiskAttribution({ ...deps, ...over });
      expect(report.categories[0]).toMatchObject({ bytes: 1e9, complete: true,
        reclaimable: { bytes: null, provenBytes: 0, candidates: 0, complete: false } });
      expect(report.cleanupCandidates).toEqual([]);
    }
  });

  it('measures real artifact metadata without following links or changing files', async () => {
    const root = mkdtempSync(join(tmpdir(), 'fleet-disk-'));
    try {
      writeFileSync(join(root, 'RQ-JOB.log'), 'retained evidence');
      symlinkSync(join(root, 'RQ-JOB.log'), join(root, 'RQ-LINK.log'));
      const report = await readFleetDiskAttribution({ runsRoot: root, wtRoot: join(root, 'absent'), ps: () => '', readPins: () => ({ paths: [], valid: true }) });
      expect(report.entries.find(e => e.job === 'RQ-JOB')).toMatchObject({ bytes: 17, cleanup: 'retain' });
      expect(report.entries.find(e => e.job === 'RQ-LINK')).toMatchObject({ bytes: null, complete: false });
      expect(report.cleanupCandidates).toEqual([]);
      expect(readFileSync(join(root, 'RQ-JOB.log'), 'utf8')).toBe('retained evidence');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('classifies the fleet into safe-reap, hold and unknown with repo, fin and sizes', async () => {
    const dirtyMap = new Map([[`${WT}/RQ-DIRTY`, true]]);
    const r = await readWtCensus(healthyDeps(spec, {
      rows,
      git: {
        lastCommitMs: async () => NOW - 50 * HOUR,
        dirty: async dir => dirtyMap.get(dir) ?? false,
      },
    }));
    const byName = new Map(r.worktrees.map(w => [w.name, w]));
    expect(byName.get('RQ-MERGED')).toMatchObject({ census: 'safe-reap', state: 'merged', via: 'worktree-remove', repo: 'phantom', fin: true, dirty: false });
    expect(byName.get('RQ-PUB')).toMatchObject({ census: 'safe-reap', state: 'published', via: 'reap-one', repo: 'ashlr-md' });
    expect(byName.get('RQ-DIRTY')).toMatchObject({ census: 'hold', state: 'merged', dirty: true });
    expect(byName.get('RQ-DIRTY')!.blockers).toContain('uncommitted-changes');
    expect(byName.get('RQ-FIN')).toMatchObject({ census: 'hold', state: 'finished', fin: true });
    expect(byName.get('RQ-FIN')!.blockers).toContain('publish-pending');
    expect(byName.get('RQ-RUN')).toMatchObject({ census: 'hold', state: 'running' });
    expect(byName.get('RQ-HELD')).toMatchObject({ census: 'hold', state: 'held' });
    expect(byName.get('RQ-ORPH')).toMatchObject({ census: 'unknown', state: 'orphaned' });
    // A protect-list name is never safe-reap, even with a merged outcome.
    expect(byName.get('secrets')).toMatchObject({ census: 'hold', state: 'orphaned' });
    expect(byName.get('secrets')!.blockers.some(b => b.startsWith('protect-list:'))).toBe(true);
    // The runs root is censused too.
    expect(byName.get('RQ-RUNSWT')).toMatchObject({ root: 'runs', census: 'safe-reap', repo: 'locus' });
    // Roll-ups.
    expect(r.groups.byCensus['safe-reap'].worktrees).toBe(3);
    expect(r.groups.byCensus.hold.worktrees).toBe(5);
    expect(r.groups.byCensus.unknown.worktrees).toBe(1);
    expect(r.groups.byState.merged).toBe(3);
    const phantom = r.groups.byRepo.find(g => g.repo === 'phantom')!;
    expect(phantom.worktrees).toBe(3);
    expect(phantom.safeReap).toBe(1);
    // DIRTY/RUNSWT ledger evidence is 25h/40h; RUN, HELD and secrets only have
    // a 60-day-old dir mtime; the 100-day orphan is the oldest entry.
    expect(r.groups.byAge.find(g => g.bucket === '>90d')!.worktrees).toBe(1);
    expect(r.groups.byAge.find(g => g.bucket === '30-90d')!.worktrees).toBe(3);
    expect(r.groups.byAge.find(g => g.bucket === '1-7d')!.worktrees).toBe(2);
    expect(r.groups.byAge.find(g => g.bucket === '<1d')!.worktrees).toBe(3);
    expect(r.totals.worktrees).toBe(9);
    expect(r.sources).toMatchObject({ worktrees: 'healthy', runsWorktrees: 'healthy', git: 'healthy', sized: true });
    // The top list carries only safe-reap entries, biggest first.
    expect(r.safeReap.count).toBe(3);
    expect(r.safeReap.top.every(w => w.state !== 'finished')).toBe(true);
    expect(r.safeReap.top.map(w => w.name)).toEqual(['RQ-MERGED', 'RQ-PUB', 'RQ-RUNSWT']);
  });

  it('--no-git leaves candidates unknown rather than safe', async () => {
    const r = await readWtCensus(healthyDeps(spec, { rows, wantGit: false }));
    const merged = r.worktrees.find(w => w.name === 'RQ-MERGED')!;
    expect(merged.census).toBe('unknown');
    expect(merged.blockers).toContain('dirty-unproven');
    expect(merged.lastCommitAt).toBeNull();
    expect(r.sources.git).toBe('skipped');
    expect(r.safeReap.count).toBe(0);
  });

  it('an injected protect hook can hold a worktree the file list cannot', async () => {
    const r = await readWtCensus(healthyDeps(spec, {
      rows,
      protect: path => path.endsWith('RQ-PUB') ? 'protected-root:test' : null,
    }));
    const pub = r.worktrees.find(w => w.name === 'RQ-PUB')!;
    expect(pub.census).toBe('hold');
    expect(pub.blockers).toContain('protect-list:protected-root:test');
    expect(r.safeReap.top.map(w => w.name)).not.toContain('RQ-PUB');
  });

  it('a deadline-clipped probe pass reports git=partial', async () => {
    const r = await readWtCensus(healthyDeps(spec, { rows, gitBudgetMs: 0 }));
    expect(r.sources.git).toBe('partial');
    expect(r.worktrees.find(w => w.name === 'RQ-MERGED')!.census).toBe('unknown');
  });

  it('marks the git source healthy and sizes from both audits', async () => {
    const r = await readWtCensus(healthyDeps(spec, {
      rows,
      wantSize: false,
      git: { lastCommitMs: async () => NOW - 50 * HOUR, dirty: async dir => dir.endsWith('RQ-DIRTY') },
    }));
    expect(r.sources.sized).toBe(false);
    expect(r.totals.bytes).toBeNull();
    // Counts still resolve; byte totals stay unknown rather than invented.
    expect(r.safeReap.count).toBe(3);
    expect(r.safeReap.complete).toBe(false);
    expect(r.safeReap.bytes).toBeNull();
  });
});

describe('formatWtCensus', () => {
  it('summarizes classes, repos, ages and the safe-reap plan', async () => {
    const r = await readWtCensus(healthyDeps({
      dirs: { [WT]: ['RQ-A'], [RUNS_WT]: [] },
      entries: { [RUNS]: ['RQ-A.base'], [RUN]: ['RQ-A.fin'] },
      files: { [`${WT}/RQ-A/.git`]: gitText('RQ-A'), [`${RUNS}/RQ-A.base`]: baseText('RQ-A') },
    }, { rows: [launch('RQ-A', 30), finish('RQ-A', 20), outcome('RQ-A', 'MERGED', 10)] }));
    const text = formatWtCensus(r).join('\n');
    expect(text).toContain('1 safe-reap');
    expect(text).toContain('RQ-A [phantom]');
    expect(text).toContain('reap-one');
    expect(text).toContain('worktree-remove');
  });
});

describe('cmdFleetWtCensus', () => {
  const run = async (argv: string[], deps: WtCensusDeps) => {
    const logs: string[] = [];
    const errors: string[] = [];
    const code = await cmdFleetWtCensus(argv, { ...deps, output: { log: s => logs.push(s), error: s => errors.push(s) } });
    return { code, logs, errors };
  };
  const spec: FakeSpec = {
    dirs: { [WT]: ['RQ-A'], [RUNS_WT]: [] },
    entries: { [RUNS]: ['RQ-A.base', 'RQ-A.publish'], [RUN]: [] },
    files: {
      [`${WT}/RQ-A/.git`]: gitText('RQ-A'),
      [`${RUNS}/RQ-A.base`]: baseText('RQ-A'),
      [`${RUNS}/RQ-A.publish`]: 'RESULT PR https://github.com/o/r/pull/7\n',
    },
  };

  it('--json prints one parseable fleet.wt-census.v1 report', async () => {
    const { code, logs } = await run(['--json'], healthyDeps(spec, { rows: [outcome('RQ-A', 'MERGED', 30)] }));
    expect(code).toBe(0);
    const report = JSON.parse(logs[0]!);
    expect(report.schema).toBe('fleet.wt-census.v1');
    expect(report.readOnly).toBe(true);
    expect(report.worktrees[0]).toMatchObject({ name: 'RQ-A', census: 'safe-reap', repo: 'phantom' });
    expect(report.safeReap.top[0].name).toBe('RQ-A');
    // The fake roots pass through untouched; the operator's real home is
    // collapsed by sanitizePublicJson and never leaks into the payload.
    expect(report.roots.worktrees).toBe(WT);
    expect(JSON.stringify(report)).not.toContain(homedir());
  });

  it('rejects bad arguments, duplicates, relative paths and out-of-range --top', async () => {
    for (const argv of [['--nope'], ['--json', '--json'], ['--wt-dir', 'rel'], ['--runs-dir', 'rel'],
      ['--top', '0'], ['--top', '101'], ['--top'], ['extra']]) {
      expect((await run(argv, healthyDeps(spec))).code).toBe(2);
    }
    const help = await run(['--help'], healthyDeps(spec));
    expect(help.code).toBe(0);
    expect(help.logs[0]).toContain('phm fleet wt-census');
  });

  it('exits 1 when a worktree root cannot be listed', async () => {
    const { code } = await run(['--json'], healthyDeps({ failDirs: true }));
    expect(code).toBe(1);
  });
});

/* ---------------------------------------------------------------------- */
/* Real-git end-to-end: a throwaway repo proves the spawn probes read a    */
/* worktree's last commit and dirty bit the same way a reaper sees them.   */
/* ---------------------------------------------------------------------- */

const hasGit = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;

describe('real git probes', () => {
  it.runIf(hasGit)('reads repo, last commit and dirty state from a live worktree', async () => {
    const tmp = mkdtempSync(join(tmpdir(), 'wt-census-'));
    const repo = join(tmp, 'demorepo');
    const wtDir = join(tmp, 'wt');
    const runs = join(tmp, 'runs');
    mkdirSync(join(runs, 'queue', 'run'), { recursive: true });
    mkdirSync(join(runs, 'wt'), { recursive: true });
    execFileSync('git', ['init', repo]);
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'census@test']);
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'census']);
    execFileSync('git', ['-C', repo, 'config', 'commit.gpgsign', 'false']);
    writeFileSync(join(repo, 'f.txt'), 'x');
    execFileSync('git', ['-C', repo, 'add', 'f.txt']);
    execFileSync('git', ['-C', repo, 'commit', '-m', 'init']);
    execFileSync('git', ['-C', repo, 'worktree', 'add', join(wtDir, 'RQ-CLEAN'), '--detach']);
    execFileSync('git', ['-C', repo, 'worktree', 'add', join(wtDir, 'RQ-DIRTY'), '--detach']);
    writeFileSync(join(wtDir, 'RQ-DIRTY', 'uncommitted.txt'), 'work');
    // A worktree created this millisecond trips the audit's freshness grace —
    // age the dirs back so the live clock reads them as old evidence.
    const aged = new Date(Date.now() - 10 * HOUR);
    for (const name of ['RQ-CLEAN', 'RQ-DIRTY']) utimesSync(join(wtDir, name), aged, aged);

    const realNow = Date.now();
    const ago = (hours: number) => new Date(realNow - hours * HOUR).toISOString();
    const rows = [
      { event: 'launch', job: 'RQ-CLEAN', ts: ago(30) }, { event: 'finish', job: 'RQ-CLEAN', ts: ago(20) },
      { event: 'outcome', job: 'RQ-CLEAN', state: 'MERGED', ts: ago(10) },
      { event: 'launch', job: 'RQ-DIRTY', ts: ago(30) }, { event: 'finish', job: 'RQ-DIRTY', ts: ago(20) },
      { event: 'outcome', job: 'RQ-DIRTY', state: 'MERGED', ts: ago(10) },
    ];
    const r = await readWtCensus({
      now: realNow,
      home: tmp,
      wtRoot: wtDir,
      runsRoot: runs,
      maintRoots: { home: tmp, ashlrDir: join(tmp, '.ashlr'), runsDir: runs, wtDir, sideProjectsDir: join(tmp, 'side'), hubDir: null },
      readJobs: async () => ({ state: 'healthy', text: jobsText(rows) }),
      ps: () => 'node dispatchd.py --tick\n',
      readPins: () => ({ paths: [], valid: true }),
      measure: () => ({ bytes: 1, complete: true }),
    });
    const clean = r.worktrees.find(w => w.name === 'RQ-CLEAN')!;
    const dirty = r.worktrees.find(w => w.name === 'RQ-DIRTY')!;
    expect(clean).toMatchObject({ census: 'safe-reap', state: 'merged', repo: 'demorepo', dirty: false });
    expect(clean.lastCommitAt).not.toBeNull();
    expect(dirty).toMatchObject({ census: 'hold', state: 'merged', repo: 'demorepo', dirty: true });
    expect(dirty.blockers).toContain('uncommitted-changes');
    expect(r.safeReap.top.map(w => w.name)).toEqual(['RQ-CLEAN']);
  }, 60_000);
});
