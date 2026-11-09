/** Hermetic tests for `phm fleet wt-audit` — every reader is injected. */
import { describe, expect, it } from 'vitest';
import {
  classifyEntry, classifyPublishText, formatWtAudit, formatWtReapPlan,
  mergedUrlsFromLedger, parseAuditLedger, parseKeepList, parsePsJobs,
  parseStatusEvidence, readWtAudit,
  type ReadWtAuditOptions, type WtAuditFs, type WtEvidence,
} from '../src/core/fleet/wt-audit.js';
import { cmdFleetWtAudit } from '../src/cli/fleet-wt-audit.js';
import type { KeptWorktrees } from '../src/core/worktree-retention.js';

const NOW = Date.parse('2026-11-07T12:00:00Z');
const HOUR = 3_600_000;
const WT = '/wt';
const RUNS = '/runs';
const RUN = `${RUNS}/queue/run`;

const iso = (ms: number) => new Date(ms).toISOString();
const launch = (job: string, hours: number) => ({ event: 'launch', job, ts: iso(NOW - hours * HOUR) });
const finish = (job: string, hours: number, empty = false) =>
  ({ event: 'finish', job, empty, ts: iso(NOW - hours * HOUR) });
const outcome = (job: string, state: string, hours = 1, url?: string) =>
  ({ event: 'outcome', job, state, ts: iso(NOW - hours * HOUR), ...(url ? { url } : {}) });
const publish = (job: string, cls: string, hours = 1, url?: string) =>
  ({ event: 'publish', job, class: cls, ts: iso(NOW - hours * HOUR), ...(url ? { url } : {}) });
const jobsText = (rows: unknown[]) => rows.map(r => JSON.stringify(r)).join('\n') + '\n';
const baseText = (job: string, pool = 'devin', wt = `${WT}/${job}`) => `deadbeef main ${wt} ${pool}\n`;

interface FakeSpec {
  dirs?: Record<string, string[]>;
  entries?: Record<string, string[] | null>;
  files?: Record<string, string>;
  mtimes?: Record<string, number>;
  real?: Record<string, string>;
  failDirs?: boolean;
}
const fakeFs = (spec: FakeSpec): WtAuditFs => ({
  dirs: async path => (spec.failDirs ? null : (spec.dirs?.[path] ?? [])),
  entries: async path => spec.entries?.[path] ?? null,
  text: async path => spec.files?.[path] ?? null,
  mtime: async path => spec.mtimes?.[path] ?? null,
  real: async path => spec.real?.[path] ?? path,
});

interface FakeOptions extends ReadWtAuditOptions {
  rows?: unknown[];
  psText?: string | null;
  pins?: KeptWorktrees;
  bytes?: number;
}

const QUEUE = `${RUNS}/queue`;
const old = NOW - 10 * HOUR;
/** A fully-readable fake host: healthy jobs/status/keep/run/ps/pins unless
 * overridden. Directory listings are derived from the files map so a spec
 * only names the files it cares about; spec.entries still overrides. */
