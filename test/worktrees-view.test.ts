/** Hermetic tests for `phm worktrees`: the real audit runs over an in-memory host; Git is never called. */
import { describe, expect, it, vi } from 'vitest';
import { cmdWorktrees } from '../src/cli/worktrees.js';
import { formatWorktrees, readWorktrees, type WorktreesDeps, type WorktreesReport } from '../src/core/fleet/worktrees.js';
import type { WtAuditFs } from '../src/core/fleet/wt-audit.js';

const NOW = Date.parse('2026-11-17T12:00:00Z');
const HOUR = 3_600_000;
const WT = '/wt';
const RUNS = '/runs';
const iso = (hoursAgo: number) => new Date(NOW - hoursAgo * HOUR).toISOString();
const launch = (job: string, hoursAgo: number, repo = 'ashlrai/phantom') => ({ event: 'launch', job, repo, ts: iso(hoursAgo) });
const merged = (job: string, hoursAgo = 10) => [launch(job, hoursAgo + 1), { event: 'outcome', job, state: 'MERGED', ts: iso(hoursAgo) }];

/** One job per state, plus the refusal cases. */
const JOBS: Record<string, { rows: unknown[]; mtimeHours?: number }> = {
  'RQ-LIVE': { rows: [launch('RQ-LIVE', 1)] },
  'RQ-MERGED': { rows: merged('RQ-MERGED') },
  'RQ-EMPTY': { rows: [launch('RQ-EMPTY', 12, 'ashlr-stack'), { event: 'finish', job: 'RQ-EMPTY', empty: true, ts: iso(11) }] },
  'RQ-OPEN': { rows: [launch('RQ-OPEN', 9), { event: 'outcome', job: 'RQ-OPEN', state: 'OPEN', ts: iso(8) }] },
  'RQ-KEPT': { rows: merged('RQ-KEPT') },
  'RQ-UNKNOWN': { rows: [] },
  'RQ-DIRTY': { rows: merged('RQ-DIRTY') },
  'RQ-NEW': { rows: merged('RQ-NEW', 2), mtimeHours: 2 },
  'RQ-LIVEMERGED': { rows: merged('RQ-LIVEMERGED') },
};

interface Host { jobs?: typeof JOBS; keep?: string; pinsValid?: boolean; dirty?: Set<string>; runEntries?: string[] }

/** Fully readable fake host; every reader, the clean check, the remover and the log are spies. */
function host({ jobs = JOBS, keep = 'RQ-KEPT\n', pinsValid = true, dirty = new Set(['RQ-DIRTY']), runEntries = [] }: Host = {}) {
  const names = ['guardian-claude', ...Object.keys(jobs)];
  const files: Record<string, string> = { [`${RUNS}/queue/status.json`]: '{}', [`${RUNS}/queue/keep.txt`]: keep };
  const fs: WtAuditFs = {
    dirs: async path => (path === WT ? [...names] : []),
    entries: async path => (path === RUNS ? ['queue', 'metrics'] : path === `${RUNS}/queue` ? ['status.json', 'keep.txt', 'run'] : path === `${RUNS}/queue/run` ? runEntries : null),
    text: async path => files[path] ?? null,
    mtime: async path => {
      const name = path.slice(WT.length + 1);
      return path.startsWith(`${WT}/`) ? NOW - (jobs[name]?.mtimeHours ?? 10) * HOUR : null;
    },
    real: async path => path,
  };
  const deps = {
    now: NOW, wtRoot: WT, runsRoot: RUNS, fs,
    readJobs: async () => ({ state: 'healthy' as const, text: Object.values(jobs).flatMap(j => j.rows).map(r => JSON.stringify(r)).join('\n') }),
    ps: () => `claude --cwd ${WT}/RQ-LIVE\nnode ${WT}/RQ-LIVEMERGED/run.js\n`,
    readPins: () => ({ paths: [], valid: pinsValid }),
    isClean: vi.fn(async (path: string) => !dirty.has(path.slice(WT.length + 1))),
    measure: vi.fn(() => ({ bytes: 2e9, complete: true })),
    remove: vi.fn(async () => undefined),
    logRemoval: vi.fn(async () => undefined),
    readReapLog: vi.fn(async () => ({ state: 'missing' as const, text: '' })),
  } satisfies WorktreesDeps;
  return deps;
}
const row = (report: WorktreesReport, job: string) => report.rows.find(r => r.job === job)!;

