import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  NORTHSTAR_BACKLOG_MAX_ITEMS,
  NORTHSTAR_CORRUPT_MIN_ROWS,
  NORTHSTAR_MIN_WINDOW_HOURS,
  NORTHSTAR_SCHEMA,
  NORTHSTAR_TAIL_BYTES,
  foldNorthstarRows,
  northstarAdverse,
  northstarBacklogItems,
  northstarPairs,
} from '../src/core/improve/northstar-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

/** Epoch seconds, like the writer's int(time.time()) stamps. */
const CUT = 1_760_000_000;
const DAY_S = 86_400;
const HOUR_S = 3_600;
const RECORDED = CUT + 2 * DAY_S;

/** One ashlr.northstar.v1 row in the writer's shape. */
function northstarRow(spec: {
  phase?: 'before' | 'after';
  windowStart?: number;
  windowEnd?: number;
  hours?: number;
  sessions?: number;
  bundleSessions?: number;
  tasksFinished?: number;
  mergedPrs?: number;
  tasksPerSession?: number | null;
  iterationsPerHour?: number | null;
  mergedPrsPerIteration?: number | null;
  recordedAt?: number;
  schema?: string;
  raw?: Record<string, unknown>;
} = {}): string {
  if (spec.raw !== undefined) return JSON.stringify(spec.raw);
  const phase = spec.phase ?? 'before';
  const sessions = spec.sessions ?? 10;
  const windowStart = spec.windowStart ?? (phase === 'before' ? CUT - DAY_S : CUT);
  const windowEnd = spec.windowEnd ?? (phase === 'before' ? CUT : CUT + DAY_S);
  return JSON.stringify({
    schema: spec.schema ?? NORTHSTAR_SCHEMA,
    window_start: windowStart,
    window_end: windowEnd,
    hours: spec.hours ?? (windowEnd - windowStart) / HOUR_S,
    sessions,
    bundle_sessions: spec.bundleSessions ?? 0,
    tasks_finished: spec.tasksFinished ?? sessions * 2,
    merged_prs: spec.mergedPrs ?? sessions,
    tasks_per_session: spec.tasksPerSession === undefined ? 2 : spec.tasksPerSession,
    iterations_per_hour: spec.iterationsPerHour === undefined ? 10 / 24 : spec.iterationsPerHour,
    merged_prs_per_iteration: spec.mergedPrsPerIteration === undefined ? 1 : spec.mergedPrsPerIteration,
    phase,
    recorded_at: spec.recordedAt ?? RECORDED,
  });
}

/** A complete before/after record batch around CUT. */
function recordPair(opts: {
  before?: Parameters<typeof northstarRow>[0];
  after?: Parameters<typeof northstarRow>[0];
  recordedAt?: number;
} = {}): string[] {
  const recordedAt = opts.recordedAt ?? RECORDED;
  return [
    northstarRow({ ...(opts.before ?? {}), phase: 'before', recordedAt }),
    northstarRow({ ...(opts.after ?? {}), phase: 'after', recordedAt }),
  ];
}

/** A regressive pair: every rate falls after the cutover. */
function regressivePair(recordedAt = RECORDED): string[] {
  return recordPair({
    recordedAt,
    before: { tasksPerSession: 2, iterationsPerHour: 0.5, mergedPrsPerIteration: 1 },
    after: { tasksPerSession: 1, iterationsPerHour: 0.25, mergedPrsPerIteration: 0.4 },
  });
}