const healthyDeps = (spec: FakeSpec, options: FakeOptions = {}): ReadWtAuditOptions => {
  const { rows = [], psText = 'node dispatchd.py --tick\n', pins = { paths: [], valid: true }, bytes = 1e9, ...rest } = options;
  const files = { [`${RUNS}/queue/status.json`]: '{}', ...spec.files };
  const children = (dir: string) => Object.keys(files)
    .filter(p => p.slice(0, p.lastIndexOf('/')) === dir)
    .map(p => p.slice(p.lastIndexOf('/') + 1));
  // spec.entries wins; an explicit null marks the listing unreadable.
  const listed = (dir: string, fallback: string[]): string[] | null =>
    spec.entries && Object.hasOwn(spec.entries, dir) ? (spec.entries[dir] ?? null) : fallback;
  const runsListing = listed(RUNS, children(RUNS));
  const queueListing = listed(QUEUE, children(QUEUE));
  return {
    now: NOW,
    wtRoot: WT,
    runsRoot: RUNS,
    fs: fakeFs({
      dirs: spec.dirs,
      entries: {
        // 'queue' and 'run' are structural: dispatchd creates them with the
        // runs root, so any readable parent listing contains them.
        [RUNS]: runsListing === null ? null : [...runsListing, 'queue'],
        [QUEUE]: queueListing === null ? null : [...queueListing, 'run'],
        [RUN]: listed(RUN, []),
      },
      files,
      mtimes: { ...Object.fromEntries((spec.dirs?.[WT] ?? []).map(d => [`${WT}/${d}`, old])), ...spec.mtimes },
      real: spec.real,
      failDirs: spec.failDirs,
    }),
    readJobs: async () => ({ state: 'healthy', text: jobsText(rows) }),
    ps: () => psText,
    readPins: () => pins,
    measure: () => ({ bytes, complete: true }),
    ...rest,
  };
};

const ev = (partial: Partial<WtEvidence>): WtEvidence => ({
  name: 'RQ-X', pool: null, baseMatch: false, dispatched: false, rc: false, pid: false,
  reapingMarker: false, publish: null, ledger: undefined, ledgerMergedUrl: false,
  evidenceMs: old, statusNamed: false, statusKept: false, statusReaping: false,
  keepListed: false, pinned: false, psAlive: false, psReaping: false, psPublishing: false,
  ...partial,
});
const ctx = (degraded: Partial<Record<'jobs' | 'status' | 'ps' | 'pins' | 'runs' | 'keep' | 'run', boolean>> = {}) =>
  ({ now: NOW, degraded: { jobs: false, status: false, ps: false, pins: false, runs: false, keep: false, run: false, ...degraded } });

describe('parseAuditLedger', () => {
  it('tracks rows, finish, outcome and publish per attempt', () => {
    const map = parseAuditLedger(jobsText([
      launch('RQ-A', 30), finish('RQ-A', 20), outcome('RQ-A', 'MERGED', 10, 'https://github.com/o/r/pull/1'),
      publish('RQ-B', 'pr', 5, 'https://github.com/o/r/pull/2'), finish('RQ-B', 6, true),
    ]));
    expect(map.get('RQ-A')).toMatchObject({ rows: 3, outcomeState: 'merged', finishSeen: true });
    expect(map.get('RQ-B')).toMatchObject({ rows: 2, publishClass: 'pr', finishEmpty: true });
  });

  it('a new launch drops earlier attempt evidence but keeps row count', () => {
    const map = parseAuditLedger(jobsText([finish('RQ-A', 30), outcome('RQ-A', 'MERGED', 25), launch('RQ-A', 2)]));
    const a = map.get('RQ-A')!;
    expect(a.rows).toBe(3);
    expect(a.outcomeState).toBeNull();
    expect(a.finishSeen).toBe(false);
    expect(a.launchMs).not.toBeNull();
  });

  it('records a ts-less finish via finishSeen and skips torn rows', () => {
    const map = parseAuditLedger('broken\n{"event":"finish","job":"RQ-A"}\nnull\n{"event":"finish","job":"bad/id"}\n');
    expect(map.get('RQ-A')).toMatchObject({ rows: 1, finishSeen: true, finishMs: null });
    expect(map.has('bad/id')).toBe(false);
  });
});

describe('mergedUrlsFromLedger', () => {
  it('collects urls only from MERGED outcome rows', () => {
    const urls = mergedUrlsFromLedger(jobsText([
      outcome('A', 'MERGED', 1, 'https://github.com/o/r/pull/9'),
      outcome('B', 'CLOSED', 1, 'https://github.com/o/r/pull/10'),
      publish('C', 'pr', 1, 'https://github.com/o/r/pull/11'),
    ]));
    expect([...urls]).toEqual(['https://github.com/o/r/pull/9']);
  });
});