describe('phm worktrees list', () => {
  it('gives every job worktree one of six states and marks only merged or empty rows safe', async () => {
    const deps = host();
    const report = await readWorktrees('list', deps);
    expect(report.rows.map(r => [r.job, r.state, r.safe, r.hold])).toEqual([
      ['RQ-DIRTY', 'merged', false, 'uncommitted-changes'],
      ['RQ-EMPTY', 'empty', true, null],
      ['RQ-KEPT', 'kept', false, 'kept'],
      ['RQ-LIVE', 'live', false, 'live-job'],
      ['RQ-LIVEMERGED', 'live', false, 'live-job'],
      ['RQ-MERGED', 'merged', true, null],
      ['RQ-NEW', 'merged', false, 'too-new'],
      ['RQ-OPEN', 'open', false, 'open-pr'],
      ['RQ-UNKNOWN', 'unknown', false, 'state-unknown'],
    ]);
    expect(report.counts).toEqual({ total: 9, safe: 2, live: 2, merged: 3, empty: 1, open: 1, kept: 1, unknown: 1 });
    expect(report.reclaimableBytes).toBe(4e9);
    expect(row(report, 'RQ-EMPTY')).toMatchObject({ repo: 'ashlr-stack', ageHours: 10, bytes: 2e9, clean: true });
    expect(row(report, 'RQ-LIVE')).toMatchObject({ repo: 'ashlrai/phantom', bytes: null, clean: null });
    // Git is asked only about rows that passed every cheaper gate; sizes only for safe rows.
    expect(deps.isClean.mock.calls.map(([path]) => path).sort()).toEqual(['/wt/RQ-DIRTY', '/wt/RQ-EMPTY', '/wt/RQ-MERGED']);
    expect(deps.measure.mock.calls.map(([path]) => path).sort()).toEqual(['/wt/RQ-EMPTY', '/wt/RQ-MERGED']);
    expect(deps.remove).not.toHaveBeenCalled();
  });

  it('keeps everything when the pin file cannot be trusted', async () => {
    const report = await readWorktrees('list', host({ pinsValid: false }));
    expect(report.sourcesOk).toBe(false);
    expect(new Set(report.rows.filter(r => r.state !== 'live').map(r => r.state))).toEqual(new Set(['kept']));
    expect(report.counts.safe).toBe(0);
  });

  it('respects the keep list: a merged, old, clean worktree on keep.txt stays', async () => {
    const report = await readWorktrees('list', host({ keep: 'RQ-KEPT RQ-MERGED\n' }));
    expect(row(report, 'RQ-MERGED')).toMatchObject({ state: 'kept', safe: false, hold: 'kept' });
  });

  it('marks nothing safe when a safety source cannot be read', async () => {
    const deps = { ...host(), ps: () => null };
    const report = await readWorktrees('list', deps);
    expect(report.sourcesOk).toBe(false);
    expect(report.counts.safe).toBe(0);
    expect(row(report, 'RQ-MERGED').hold).toBe('records-unreadable');
    expect(deps.isClean).not.toHaveBeenCalled();
  });

  it('marks a row not checked when Git cannot answer', async () => {
    const deps = { ...host(), isClean: vi.fn(async () => null) };
    const report = await readWorktrees('list', deps);
    expect(row(report, 'RQ-MERGED')).toMatchObject({ safe: false, hold: 'not-checked', clean: null });
  });

  it('emits stable JSON: same keys in the same order, byte-identical across reads', async () => {
    const first = JSON.stringify(await readWorktrees('list', host()));
    expect(JSON.stringify(await readWorktrees('list', host()))).toBe(first);
    const parsed = JSON.parse(first) as WorktreesReport;
    expect(Object.keys(parsed)).toEqual(['schema', 'generatedAt', 'sourcesOk', 'warnAt', 'counts', 'reclaimableBytes', 'reclaimableComplete', 'mode', 'rows', 'reaper']);
    expect(Object.keys(parsed.rows[0]!)).toEqual(['job', 'repo', 'state', 'ageHours', 'bytes', 'clean', 'safe', 'hold']);
    expect(parsed).toMatchObject({ schema: 'worktrees.v1', generatedAt: '2026-11-17T12:00:00.000Z', warnAt: 40, mode: 'list' });
  });
});