describe('foldNorthstarRows', () => {
  it('keeps contract rows and counts every malformed line', () => {
    const lines = [
      northstarRow({ phase: 'before' }),
      northstarRow({ phase: 'after' }),
      // Null rates are contract-valid — the window had no finished sessions.
      northstarRow({ phase: 'before', sessions: 0, tasksPerSession: null, mergedPrsPerIteration: null, iterationsPerHour: 0 }),
      'not json at all',
      '[1,2,3]',
      'null',
      northstarRow({ schema: 'ashlr.northstar.v2' }),
      northstarRow({ raw: { schema: NORTHSTAR_SCHEMA, phase: 'sideways' } }),
      northstarRow({ windowEnd: CUT - DAY_S - 1, windowStart: CUT - DAY_S }), // end <= start
      northstarRow({ recordedAt: 1.5 }),                                     // non-integer batch key
      northstarRow({ hours: 0 }),
      northstarRow({ hours: -3 }),
      northstarRow({ sessions: 1.5 }),
      northstarRow({ sessions: -1 }),
      northstarRow({ tasksPerSession: -0.5 }),
      JSON.stringify({
        schema: NORTHSTAR_SCHEMA, phase: 'before', window_start: CUT - DAY_S, window_end: CUT,
        hours: 24, sessions: 10, bundle_sessions: 0, tasks_finished: 20, merged_prs: 10,
        tasks_per_session: 2, iterations_per_hour: 'fast', merged_prs_per_iteration: 1,
        recorded_at: RECORDED,
      }),
      '',
    ];
    const fold = foldNorthstarRows([lines.join('\n')]);
    expect(fold.rows).toHaveLength(3);
    expect(fold.malformed).toBe(13);
    expect(fold.rows[0]!.phase).toBe('before');
    expect(fold.rows[2]!.tasksPerSession).toBeNull();
    expect(fold.rows[2]!.sessions).toBe(0);
  });
});

describe('northstarPairs', () => {
  it('pairs rows only on the shared recorded_at batch and cutover epoch', () => {
    const fold = foldNorthstarRows([[
      ...recordPair({ recordedAt: RECORDED }),
      // Same cutover measured again later — the freshest batch wins.
      ...recordPair({ recordedAt: RECORDED + 3600 }),
      // A before row whose after never landed stays unpaired.
      northstarRow({ phase: 'before', windowStart: CUT - 3 * DAY_S, windowEnd: CUT - 2 * DAY_S, recordedAt: RECORDED + 7200 }),
      // A pair whose windows do not share the cut boundary never joins.
      northstarRow({ phase: 'before', windowStart: CUT - 2 * DAY_S, windowEnd: CUT - DAY_S, recordedAt: RECORDED + 8000 }),
      northstarRow({ phase: 'after', windowStart: CUT, windowEnd: CUT + DAY_S, recordedAt: RECORDED + 8000 }),
      // A second cutover entirely.
      ...recordPair({
        recordedAt: RECORDED - DAY_S,
        before: { windowStart: CUT - 3 * DAY_S, windowEnd: CUT - 2 * DAY_S },
        after: { windowStart: CUT - 2 * DAY_S, windowEnd: CUT - DAY_S },
      }),
    ].join('\n')]);
    const pairs = northstarPairs(fold.rows);
    // Two cutovers: the shared-boundary mismatch pair and the lone before
    // row never pair; the older cut sorts after the newer.
    expect(pairs).toHaveLength(2);
    expect(pairs[0]!.cut).toBe(CUT);
    expect(pairs[0]!.recordedAt).toBe(RECORDED + 3600);
    expect(pairs[1]!.cut).toBe(CUT - 2 * DAY_S);
  });
});

