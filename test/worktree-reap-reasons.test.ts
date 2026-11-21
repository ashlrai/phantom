/** The reap finds every finished worktree: one test per reason, the cap, and the dirty-no-result guard. Hermetic: in-memory host, no Git. */
import { describe, expect, it, vi } from 'vitest';
import { cmdFleetReap } from '../src/cli/fleet-reap.js';
import { planWorktreeReap, runWorktreeReapTick, WORKTREE_REAP_CAP } from '../src/core/fleet/worktree-reap-tick.js';
import { readWorktrees, type WorktreesDeps } from '../src/core/fleet/worktrees.js';
import type { WtAuditFs } from '../src/core/fleet/wt-audit.js';

const NOW = Date.parse('2026-11-17T12:00:00Z');
const HOUR = 3_600_000;
const WT = '/wt';
const RUNS = '/runs';
const iso = (hoursAgo: number) => new Date(NOW - hoursAgo * HOUR).toISOString();

interface Job {
  hours?: number;
  /** Ledger rows after the launch row. */
  ledger?: Record<string, unknown>[];
  rc?: boolean;
  publish?: string;
  /** Listed in status.json kept_worktrees. */
  kept?: boolean;
  dirty?: boolean;
  merged?: boolean;
}

function host(jobs: Record<string, Job>, extra: { ps?: string } = {}) {
  const hours = (job: string) => jobs[job]?.hours ?? 10;
  const rows = Object.entries(jobs).flatMap(([id, j]) =>
    [{ event: 'launch', job: id, repo: 'ashlrai/phantom', ts: iso(hours(id) + 1) }, ...(j.ledger ?? []).map(r => ({ job: id, ts: iso(hours(id)), ...r }))]);
  const kept = Object.entries(jobs).filter(([, j]) => j.kept).map(([id]) => id);
  const files: Record<string, string> = {
    [`${RUNS}/queue/status.json`]: JSON.stringify({ kept_worktrees: kept }), [`${RUNS}/queue/keep.txt`]: '',
  };
  for (const [id, j] of Object.entries(jobs)) if (j.publish) files[`${RUNS}/${id}.publish`] = j.publish;
  const fs: WtAuditFs = {
    dirs: async path => (path === WT ? Object.keys(jobs) : []),
    entries: async path => path === RUNS ? ['queue', ...Object.entries(jobs).filter(([, j]) => j.publish).map(([id]) => `${id}.publish`)]
      : path === `${RUNS}/queue` ? ['status.json', 'keep.txt', 'run']
        : path === `${RUNS}/queue/run` ? Object.entries(jobs).filter(([, j]) => j.rc).map(([id]) => `${id}.rc`) : null,
    text: async path => files[path] ?? null,
    mtime: async path => (path.startsWith(`${WT}/`) ? NOW - hours(path.slice(WT.length + 1)) * HOUR : path.endsWith('.rc') ? NOW - hours(path.split('/').pop()!.slice(0, -3)) * HOUR : null),
    real: async path => path,
  };
  const name = (path: string) => path.slice(WT.length + 1);
  return {
    now: NOW, wtRoot: WT, runsRoot: RUNS, fs,
    readJobs: async () => ({ state: 'healthy' as const, text: rows.map(r => JSON.stringify(r)).join('\n') }),
    ps: () => extra.ps ?? '',
    readPins: () => ({ paths: [], valid: true }),
    isClean: vi.fn(async (path: string) => !jobs[name(path)]?.dirty),
    isMerged: vi.fn(async (path: string) => jobs[name(path)]?.merged === true),
    measure: vi.fn(() => ({ bytes: 1e6, complete: true })),
    remove: vi.fn(async () => undefined),
    logRemoval: vi.fn(async () => undefined),
  } satisfies WorktreesDeps;
}