describe('classifyPublishText', () => {
  it('classifies the last RESULT line like reap-one.sh', () => {
    expect(classifyPublishText('noise\nRESULT PR https://github.com/o/r/pull/3\n')?.class).toBe('pr');
    expect(classifyPublishText('RESULT EMPTY (dispatchd: no changes, publish skipped)')?.class).toBe('empty');
    expect(classifyPublishText('RESULT ARCHIVED abc123')?.class).toBe('archived');
    expect(classifyPublishText('RESULT DENIED lane')?.class).toBe('denied');
    expect(classifyPublishText('RESULT ABORT PUBLISH-ABORT secret-shape')?.class).toBe('secret-shape');
    expect(classifyPublishText('RESULT ABORT push_failed')?.class).toBe('abort');
    expect(classifyPublishText('RESULT SOMETHING-ELSE')?.class).toBe('other');
  });
  it('returns null without a RESULT line', () => {
    expect(classifyPublishText('progress only\n')).toBeNull();
    expect(classifyPublishText(null)).toBeNull();
  });
});

describe('parsePsJobs', () => {
  const roots = { wtRoot: WT, runsRoot: RUNS };
  it('maps publish.sh/reap-one.sh to in-flight and worktree/launch/prompt to alive', () => {
    const ps = parsePsJobs([
      '/bin/bash /runs/bin/reap-one.sh RQ-REAP',
      'bash publish.sh RQ-PUB',
      '/bin/bash /runs/bin/launch.sh RQ-LIVE --pool devin',
      'node agent.js --cwd /wt/RQ-WD/src',
      `vim ${RUNS}/RQ-PROMPT.prompt`,
      'python3 /mac/dispatchd.py --tick RQ-WD',
    ].join('\n'), roots);
    expect(ps.reaping.has('RQ-REAP')).toBe(true);
    expect(ps.publishing.has('RQ-PUB')).toBe(true);
    expect([...ps.alive].sort()).toEqual(['RQ-LIVE', 'RQ-PROMPT', 'RQ-WD']);
  });
});

describe('parseStatusEvidence / parseKeepList', () => {
  it('keeps only valid job ids and preserves raw text', () => {
    const s = parseStatusEvidence(JSON.stringify({ kept_worktrees: ['RQ-K', 'bad name'], reaping: ['RQ-R'] }));
    expect([...s.kept]).toEqual(['RQ-K']);
    expect([...s.reaping]).toEqual(['RQ-R']);
    expect(s.raw).not.toBeNull();
    expect(parseStatusEvidence(null).raw).toBeNull();
    expect(parseKeepList('RQ-A RQ-B\nRQ-C\tbad//id')).toEqual(new Set(['RQ-A', 'RQ-B', 'RQ-C']));
  });
});