describe('northstarAdverse', () => {
  const pairOf = (rows: string[]) => {
    const pairs = northstarPairs(foldNorthstarRows([rows.join('\n')]).rows);
    expect(pairs).toHaveLength(1);
    return pairs[0]!;
  };

  it('flags strictly fallen rates and quotes both sides', () => {
    const adverse = northstarAdverse(pairOf(regressivePair()));
    expect(adverse).not.toBeNull();
    expect(adverse!.regressions.map((r) => r.metric)).toEqual([
      'tasks_per_session', 'iterations_per_hour', 'merged_prs_per_iteration',
    ]);
    expect(adverse!.regressions[0]).toMatchObject({ before: 2, after: 1 });
    expect(adverse!.darkAfter).toBe(false);
  });

  it('emits nothing when rates hold or improve', () => {
    expect(northstarAdverse(pairOf(recordPair()))).toBeNull();
    expect(northstarAdverse(pairOf(recordPair({
      before: { tasksPerSession: 1, mergedPrsPerIteration: 0.5 },
      after: { tasksPerSession: 2, mergedPrsPerIteration: 1 },
    })))).toBeNull();
    // Equal rates are not a regression.
    expect(northstarAdverse(pairOf(recordPair({
      before: { tasksPerSession: 2, iterationsPerHour: 0.5, mergedPrsPerIteration: 1 },
      after: { tasksPerSession: 2, iterationsPerHour: 0.5, mergedPrsPerIteration: 1 },
    })))).toBeNull();
  });

  it('flags a dark after-window but never treats null rates as zero', () => {
    // After window: zero sessions → tasks/merged rates null, iterations 0.
    const dark = northstarAdverse(pairOf(recordPair({
      before: { sessions: 12, tasksFinished: 24, mergedPrs: 12, tasksPerSession: 2, iterationsPerHour: 0.5, mergedPrsPerIteration: 1 },
      after: { sessions: 0, tasksFinished: 0, mergedPrs: 0, tasksPerSession: null, mergedPrsPerIteration: null, iterationsPerHour: 0 },
    })));
    expect(dark).not.toBeNull();
    expect(dark!.darkAfter).toBe(true);
    // iterations_per_hour legitimately reads 0.0 (sessions/hours), so it
    // also counts as a fallen rate — a measured zero, not an unknown.
    expect(dark!.regressions.map((r) => r.metric)).toContain('iterations_per_hour');

    // Both windows empty: nothing was ever measured — not adverse.
    expect(northstarAdverse(pairOf(recordPair({
      before: { sessions: 0, tasksFinished: 0, mergedPrs: 0, tasksPerSession: null, mergedPrsPerIteration: null, iterationsPerHour: 0 },
      after: { sessions: 0, tasksFinished: 0, mergedPrs: 0, tasksPerSession: null, mergedPrsPerIteration: null, iterationsPerHour: 0 },
    })))).toBeNull();
  });

  it('refuses sub-hour windows — rates below the floor are noise, not evidence', () => {
    const pair = pairOf(recordPair({
      before: { windowStart: CUT - 1800, windowEnd: CUT, hours: 0.5, sessions: 10, tasksPerSession: 2, iterationsPerHour: 20, mergedPrsPerIteration: 1 },
      after: { windowStart: CUT, windowEnd: CUT + 1800, hours: 0.5, sessions: 4, tasksPerSession: 1, iterationsPerHour: 8, mergedPrsPerIteration: 0.2 },
    }));
    expect(northstarAdverse(pair)).toBeNull();
    expect(NORTHSTAR_MIN_WINDOW_HOURS).toBeGreaterThan(0);
  });
});