const verdict = async (jobs: Record<string, Job>, id = Object.keys(jobs)[0]!, extra?: { ps?: string }) => {
  const report = await readWorktrees('list', host(jobs, extra));
  return report.rows.find(r => r.job === id)!;
};

describe('every reason is reported', () => {
  it('empty: the publish result is EMPTY', async () => {
    expect(await verdict({ 'RQ-A': { rc: true, publish: 'RESULT EMPTY nothing to change\n' } })).toMatchObject({ safe: true, reason: 'empty' });
  });

  it('merged: the ledger says the PR merged', async () => {
    expect(await verdict({ 'RQ-A': { ledger: [{ event: 'outcome', state: 'MERGED' }] } })).toMatchObject({ safe: true, reason: 'merged', state: 'merged' });
  });

  it('closed: the ledger says the PR closed without merging', async () => {
    expect(await verdict({ 'RQ-A': { rc: true, ledger: [{ event: 'outcome', state: 'CLOSED' }] } })).toMatchObject({ safe: true, reason: 'closed', state: 'closed' });
  });

  it('merged: a finished job with no verdict is safe when Git shows its branch inside origin/master', async () => {
    expect(await verdict({ 'RQ-A': { rc: true, merged: true } })).toMatchObject({ safe: true, reason: 'merged' });
    expect(await verdict({ 'RQ-A': { rc: true, publish: 'RESULT PR https://github.com/ashlrai/phantom/pull/1\n', merged: true } })).toMatchObject({ safe: true, reason: 'merged' });
  });

  it('a finished job whose branch is not in origin/master stays held', async () => {
    expect(await verdict({ 'RQ-A': { rc: true, merged: false } })).toMatchObject({ safe: false, hold: 'state-unknown', reason: 'other' });
  });

  it('a job that never finished is not checked against Git', async () => {
    const deps = host({ 'RQ-A': { merged: true } });
    const report = await readWorktrees('list', deps);
    expect(report.rows[0]).toMatchObject({ safe: false });
    expect(deps.isMerged).not.toHaveBeenCalled();
  });

  it('kept: status.json kept_worktrees wins over everything', async () => {
    expect(await verdict({ 'RQ-A': { rc: true, merged: true, kept: true, ledger: [{ event: 'outcome', state: 'MERGED' }] } })).toMatchObject({ safe: false, reason: 'kept' });
  });

  it('too-new: under six hours old', async () => {
    expect(await verdict({ 'RQ-A': { hours: 5, rc: true, publish: 'RESULT EMPTY\n' } })).toMatchObject({ safe: false, reason: 'too-new' });
    expect(await verdict({ 'RQ-A': { hours: 6, rc: true, publish: 'RESULT EMPTY\n' } })).toMatchObject({ safe: true });
  });

  it('a live process holds the worktree however finished it looks', async () => {
    expect(await verdict({ 'RQ-A': { rc: true, merged: true } }, 'RQ-A', { ps: 'node /wt/RQ-A/run.js' })).toMatchObject({ safe: false, hold: 'live-job' });
  });

  it('dirty-no-result: uncommitted changes and no RESULT line are never picked', async () => {
    for (const job of [{ rc: true, merged: true, dirty: true }, { rc: true, dirty: true, ledger: [{ event: 'outcome', state: 'CLOSED' }] }]) {
      expect(await verdict({ 'RQ-A': job })).toMatchObject({ safe: false, hold: 'uncommitted-changes', reason: 'dirty-no-result' });
    }
  });

  it('dirty with a RESULT line is still held, but is not called dirty-no-result', async () => {
    expect(await verdict({ 'RQ-A': { rc: true, dirty: true, publish: 'RESULT EMPTY\n' } })).toMatchObject({ safe: false, hold: 'uncommitted-changes', reason: 'other' });
  });

  it('counts every worktree once under its reason', async () => {
    const report = await readWorktrees('list', host({
      'RQ-EMPTY': { rc: true, publish: 'RESULT EMPTY\n' },
      'RQ-MERGED': { ledger: [{ event: 'outcome', state: 'MERGED' }] },
      'RQ-GITMERGED': { rc: true, merged: true },
      'RQ-CLOSED': { ledger: [{ event: 'outcome', state: 'CLOSED' }] },
      'RQ-KEPT': { rc: true, kept: true },
      'RQ-DIRTY': { rc: true, merged: true, dirty: true },
      'RQ-NEW': { hours: 1, rc: true, publish: 'RESULT EMPTY\n' },
      'RQ-STILL': { rc: true },
    }));
    expect(report.reasons).toEqual({ empty: 1, merged: 2, closed: 1, kept: 1, 'dirty-no-result': 1, 'too-new': 1, other: 1 });
    expect(Object.values(report.reasons).reduce((a, b) => a + b, 0)).toBe(report.counts.total);
  });
});