describe('classifyEntry', () => {
  it('merged goes worktree-remove; published/empty/finished with .base go reap-one', () => {
    const merged = classifyEntry(ev({ ledger: { rows: 2, outcomeState: 'merged' } as WtEvidence['ledger'] }), ctx());
    expect([merged.state, merged.via]).toEqual(['merged', 'worktree-remove']);
    const pub = classifyEntry(ev({ baseMatch: true, publish: { class: 'pr', url: 'u' } }), ctx());
    expect([pub.state, pub.via]).toEqual(['published', 'reap-one']);
    const fin = classifyEntry(ev({ baseMatch: true, rc: true }), ctx());
    expect([fin.state, fin.via]).toEqual(['finished', 'reap-one']);
  });

  it('published/empty without .base still reap via worktree-remove; finished without .base never does', () => {
    expect(classifyEntry(ev({ publish: { class: 'pr', url: 'u' } }), ctx()).via).toBe('worktree-remove');
    const orphanFinish = classifyEntry(ev({ rc: true }), ctx());
    expect(orphanFinish.via).toBeNull();
    expect(orphanFinish.blockers).toContain('unfinished-no-base');
  });

  it('an outcome row outranks the publish class', () => {
    const ledger = { rows: 3, outcomeState: 'closed' } as WtEvidence['ledger'];
    expect(classifyEntry(ev({ baseMatch: true, publish: { class: 'pr', url: 'u' }, ledger }), ctx()).state).toBe('ended');
    const open = classifyEntry(ev({ publish: { class: 'empty', url: null }, ledger: { rows: 3, outcomeState: 'open' } as WtEvidence['ledger'] }), ctx());
    expect(open.state).toBe('open');
  });

  it('never plans running, in-flight, held, archived, orphaned or fresh worktrees', () => {
    const cases: Array<[Partial<WtEvidence>, string, string]> = [
      [{ dispatched: true }, 'running', 'running:dispatched'],
      [{ pid: true }, 'running', 'running:pid'],
      [{ psAlive: true }, 'running', 'running:process'],
      [{ statusNamed: true }, 'running', 'running:status-named'],
      [{ reapingMarker: true }, 'reaping', 'in-flight:reaping'],
      [{ psPublishing: true }, 'publishing', 'in-flight:publishing'],
      [{ statusKept: true }, 'held', 'held:status'],
      [{ keepListed: true }, 'held', 'held:keep-txt'],
      [{ pinned: true }, 'held', 'held:pinned'],
      [{ publish: { class: 'denied', url: null } }, 'held', 'held:publish-denied'],
      [{ publish: { class: 'archived', url: null } }, 'archived', 'held:publish-archived'],
      [{}, 'orphaned', 'no-evidence'],
    ];
    for (const [partial, state, blocker] of cases) {
      const entry = classifyEntry(ev(partial), ctx());
      expect(entry.state).toBe(state);
      expect(entry.reapable).toBe(false);
      expect(entry.blockers).toContain(blocker);
    }
    const fresh = classifyEntry(ev({ baseMatch: true, publish: { class: 'pr', url: 'u' }, evidenceMs: NOW - 1000 }), ctx());
    expect(fresh.reapable).toBe(false);
    expect(fresh.blockers).toContain('fresh');
  });

  it('degraded global sources strip eligibility from every candidate', () => {
    const good = ev({ baseMatch: true, publish: { class: 'pr', url: 'u' } });
    for (const key of ['jobs', 'status', 'ps', 'pins', 'runs', 'keep', 'run'] as const) {
      const entry = classifyEntry(good, ctx({ [key]: true }));
      expect(entry.reapable).toBe(false);
      expect(entry.blockers.some(b => b.includes('unreadable') || b.includes('unavailable'))).toBe(true);
    }
  });
});