describe('phm worktrees --reap', () => {
  it('dry run changes nothing: no removal, no log', async () => {
    const deps = host();
    const report = await readWorktrees('dry-run', deps);
    expect(report.mode).toBe('dry-run');
    expect(report.removals).toBeUndefined();
    expect(deps.remove).not.toHaveBeenCalled();
    expect(deps.logRemoval).not.toHaveBeenCalled();
    expect(formatWorktrees(report).at(-1)).toBe('Dry run: nothing was removed. Run phm worktrees --reap --apply to remove them.');
  });

  it('apply calls the remover only for safe rows and logs each removal', async () => {
    const deps = host();
    const report = await readWorktrees('apply', deps);
    expect(deps.remove.mock.calls).toEqual([['/wt/RQ-EMPTY', WT], ['/wt/RQ-MERGED', WT]]);
    expect(report.removals).toEqual([{ job: 'RQ-EMPTY', status: 'removed' }, { job: 'RQ-MERGED', status: 'removed' }]);
    expect(deps.logRemoval.mock.calls.map(([entry]) => entry)).toEqual([
      { job: 'RQ-EMPTY', status: 'removed', at: expect.any(String) },
      { job: 'RQ-MERGED', status: 'removed', at: expect.any(String) },
    ]);
  });

  it('refuses a worktree that became dirty after the read, and never removes the dirty or live ones', async () => {
    const dirty = new Set(['RQ-DIRTY']);
    const deps = host({ dirty });
    deps.isClean.mockImplementation(async (path: string) => {
      const job = path.slice(WT.length + 1);
      const clean = !dirty.has(job);
      if (job === 'RQ-MERGED') dirty.add(job); // dirty from the second look on
      return clean;
    });
    const report = await readWorktrees('apply', deps);
    expect(report.removals).toEqual([{ job: 'RQ-EMPTY', status: 'removed' }, { job: 'RQ-MERGED', status: 'refused', reason: 'uncommitted-changes' }]);
    expect(deps.remove.mock.calls.map(([path]) => path)).toEqual(['/wt/RQ-EMPTY']);
    expect(deps.logRemoval).toHaveBeenCalledTimes(2);
  });

  it('reports a failed Git removal with a fixed reason and exits 1', async () => {
    const deps = { ...host(), remove: vi.fn(async () => { throw Object.assign(new Error('fatal: /private/path contains secrets'), { code: 128 }); }) };
    const output = { log: vi.fn(), error: vi.fn() };
    expect(await cmdWorktrees(['--reap', '--apply', '--json'], { ...deps, output })).toBe(1);
    const report = JSON.parse(String(output.log.mock.calls[0]![0])) as WorktreesReport;
    expect(report.removals).toEqual([
      { job: 'RQ-EMPTY', status: 'failed', reason: 'git-remove-failed' },
      { job: 'RQ-MERGED', status: 'failed', reason: 'git-remove-failed' },
    ]);
    expect(JSON.stringify(report)).not.toContain('/private/path');
  });
});