describe('the cap', () => {
  const many = (n: number) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`RQ-J${String(i).padStart(3, '0')}`, { rc: true, publish: 'RESULT EMPTY\n' } as Job]));

  it('the plan lists at most the cap and says how many wait', async () => {
    const plan = await planWorktreeReap(host(many(60)));
    expect(WORKTREE_REAP_CAP).toBe(40);
    expect(plan.candidates).toHaveLength(40);
    expect(plan).toMatchObject({ total: 60, waiting: 20, cap: 40, schema: 'fleet.reap-plan.v1' });
    expect(plan.reasons.empty).toBe(60);
  });

  it('one apply removes at most the cap', async () => {
    const deps = host(many(60));
    const result = await runWorktreeReapTick({ runsDir: RUNS, apply: false, now: NOW, deps });
    expect(result).toMatchObject({ state: 'dry-run', total: 60, waiting: 20 });
    const report = await readWorktrees('apply', { ...deps, maxRemovals: WORKTREE_REAP_CAP });
    expect(deps.remove).toHaveBeenCalledTimes(40);
    expect(report.removals).toHaveLength(40);
  });
});

describe('phm fleet reap', () => {
  const capture = async (args: string[], deps: WorktreesDeps) => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const code = await cmdFleetReap(args, deps);
      return { code, out: log.mock.calls.map(c => String(c[0])), err: err.mock.calls.map(c => String(c[0])) };
    } finally { log.mockRestore(); err.mockRestore(); }
  };
  const jobs: Record<string, Job> = {
    'RQ-EMPTY': { rc: true, publish: 'RESULT EMPTY\n' }, 'RQ-DIRTY': { rc: true, merged: true, dirty: true }, 'RQ-KEPT': { kept: true },
  };

  it('--plan --json prints the breakdown and removes nothing', async () => {
    const deps = host(jobs);
    const { code, out } = await capture(['--plan', '--json'], deps);
    expect(code).toBe(0);
    const plan = JSON.parse(out[0]!);
    expect(plan.candidates.map((c: { job: string }) => c.job)).toEqual(['RQ-EMPTY']);
    expect(plan.reasons).toMatchObject({ empty: 1, kept: 1, 'dirty-no-result': 1 });
    expect(deps.remove).not.toHaveBeenCalled();
  });

  it('the default is the plan, in plain words', async () => {
    const { code, out } = await capture([], host(jobs));
    expect(code).toBe(0);
    expect(out.at(-1)).toBe('Would remove 1 now (cap 40). Nothing was removed.');
  });

  it('--apply removes the safe rows only', async () => {
    const deps = host(jobs);
    expect((await capture(['--apply'], deps)).code).toBe(0);
    expect(deps.remove.mock.calls.map(([p]) => p)).toEqual(['/wt/RQ-EMPTY']);
  });

  it('rejects unknown and conflicting flags', async () => {
    for (const args of [['--force'], ['--plan', '--apply'], ['--json', '--json']]) expect((await capture(args, host(jobs))).code).toBe(2);
  });
});