describe('readWtAudit', () => {
  it('classifies a fleet of mixed states and totals bytes', async () => {
    const r = await readWtAudit(healthyDeps({
      dirs: { [WT]: ['RQ-MERGED', 'RQ-PUB', 'RQ-FIN', 'RQ-RUN', 'RQ-REAP', 'RQ-HELD', 'RQ-ARCH', 'RQ-ORPH', 'guardian-x', '.hidden'] },
      entries: {
        [RUNS]: ['RQ-MERGED.base', 'RQ-MERGED.publish', 'RQ-PUB.base', 'RQ-PUB.publish', 'RQ-FIN.base', 'RQ-ARCH.base', 'RQ-ARCH.publish'],
        [RUN]: ['RQ-RUN.dispatched', 'RQ-REAP.reaping', 'RQ-FIN.rc'],
      },
      files: {
        [`${RUNS}/queue/status.json`]: JSON.stringify({ kept_worktrees: ['RQ-HELD'] }),
        [`${RUNS}/RQ-MERGED.base`]: baseText('RQ-MERGED'),
        [`${RUNS}/RQ-MERGED.publish`]: 'RESULT PR https://github.com/o/r/pull/1\n',
        [`${RUNS}/RQ-PUB.base`]: baseText('RQ-PUB'),
        [`${RUNS}/RQ-PUB.publish`]: 'RESULT PR https://github.com/o/r/pull/2\n',
        [`${RUNS}/RQ-FIN.base`]: baseText('RQ-FIN'),
        [`${RUNS}/RQ-ARCH.base`]: baseText('RQ-ARCH'),
        [`${RUNS}/RQ-ARCH.publish`]: 'RESULT ARCHIVED f00d\n',
      },
      mtimes: { [`${RUN}/RQ-FIN.rc`]: old },
    }, {
      rows: [finish('RQ-MERGED', 20), outcome('RQ-MERGED', 'MERGED', 15), finish('RQ-PUB', 9), finish('RQ-FIN', 5)],
    }));
    const byName = new Map(r.worktrees.map(w => [w.name, w]));
    expect(byName.get('RQ-MERGED')).toMatchObject({ state: 'merged', via: 'worktree-remove', reapable: true, pool: 'devin' });
    expect(byName.get('RQ-PUB')).toMatchObject({ state: 'published', via: 'reap-one', reapable: true });
    expect(byName.get('RQ-FIN')).toMatchObject({ state: 'finished', via: 'reap-one', reapable: true });
    expect(byName.get('RQ-RUN')).toMatchObject({ state: 'running', reapable: false });
    expect(byName.get('RQ-REAP')).toMatchObject({ state: 'reaping', reapable: false });
    expect(byName.get('RQ-HELD')).toMatchObject({ state: 'held', reapable: false });
    expect(byName.get('RQ-ARCH')).toMatchObject({ state: 'archived', reapable: false });
    expect(byName.get('RQ-ORPH')).toMatchObject({ state: 'orphaned', reapable: false });
    expect(byName.get('guardian-x')).toMatchObject({ state: 'excluded' });
    expect(byName.get('.hidden')).toMatchObject({ state: 'excluded' });
    expect(byName.get('RQ-ORPH')!.blockers).toContain('no-evidence');
    expect(r.totals).toMatchObject({ worktrees: 10, reapable: 3 });
    expect(r.sources).toMatchObject({ worktrees: 'healthy', jobs: 'healthy', ps: 'healthy', pins: 'valid', sized: true });
  });

  it('a mismatched .base worktree path is not its job evidence', async () => {
    const r = await readWtAudit(healthyDeps({
      dirs: { [WT]: ['RQ-A'] },
      entries: { [RUNS]: ['RQ-A.base'] },
      files: { [`${RUNS}/RQ-A.base`]: baseText('RQ-A', 'devin', '/elsewhere/RQ-A') },
    }));
    expect(r.worktrees[0]).toMatchObject({ state: 'orphaned', reapable: false });
  });

  it('a realpath alias still counts as the same worktree', async () => {
    const r = await readWtAudit(healthyDeps({
      dirs: { [WT]: ['RQ-A'] },
      entries: { [RUNS]: ['RQ-A.base', 'RQ-A.publish'] },
      files: {
        [`${RUNS}/RQ-A.base`]: baseText('RQ-A', 'devin', '/alias/wt/RQ-A'),
        [`${RUNS}/RQ-A.publish`]: 'RESULT PR https://github.com/o/r/pull/4\n',
      },
      real: { '/alias/wt/RQ-A': `${WT}/RQ-A` },
    }));
    expect(r.worktrees[0]).toMatchObject({ state: 'published', via: 'reap-one' });
  });

  it('unreadable safety sources keep states honest but plan nothing', async () => {
    const spec: FakeSpec = {
      dirs: { [WT]: ['RQ-A'] },
      entries: { [RUNS]: ['RQ-A.base', 'RQ-A.publish'], [RUN]: [] },
      files: { [`${RUNS}/RQ-A.base`]: baseText('RQ-A'), [`${RUNS}/RQ-A.publish`]: 'RESULT PR https://github.com/o/r/pull/5\n' },
    };
    const degraded: ReadWtAuditOptions[] = [
      healthyDeps(spec, { readJobs: async () => ({ state: 'degraded', text: '' }) }),
      healthyDeps({ ...spec, files: { ...spec.files, [`${RUNS}/queue/status.json`]: undefined as unknown as string } }),
      healthyDeps(spec, { psText: null }),
      healthyDeps(spec, { pins: { paths: [], valid: false } }),
      // The runs-dir listing itself unreadable: .base/.publish can't be proven.
      healthyDeps({ ...spec, entries: { ...spec.entries, [RUNS]: null } }),
      // queue/run unreadable: .dispatched/.rc/.pid/.reaping can't be proven absent.
      healthyDeps({ ...spec, entries: { ...spec.entries, [RUN]: null } }),
      // keep.txt present but unreadable: a hold could be hidden.
      healthyDeps({
        ...spec,
        files: { ...spec.files, [`${RUNS}/queue/keep.txt`]: undefined as unknown as string },
      }),
    ];
    for (const deps of degraded) {
      const r = await readWtAudit(deps);
      expect(r.worktrees[0]!.reapable).toBe(false);
      expect(r.worktrees[0]!.via).toBeNull();
    }
  });

  it('a keep.txt entry holds the worktree', async () => {
    const r = await readWtAudit(healthyDeps({
      dirs: { [WT]: ['RQ-K'] },
      files: {
        [`${RUNS}/queue/keep.txt`]: 'RQ-K\n',
        [`${RUNS}/RQ-K.base`]: baseText('RQ-K'),
        [`${RUNS}/RQ-K.publish`]: 'RESULT PR https://github.com/o/r/pull/8\n',
      },
    }));
    expect(r.worktrees[0]).toMatchObject({ state: 'held', reapable: false });
    expect(r.worktrees[0]!.blockers).toContain('held:keep-txt');
  });

  it('a name in status.json keeps a finished worktree out of the plan', async () => {
    const r = await readWtAudit(healthyDeps({
      dirs: { [WT]: ['RQ-N'] },
      entries: { [RUNS]: ['RQ-N.base'], [RUN]: ['RQ-N.rc'] },
      files: {
        [`${RUNS}/queue/status.json`]: JSON.stringify({ lanes: { devin: { running: ['RQ-N'] } } }),
        [`${RUNS}/RQ-N.base`]: baseText('RQ-N'),
      },
    }));
    expect(r.worktrees[0]).toMatchObject({ state: 'running', reapable: false });
    expect(r.worktrees[0]!.blockers).toContain('running:status-named');
  });

  it('a ps row for a live job keeps its worktree running even with stale markers', async () => {
    const r = await readWtAudit(healthyDeps({
      dirs: { [WT]: ['RQ-LIVE'] },
      entries: { [RUNS]: ['RQ-LIVE.base'] },
      files: { [`${RUNS}/RQ-LIVE.base`]: baseText('RQ-LIVE') },
    }, { psText: `node agent.js --cwd ${WT}/RQ-LIVE\n`, rows: [finish('RQ-LIVE', 30)] }));
    expect(r.worktrees[0]).toMatchObject({ state: 'running', reapable: false });
  });

  it('a new launch revokes an old merged outcome', async () => {
    const r = await readWtAudit(healthyDeps({
      dirs: { [WT]: ['RQ-A'] },
      entries: { [RUNS]: ['RQ-A.base'] },
      files: { [`${RUNS}/RQ-A.base`]: baseText('RQ-A') },
    }, { rows: [finish('RQ-A', 30), outcome('RQ-A', 'MERGED', 25), launch('RQ-A', 2)] }));
    expect(r.worktrees[0]).toMatchObject({ state: 'recorded', reapable: false });
  });

  it('--reap-plan lists only eligible worktrees with their via', async () => {
    const r = await readWtAudit(healthyDeps({
      dirs: { [WT]: ['RQ-M', 'RQ-H', 'RQ-O'] },
      entries: { [RUNS]: ['RQ-M.publish'], [RUN]: [] },
      files: {
        [`${RUNS}/queue/status.json`]: JSON.stringify({ kept_worktrees: ['RQ-H'] }),
        [`${RUNS}/RQ-M.publish`]: 'RESULT PR https://github.com/o/r/pull/6\n',
      },
    }, { wantPlan: true, rows: [outcome('RQ-M', 'MERGED', 30)] }));
    expect(r.reapPlan).toMatchObject({ count: 1 });
    expect(r.reapPlan!.entries[0]).toMatchObject({ name: 'RQ-M', via: 'worktree-remove', state: 'merged' });
    expect(r.reapPlan!.entries.map(e => e.name)).not.toContain('RQ-H');
  });
});