describe('northstarBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'northstar-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await rm(home, { recursive: true, force: true });
  });

  /** A journal file under the temp runs dir carrying the given lines. */
  async function journal(name: string, lines: string[], runsDir?: string): Promise<string> {
    const dir = join(runsDir ?? join(home, '.ashlr-runs'), 'metrics');
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${name}.jsonl`);
    await writeFile(path, lines.join('\n') + '\n');
    return path;
  }

  it('emits one grounded item per adverse cutover', async () => {
    const path = join(home, '.ashlr-runs', 'metrics', 'northstar.jsonl');
    await journal('northstar', [
      ...regressivePair(),
      // A second, older cutover that also regressed.
      ...recordPair({
        recordedAt: RECORDED - DAY_S,
        before: { windowStart: CUT - 3 * DAY_S, windowEnd: CUT - 2 * DAY_S, tasksPerSession: 2, mergedPrsPerIteration: 1 },
        after: { windowStart: CUT - 2 * DAY_S, windowEnd: CUT - DAY_S, tasksPerSession: 1, mergedPrsPerIteration: 0.5 },
      }),
      // An improving cutover emits nothing.
      ...recordPair({
        recordedAt: RECORDED - 2 * DAY_S,
        before: { windowStart: CUT - 4 * DAY_S, windowEnd: CUT - 3 * DAY_S, tasksPerSession: 1, mergedPrsPerIteration: 0.5 },
        after: { windowStart: CUT - 3 * DAY_S, windowEnd: CUT - 2 * DAY_S, tasksPerSession: 2, mergedPrsPerIteration: 1 },
      }),
    ]);
    const items = await northstarBacklogItems({ repo: 'ashlrai/phantom', journalPath: path });
    expect(items).toHaveLength(2);
    const item = items[0]!;
    expect(item.id).toMatch(/^northstar-[0-9a-f]{16}$/);
    expect(item).toMatchObject({ area: 'growth-metrics', priority: 3, repo: 'ashlrai/phantom' });
    expect(validBacklogItem(item)).not.toBeNull();
    // Newest cutover first.
    expect(item.title).toContain(new Date(CUT * 1000).toISOString().slice(0, 10));
    expect(item.prompt).toContain('northstar.jsonl');
    expect(item.prompt).toContain('batch_sessions.py');
    expect(item.prompt).toContain('batcher.read_rows');
    expect(item.prompt).toContain('no-change');
    expect(item.prompt).toContain('tasks finished per session');
    expect(item.prompt).toContain('merged PRs per iteration');
    expect(item.prompt).not.toContain('lower bound');
    // Re-deriving is stable: same cutover, same id.
    const again = await northstarBacklogItems({ repo: 'ashlrai/phantom', journalPath: path });
    expect(again.map((i) => i.id)).toEqual(items.map((i) => i.id));
  });

  it('emits a dark-after item when the fleet recorded zero sessions', async () => {
    const path = await journal('northstar-dark', recordPair({
      before: { sessions: 12, tasksFinished: 24, mergedPrs: 12 },
      after: { sessions: 0, tasksFinished: 0, mergedPrs: 0, tasksPerSession: null, mergedPrsPerIteration: null, iterationsPerHour: 0 },
    }));
    const items = await northstarBacklogItems({ repo: 'ashlrai/phantom', journalPath: path });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('zero finished sessions');
    expect(items[0]!.prompt).toContain('n/a, not zero');
  });

  it('emits nothing for missing, unreadable, foreign-repo or clean evidence', async () => {
    expect(await northstarBacklogItems({ repo: 'ashlrai/phantom', journalPath: join(home, 'nope', 'northstar.jsonl') })).toEqual([]);

    const dirPath = join(home, 'metrics', 'northstar.jsonl');
    await mkdir(dirPath, { recursive: true });
    expect(await northstarBacklogItems({ repo: 'ashlrai/phantom', journalPath: dirPath })).toEqual([]);

    const clean = await journal('northstar-clean', recordPair());
    expect(await northstarBacklogItems({ repo: 'ashlrai/lexicon', journalPath: clean })).toEqual([]);
    expect(await northstarBacklogItems({ repo: '', journalPath: clean })).toEqual([]);
    expect(await northstarBacklogItems({ repo: 'ashlrai/phantom', journalPath: clean })).toEqual([]);

    // All-malformed content below the corrupt bar emits nothing.
    const junk = await journal('northstar-junk', ['not json', '{}']);
    expect(await northstarBacklogItems({ repo: 'ashlrai/phantom', journalPath: junk })).toEqual([]);
  });

  it('emits a corrupt-lines item at the contract-failure bar', async () => {
    const bad = [
      'not json',
      '{}',
      northstarRow({ schema: 'ashlr.northstar.v2' }),
      northstarRow({ raw: { schema: NORTHSTAR_SCHEMA, phase: 'sideways' } }),
      northstarRow({ sessions: -4 }),
    ];
    const path = await journal('northstar-corrupt', [...regressivePair(), ...bad]);
    const items = await northstarBacklogItems({ repo: 'ashlrai/phantom', journalPath: path });
    expect(items).toHaveLength(2);
    const corrupt = items.find((i) => i.prompt.includes('fail the ashlr.northstar.v1 row contract'));
    expect(corrupt).toBeDefined();
    expect(corrupt!.prompt).toContain(`${bad.length} line(s)`);
    expect(corrupt!.prompt).toContain('northstar.jsonl');

    // Below the bar the same junk is silent.
    const thin = await journal('northstar-thin-corrupt', [...regressivePair(), 'not json', '{}']);
    const thinItems = await northstarBacklogItems({ repo: 'ashlrai/phantom', journalPath: thin });
    expect(thinItems).toHaveLength(1);
    expect(thinItems[0]!.prompt).not.toContain('row contract');
    expect(NORTHSTAR_CORRUPT_MIN_ROWS).toBe(3);
  });

  it('states truncation as a lower bound', async () => {
    const path = join(home, '.ashlr-runs', 'metrics', 'northstar.jsonl');
    await journal('northstar-big', regressivePair());
    const pad = 'x'.repeat(NORTHSTAR_TAIL_BYTES + 1024);
    await writeFile(path, `${pad}\n${regressivePair().join('\n')}\n`);
    const items = await northstarBacklogItems({ repo: 'ashlrai/phantom', journalPath: path });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('lower bound');
    expect(items[0]!.prompt).toContain('bounded tail');
  });

  it('honours the limit and resolves the default path under the relocated home', async () => {
    // Default resolution: <HOME>/.ashlr-runs/metrics/northstar.jsonl.
    const dir = join(home, '.ashlr-runs', 'metrics');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'northstar.jsonl'), [
      ...regressivePair(),
      ...recordPair({
        recordedAt: RECORDED - DAY_S,
        before: { windowStart: CUT - 3 * DAY_S, windowEnd: CUT - 2 * DAY_S, tasksPerSession: 2 },
        after: { windowStart: CUT - 2 * DAY_S, windowEnd: CUT - DAY_S, tasksPerSession: 1 },
      }),
      ...recordPair({
        recordedAt: RECORDED - 2 * DAY_S,
        before: { windowStart: CUT - 5 * DAY_S, windowEnd: CUT - 4 * DAY_S, tasksPerSession: 2 },
        after: { windowStart: CUT - 4 * DAY_S, windowEnd: CUT - 3 * DAY_S, tasksPerSession: 1 },
      }),
      ...recordPair({
        recordedAt: RECORDED - 3 * DAY_S,
        before: { windowStart: CUT - 7 * DAY_S, windowEnd: CUT - 6 * DAY_S, tasksPerSession: 2 },
        after: { windowStart: CUT - 6 * DAY_S, windowEnd: CUT - 5 * DAY_S, tasksPerSession: 1 },
      }),
      ...recordPair({
        recordedAt: RECORDED - 4 * DAY_S,
        before: { windowStart: CUT - 9 * DAY_S, windowEnd: CUT - 8 * DAY_S, tasksPerSession: 2 },
        after: { windowStart: CUT - 8 * DAY_S, windowEnd: CUT - 7 * DAY_S, tasksPerSession: 1 },
      }),
    ].join('\n') + '\n');
    const all = await northstarBacklogItems({ repo: 'ashlrai/phantom', limit: 10 });
    expect(all.length).toBeGreaterThan(NORTHSTAR_BACKLOG_MAX_ITEMS);
    const limited = await northstarBacklogItems({ repo: 'ashlrai/phantom', limit: 2 });
    expect(limited).toHaveLength(2);
    expect(limited[0]!.id).toBe(all[0]!.id);

    // $ASHLR_RUNS_DIR wins over the home default when set.
    const envRuns = await mkdtemp(join(tmpdir(), 'northstar-runs-'));
    process.env.ASHLR_RUNS_DIR = envRuns;
    try {
      const envPath = await journal('northstar', regressivePair(), envRuns);
      const envItems = await northstarBacklogItems({ repo: 'ashlrai/phantom', journalPath: envPath });
      expect(envItems).toHaveLength(1);
      // And with no override the env dir is the default.
      const viaEnv = await northstarBacklogItems({ repo: 'ashlrai/phantom' });
      expect(viaEnv.map((i) => i.id)).toEqual([envItems[0]!.id]);
    } finally {
      delete process.env.ASHLR_RUNS_DIR;
      await rm(envRuns, { recursive: true, force: true });
    }
  });

  it('appends the cutover item through discovery and dedupes on refresh', async () => {
    const dir = join(home, '.ashlr-runs', 'metrics');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'northstar.jsonl'), regressivePair().join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const nsItems = first.items.filter((i) => i.id.startsWith('northstar-'));
    expect(nsItems).toHaveLength(1);
    expect(nsItems[0]!.area).toBe('growth-metrics');
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(nsItems)).toBe(1);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('northstar-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('northstar-'))).toHaveLength(1);
  });
});
