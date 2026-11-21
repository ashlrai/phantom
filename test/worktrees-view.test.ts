/** Hermetic tests for `phm worktrees`: the real audit runs over an in-memory host; Git is never called. */
import { describe, expect, it, vi } from 'vitest';
import { cmdWorktrees } from '../src/cli/worktrees.js';
import { WORKTREES_SAFE_AGE_HOURS, formatWorktrees, readWorktrees, worktreeRemoveCommands, type WorktreesDeps, type WorktreesReport } from '../src/core/fleet/worktrees.js';
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
  'RQ-NEW': { rows: merged('RQ-NEW', 1), mtimeHours: 1 },
  'RQ-LIVEMERGED': { rows: merged('RQ-LIVEMERGED') },
};

interface Host { jobs?: typeof JOBS; keep?: string; pinsValid?: boolean; dirty?: Set<string> }

/** Fully readable fake host; every reader, the clean check, the remover and the log are spies. */
function host({ jobs = JOBS, keep = 'RQ-KEPT\n', pinsValid = true, dirty = new Set(['RQ-DIRTY']) }: Host = {}) {
  const names = ['guardian-claude', ...Object.keys(jobs)];
  const files: Record<string, string> = { [`${RUNS}/queue/status.json`]: '{}', [`${RUNS}/queue/keep.txt`]: keep };
  const fs: WtAuditFs = {
    dirs: async path => (path === WT ? [...names] : []),
    entries: async path => (path === RUNS ? ['queue', 'metrics'] : path === `${RUNS}/queue` ? ['status.json', 'keep.txt', 'run'] : path === `${RUNS}/queue/run` ? [] : null),
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
      ['RQ-UNKNOWN', 'unknown', false, 'no-publish-record'],
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
    expect(Object.keys(parsed)).toEqual(['schema', 'generatedAt', 'sourcesOk', 'warnAt', 'counts', 'reclaimableBytes', 'reclaimableComplete', 'mode', 'rows']);
    expect(Object.keys(parsed.rows[0]!)).toEqual(['job', 'repo', 'state', 'ageHours', 'bytes', 'clean', 'exitOnly', 'safe', 'hold']);
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

describe('age rule per class', () => {
  const aged = (hours: number, rows: (job: string, h: number) => unknown[]) =>
    ({ 'RQ-AGED': { rows: rows('RQ-AGED', hours), mtimeHours: hours } });
  const emptyRows = (job: string, h: number) => [launch(job, h + 1), { event: 'finish', job, empty: true, ts: iso(h) }];
  const verdict = async (jobs: typeof JOBS) => row(await readWorktrees('list', host({ jobs, dirty: new Set() })), 'RQ-AGED');

  it('names two hours for merged and empty', () => {
    expect(WORKTREES_SAFE_AGE_HOURS).toEqual({ merged: 2, empty: 2 });
  });

  it.each([['merged', merged], ['empty', emptyRows]] as const)('a %s worktree is safe at 2 h and held just under', async (_state, rows) => {
    expect(await verdict(aged(2, rows))).toMatchObject({ safe: true, hold: null });
    expect(await verdict(aged(1.9, rows))).toMatchObject({ safe: false, hold: 'too-new' });
    // The old 6 h rule no longer applies.
    expect(await verdict(aged(5, rows))).toMatchObject({ safe: true });
  });

  it('says how young a held row is in plain words', async () => {
    const report = await readWorktrees('list', host({ jobs: aged(1.5, merged), dirty: new Set() }));
    expect(formatWorktrees(report)).toContain('RQ-AGED\tashlrai/phantom\tmerged PR\t2 h\t-\tno, under 2 hours old');
  });

  it('live and open-PR worktrees stay held however old they are', async () => {
    const jobs = {
      'RQ-LIVE': { rows: [launch('RQ-LIVE', 40)], mtimeHours: 40 },
      'RQ-OPEN': { rows: [launch('RQ-OPEN', 40), { event: 'outcome', job: 'RQ-OPEN', state: 'OPEN', ts: iso(39) }], mtimeHours: 40 },
    };
    const report = await readWorktrees('list', host({ jobs, dirty: new Set() }));
    expect(report.rows.map(r => [r.job, r.safe])).toEqual([['RQ-LIVE', false], ['RQ-OPEN', false]]);
  });
});

describe('phm worktrees --reap --plan', () => {
  const run = async (args: string[], deps: WorktreesDeps = host()) => {
    const output = { log: vi.fn(), error: vi.fn() };
    const code = await cmdWorktrees(args, { ...deps, output });
    return { code, out: output.log.mock.calls.map(([line]) => String(line)), err: output.error.mock.calls.map(([line]) => String(line)) };
  };

  it('prints only the removal commands for a mixed set and removes nothing', async () => {
    const deps = host();
    const { code, out } = await run(['--reap', '--plan'], deps);
    expect(code).toBe(0);
    expect(out).toEqual(['git -C /wt/RQ-EMPTY worktree remove /wt/RQ-EMPTY', 'git -C /wt/RQ-MERGED worktree remove /wt/RQ-MERGED']);
    expect(out.join('\n')).not.toContain('--force');
    expect(deps.remove).not.toHaveBeenCalled();
    expect(deps.logRemoval).not.toHaveBeenCalled();
  });

  it('never lists a live, open-PR, kept, dirty or too-new worktree', async () => {
    const { out } = await run(['--reap', '--plan']);
    for (const job of ['RQ-LIVE', 'RQ-LIVEMERGED', 'RQ-OPEN', 'RQ-KEPT', 'RQ-DIRTY', 'RQ-NEW', 'RQ-UNKNOWN']) {
      expect(out.join('\n')).not.toContain(job);
    }
  });

  it('JSON lists the same commands', async () => {
    const text = await run(['--reap', '--plan']);
    const json = await run(['--reap', '--plan', '--json']);
    expect(JSON.parse(json.out[0]!)).toEqual({ schema: 'worktrees.plan.v1', commands: text.out });
  });

  it('prints nothing when nothing is safe, and quotes odd paths', async () => {
    expect((await run(['--reap', '--plan'], { ...host(), ps: () => null })).out).toEqual([]);
    const report = await readWorktrees('list', host());
    expect(worktreeRemoveCommands(report, "/my wt/it's")[0]).toBe(`git -C '/my wt/it'\\''s/RQ-EMPTY' worktree remove '/my wt/it'\\''s/RQ-EMPTY'`);
  });

  it('needs --reap and excludes the other modes', async () => {
    for (const args of [['--plan'], ['--reap', '--plan', '--apply'], ['--reap', '--plan', '--status'], ['--reap', '--plan', '--dry-run']]) {
      expect((await run(args)).code).toBe(2);
    }
  });

  it('the list summary names the plan command when over the warning level', async () => {
    const jobs: typeof JOBS = {};
    for (let i = 0; i < 41; i++) jobs[`RQ-J${i}`] = { rows: merged(`RQ-J${i}`) };
    const report = await readWorktrees('list', host({ jobs, dirty: new Set() }));
    expect(formatWorktrees(report)).toContain('Over the warning level. Run phm worktrees --reap --plan for the removal commands.');
    expect(formatWorktrees(await readWorktrees('list', host()))).not.toContain('Over the warning level.');
  });
});

/** Finished jobs with no job-ledger rows: only the plain run records tell them apart. */
describe('phm worktrees: reading run records', () => {
  const REC_NOW = NOW;
  type Records = { publish?: string; rc?: boolean; ageHours?: number };
  function recordHost(jobs: Record<string, Records>, extra: { unpushed?: Set<string>; dirty?: Set<string> } = {}) {
    const names = Object.keys(jobs);
    const files: Record<string, string> = { [`${RUNS}/queue/status.json`]: '{}' };
    const runs = ['queue', 'metrics'];
    const runDir: string[] = [];
    for (const [name, rec] of Object.entries(jobs)) {
      if (rec.publish !== undefined) { files[`${RUNS}/${name}.publish`] = rec.publish; runs.push(`${name}.publish`); }
      if (rec.rc) runDir.push(`${name}.rc`);
    }
    const fs: WtAuditFs = {
      dirs: async path => (path === WT ? names : []),
      entries: async path => (path === RUNS ? runs : path === `${RUNS}/queue` ? ['status.json', 'run'] : path === `${RUNS}/queue/run` ? runDir : null),
      text: async path => files[path] ?? null,
      mtime: async path => {
        const name = path.startsWith(`${WT}/`) ? path.slice(WT.length + 1) : path.split('/').pop()!.replace(/\..*$/, '');
        return REC_NOW - (jobs[name]?.ageHours ?? 10) * HOUR;
      },
      real: async path => path,
    };
    return {
      now: REC_NOW, wtRoot: WT, runsRoot: RUNS, fs,
      readJobs: async () => ({ state: 'healthy' as const, text: '' }),
      ps: () => '', readPins: () => ({ paths: [], valid: true }),
      isClean: vi.fn(async (path: string) => !(extra.dirty ?? new Set()).has(path.slice(WT.length + 1))),
      hasUnpushed: vi.fn(async (path: string) => (extra.unpushed ?? new Set()).has(path.slice(WT.length + 1))),
      measure: vi.fn(() => ({ bytes: 1e6, complete: true })),
      remove: vi.fn(async () => undefined), logRemoval: vi.fn(async () => undefined),
    } satisfies WorktreesDeps;
  }

  it('reaps an EMPTY publish; keeps RESULT PR as an open PR', async () => {
    const report = await readWorktrees('list', recordHost({
      'RQ-EMPTYPUB': { publish: 'RESULT EMPTY nothing to publish\n' },
      'RQ-PRPUB': { publish: 'RESULT PR https://github.com/ashlrai/phantom/pull/1\n' },
    }));
    expect(row(report, 'RQ-EMPTYPUB')).toMatchObject({ state: 'empty', safe: true, hold: null });
    expect(row(report, 'RQ-PRPUB')).toMatchObject({ state: 'open', safe: false, hold: 'open-pr' });
  });

  it('treats an exit code with no live process and no PR as finished, once the branch is pushed', async () => {
    const deps = recordHost({ 'RQ-RCONLY': { rc: true }, 'RQ-RCLOST': { rc: true } }, { unpushed: new Set(['RQ-RCLOST']) });
    const report = await readWorktrees('list', deps);
    expect(row(report, 'RQ-RCONLY')).toMatchObject({ state: 'empty', exitOnly: true, safe: true, hold: null });
    expect(row(report, 'RQ-RCLOST')).toMatchObject({ safe: false, hold: 'unpushed-commits' });
    // The unpushed check runs only for exit-code-only rows.
    const empty = recordHost({ 'RQ-EMPTYPUB': { publish: 'RESULT EMPTY\n' } });
    await readWorktrees('list', empty);
    expect(empty.hasUnpushed).not.toHaveBeenCalled();
  });

  it('keeps a finished job with uncommitted changes, and one whose exit code is too new', async () => {
    const report = await readWorktrees('list', recordHost(
      { 'RQ-RCDIRTY': { rc: true }, 'RQ-RCNEW': { rc: true, ageHours: 0.1 } }, { dirty: new Set(['RQ-RCDIRTY']) }));
    expect(row(report, 'RQ-RCDIRTY')).toMatchObject({ safe: false, hold: 'uncommitted-changes' });
    expect(row(report, 'RQ-RCNEW')).toMatchObject({ safe: false, hold: 'too-new' });
  });

  it('splits unknowns by plain reason', async () => {
    const report = await readWorktrees('list', recordHost({ 'RQ-NOREC': {}, 'RQ-BADREC': { publish: 'garbled\n' } }));
    expect(row(report, 'RQ-NOREC')).toMatchObject({ state: 'unknown', hold: 'no-publish-record' });
    expect(row(report, 'RQ-BADREC')).toMatchObject({ state: 'unknown', hold: 'publish-unreadable' });
    expect(formatWorktrees(report).join('\n')).toContain('no, no publish record');
  });

  it('apply refuses an exit-only row whose branch gained unpushed commits after the read', async () => {
    const deps = recordHost({ 'RQ-RCONLY': { rc: true } });
    deps.hasUnpushed.mockImplementation(async () => deps.hasUnpushed.mock.calls.length > 1); // clean on the first look only
    const report = await readWorktrees('apply', deps);
    expect(report.removals).toEqual([{ job: 'RQ-RCONLY', status: 'refused', reason: 'unpushed-commits' }]);
    expect(deps.remove).not.toHaveBeenCalled();
  });
});