describe('formatWtAudit / formatWtReapPlan', () => {
  it('summarizes states and never hides degraded sources', async () => {
    const report = await readWtAudit(healthyDeps({
      dirs: { [WT]: ['RQ-A'] },
      entries: { [RUNS]: ['RQ-A.base'], [RUN]: [] },
      files: { [`${RUNS}/RQ-A.base`]: baseText('RQ-A') },
    }, { wantPlan: true }));
    const audit = formatWtAudit(report).join('\n');
    expect(audit).toContain('1 recorded');
    expect(audit).toContain('reapable now: none');
    const plan = formatWtReapPlan(report).join('\n');
    expect(plan).toContain('no worktree is provably safe');
  });
});

describe('cmdFleetWtAudit', () => {
  const run = async (argv: string[], deps: ReadWtAuditOptions) => {
    const logs: string[] = [];
    const errors: string[] = [];
    const code = await cmdFleetWtAudit(argv, { ...deps, output: { log: s => logs.push(s), error: s => errors.push(s) } });
    return { code, logs, errors };
  };
  const spec: FakeSpec = {
    dirs: { [WT]: ['RQ-A', 'RQ-B'] },
    entries: { [RUNS]: ['RQ-A.base', 'RQ-A.publish'], [RUN]: [] },
    files: { [`${RUNS}/RQ-A.base`]: baseText('RQ-A'), [`${RUNS}/RQ-A.publish`]: 'RESULT PR https://github.com/o/r/pull/7\n' },
  };

  it('--json prints one parseable report with a reapPlan under --reap-plan', async () => {
    const { code, logs } = await run(['--json', '--reap-plan'], healthyDeps(spec));
    expect(code).toBe(0);
    const report = JSON.parse(logs[0]!);
    expect(report.schema).toBe('fleet.wt-audit.v1');
    expect(report.readOnly).toBe(true);
    expect(report.reapPlan.entries[0]).toMatchObject({ name: 'RQ-A', via: 'reap-one' });
    expect(report.worktrees.find((w: { name: string }) => w.name === 'RQ-B')).toMatchObject({ state: 'orphaned' });
  });

  it('--no-size keeps states but nulls bytes', async () => {
    const { logs } = await run(['--json', '--no-size'], healthyDeps(spec));
    const report = JSON.parse(logs[0]!);
    expect(report.sources.sized).toBe(false);
    expect(report.worktrees[0].bytes).toBeNull();
    expect(report.totals.bytes).toBeNull();
  });

  it('rejects bad arguments, duplicates and relative paths; prints help', async () => {
    for (const argv of [['--nope'], ['--json', '--json'], ['--wt-dir', 'rel'], ['--reap-plan', 'extra']]) {
      expect((await run(argv, healthyDeps(spec))).code).toBe(2);
    }
    const help = await run(['--help'], healthyDeps(spec));
    expect(help.code).toBe(0);
    expect(help.logs[0]).toContain('phm fleet wt-audit');
  });

  it('exits 1 when the worktree root cannot be listed', async () => {
    const { code, logs } = await run(['--json'], healthyDeps({ failDirs: true }));
    expect(code).toBe(1);
    expect(JSON.parse(logs[0]!).sources.worktrees).toBe('degraded');
  });
});