describe('phm worktrees CLI', () => {
  const run = async (args: string[], deps: WorktreesDeps = host()) => {
    const output = { log: vi.fn(), error: vi.fn() };
    const code = await cmdWorktrees(args, { ...deps, output });
    return { code, out: output.log.mock.calls.map(([line]) => String(line)), err: output.error.mock.calls.map(([line]) => String(line)) };
  };

  it('prints one row per worktree and a summary in plain words', async () => {
    const { code, out } = await run([]);
    expect(code).toBe(0);
    expect(out[0]).toBe('JOB\tREPO\tSTATE\tAGE\tSIZE\tSAFE TO REMOVE');
    expect(out).toContain('RQ-EMPTY\tashlr-stack\tempty result\t10 h\t2.0 GB\tyes');
    expect(out).toContain('RQ-DIRTY\tashlrai/phantom\tmerged PR\t10 h\t-\tno, has uncommitted changes');
    expect(out).toContain('9 job worktrees (warning at 40): 2 live job, 3 merged PR, 1 empty result, 1 open PR, 1 kept on purpose, 1 unknown.');
    expect(out).toContain('Safe to remove: 2 (4.0 GB).');
    expect(out.at(-1)).toBe('Run phm worktrees --reap to preview removal.');
  });

  it('--reap lists only the safe rows and removes nothing', async () => {
    const deps = host();
    const { code, out } = await run(['--reap'], deps);
    expect(code).toBe(0);
    expect(out.filter(line => line.startsWith('RQ-'))).toEqual(['RQ-EMPTY\tashlr-stack\tempty result\t10 h\t2.0 GB\tyes', 'RQ-MERGED\tashlrai/phantom\tmerged PR\t10 h\t2.0 GB\tyes']);
    expect(deps.remove).not.toHaveBeenCalled();
  });

  it('says so plainly when there are no job worktrees', async () => {
    const { code, out } = await run([], host({ jobs: {} }));
    expect(code).toBe(0);
    expect(out).toEqual(['No job worktrees.', 'Safe to remove: 0 (0 KB).']);
  });

  it('rejects unknown, duplicate and incomplete flags with exit 2', async () => {
    for (const args of [['--force'], ['--apply'], ['--dry-run'], ['--reap', '--apply', '--dry-run'], ['--json', '--json']]) {
      const deps = host();
      expect((await run(args, deps)).code).toBe(2);
      expect(deps.remove).not.toHaveBeenCalled();
    }
    expect((await run(['--help'])).out[0]).toMatch(/^Usage: phm worktrees \[--json\] \[--reap/);
  });
});

it('apply re-reads the records first: a job relaunched since the read is refused', async () => {
  const jobs = { ...JOBS };
  const deps = host({ jobs });
  let reads = 0;
  const readJobs = deps.readJobs;
  const report = await readWorktrees('apply', {
    ...deps,
    readJobs: async (path: string) => {
      // The second audit sees a fresh launch of RQ-MERGED.
      if (++reads === 2) jobs['RQ-MERGED'] = { rows: [...merged('RQ-MERGED'), launch('RQ-MERGED', 0)] };
      return readJobs(path);
    },
  });
  expect(report.removals).toEqual([{ job: 'RQ-EMPTY', status: 'removed' }, { job: 'RQ-MERGED', status: 'refused', reason: 'state-changed' }]);
  expect(deps.remove.mock.calls.map(([path]) => path)).toEqual(['/wt/RQ-EMPTY']);
});

const logOf = (...rows: Array<[hoursAgo: number, status: string]>) => rows.map(([h, status]) => JSON.stringify({ job: 'RQ-X', status, at: iso(h) })).join('\n');
const withLog = (text: string, state: 'ok' | 'missing' | 'unreadable' = 'ok') => ({ ...host(), readReapLog: vi.fn(async () => ({ state, text })) });

describe('phm worktrees reaper health', () => {
  it('reports a recent run as healthy and lists the eligible merged worktrees', async () => {
    const deps = withLog(logOf([1, 'removed'], [30, 'failed']));
    const { reaper, rows } = await readWorktrees('list', deps);
    expect(reaper).toMatchObject({ state: 'healthy', reason: 'ran-recently', lastRunAgeHours: 1, lastRun: { removed: 1, refused: 0, failed: 0 }, stuckRuns: [], next: null });
    expect(reaper.lastRunAt).toBe(iso(1));
    expect(reaper.eligible).toEqual(['RQ-EMPTY', 'RQ-MERGED']);
    // Never lists live, open, kept, dirty, too-new or unknown worktrees.
    expect(reaper.eligible.every(job => rows.find(r => r.job === job)!.safe)).toBe(true);
  });

  it('flags a stale reaper: eligible work waiting and the last run is over 24 hours old', async () => {
    const { reaper } = await readWorktrees('list', withLog(logOf([30, 'removed'])));
    expect(reaper).toMatchObject({ state: 'stale', reason: 'last-run-old', lastRunAgeHours: 30, eligible: ['RQ-EMPTY', 'RQ-MERGED'] });
    expect(reaper.next).toContain('phm worktrees --reap --apply');
  });

  it('flags a reaper that never ran, and one whose newest batch only failed', async () => {
    expect((await readWorktrees('list', withLog('', 'missing'))).reaper).toMatchObject({ state: 'stale', reason: 'never-ran', lastRunAt: null });
    const failed = (await readWorktrees('list', withLog(logOf([2, 'failed'], [2, 'refused'])))).reaper;
    expect(failed).toMatchObject({ state: 'stale', reason: 'last-run-failed', lastRun: { removed: 0, refused: 1, failed: 1 } });
  });

  it('is healthy with nothing eligible even if the reaper never ran', async () => {
    const jobs = { 'RQ-OPEN': JOBS['RQ-OPEN']! };
    const deps = { ...host({ jobs }), readReapLog: async () => ({ state: 'missing' as const, text: '' }) };
    expect((await readWorktrees('list', deps)).reaper).toMatchObject({ state: 'healthy', reason: 'nothing-to-reap', eligible: [] });
  });

  it('reports unknown, not stale, when records or the log cannot be read', async () => {
    expect((await readWorktrees('list', { ...withLog(''), ps: () => null })).reaper).toMatchObject({ state: 'unknown', reason: 'sources-unreadable', eligible: [] });
    expect((await readWorktrees('list', withLog('', 'unreadable'))).reaper).toMatchObject({ state: 'unknown', reason: 'log-unreadable' });
  });

  it('diagnoses a stuck publisher marker without touching or listing it for removal', async () => {
    const jobs = { ...JOBS, 'RQ-STUCK': { rows: merged('RQ-STUCK'), mtimeHours: 10 } };
    const deps = { ...host({ jobs, runEntries: ['RQ-STUCK.reaping'] }), readReapLog: async () => ({ state: 'ok' as const, text: logOf([1, 'removed']) }) };
    const report = await readWorktrees('list', deps);
    expect(report.reaper).toMatchObject({ state: 'stale', reason: 'stuck-run', stuckRuns: ['RQ-STUCK'] });
    expect(report.reaper.eligible).not.toContain('RQ-STUCK');
    expect(row(report, 'RQ-STUCK')).toMatchObject({ state: 'live', safe: false, hold: 'live-job' });
    expect(deps.remove).not.toHaveBeenCalled();
  });

  it('a read-only list and dry run delete nothing, even when the reaper is stale', async () => {
    for (const mode of ['list', 'dry-run'] as const) {
      const deps = withLog('', 'missing');
      await readWorktrees(mode, deps);
      expect(deps.remove).not.toHaveBeenCalled();
      expect(deps.logRemoval).not.toHaveBeenCalled();
    }
  });

  it('prints one plain reaper line and next step, and exposes the same data in --json', async () => {
    const lines = formatWorktrees(await readWorktrees('list', withLog(logOf([30, 'removed']))));
    expect(lines).toContain('Reaper: stale (last ran 30 h ago).');
    expect(lines.some(l => l.includes('phm worktrees --reap --apply'))).toBe(true);
    const logs: string[] = [];
    await cmdWorktrees(['--json'], { ...withLog(''), output: { log: s => logs.push(s), error: () => undefined } });
    expect(JSON.parse(logs[0]!).reaper.state).toBe('stale');
  });
});
