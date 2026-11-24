import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SELF_TICK_BACKLOG_MAX_ITEMS,
  SELF_TICK_MIN_UNITS,
  foldSelfTickEvidence,
  parseSelfTickJournal,
  parseSelfTickRecord,
  selfTickBacklogItems,
} from '../src/core/improve/self-tick-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const NOW_MS = Date.parse('2026-12-01T12:00:00.000Z');
const JOURNAL = 'queue/self-tick.jsonl';
const DAY_MS = 24 * 60 * 60 * 1000;

let home: string;
let saved: Record<string, string | undefined>;
beforeEach(async () => {
  saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
  delete process.env.ASHLR_HOME;
  delete process.env.ASHLR_RUNS_DIR;
  home = await mkdtemp(join(tmpdir(), 'improve-selftick-'));
  process.env.HOME = home;
});
afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await rm(home, { recursive: true, force: true });
});

const HOOKS_OK = [
  { hook: 'autofill', state: 'ran', items: 1, count: null, note: null },
  { hook: 'gaps', state: 'ran', items: 1, count: 3, note: null },
  { hook: 'reap', state: 'ran', items: 2, count: null, note: null },
  { hook: 'stranded-requeue', state: 'ran', items: 0, count: null, note: null },
];

const record = (at: string, over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    schema: 'fleet.self-tick-record.v1',
    startedAt: at,
    finishedAt: at,
    at,
    mode: 'apply',
    state: 'ran',
    familyStops: null,
    hooks: HOOKS_OK,
    failedSteps: [],
    ...over,
  });

const at = (day: string, hour = 8): string => `${day}T${String(hour).padStart(2, '0')}:00:00.000Z`;
const D1 = '2026-11-28';
const D2 = '2026-11-29';
const D3 = '2026-11-30';

/** Three records across three UTC days — past both recurring bars for one cell. */
const recurring = (line: (day: string) => string): string[] => [line(D1), line(D2), line(D3)];

const stepFailing = (day: string): string =>
  record(at(day), { failedSteps: [{ step: 'planner-tick', error: 'planner exploded' }] });
const busyTick = (day: string): string => record(at(day), { state: 'busy', hooks: [], failedSteps: [] });
const hookFailing = (day: string): string =>
  record(at(day), {
    hooks: [
      ...HOOKS_OK.slice(0, 2),
      { hook: 'reap', state: 'failed', items: null, count: null, note: 'worktree reap blew up' },
      HOOKS_OK[3]!,
    ],
  });
const hookBlind = (day: string): string =>
  record(at(day), {
    hooks: [
      ...HOOKS_OK.slice(0, 3),
      { hook: 'stranded-requeue', state: 'not-recorded', items: null, count: null, note: 'report carried no block' },
    ],
  });
const familyFiring = (day: string): string =>
  record(at(day), {
    familyStops: [{ family: 'src=nightly', until: 1767225600, why: 'auto_0of12_merged_0_empty_src=nightly' }],
  });

const runsDir = async (name: string, lines: readonly string[]): Promise<string> => {
  const dir = join(home, name);
  await mkdir(join(dir, 'queue'), { recursive: true });
  await writeFile(join(dir, JOURNAL), lines.join('\n') + '\n');
  return dir;
};

describe('parseSelfTickRecord / parseSelfTickJournal', () => {
  it('accepts the writer contract and drops off-contract rows and entries honestly', () => {
    const parsed = parseSelfTickRecord(JSON.parse(record(at(D1), {
      failedSteps: [
        { step: 'planner-tick', error: 'boom' },
        { step: 'not-a-real-step', error: 'foreign name' },
        { step: 'inbox-acks' },
        'junk',
      ],
      hooks: [
        { hook: 'reap', state: 'failed', items: null, count: null, note: 'x' },
        { hook: 'bogus-hook', state: 'failed', items: null, count: null, note: null },
        { hook: 'autofill', state: 'exploded', items: null, count: null, note: null },
        { hook: 'gaps', state: 'ran', items: 1, count: null, note: null },
      ],
      familyStops: [
        { family: 'src=nightly', until: 1767225600, why: 'auto_0of12_merged_0_empty_src=nightly' },
        { family: '', until: 1, why: 'x' },
        { family: 'src=x', until: 'soon', why: 'x' },
        { family: 'src=y' },
      ],
    })));
    expect(parsed).not.toBeNull();
    expect(parsed!.failedSteps).toEqual([{ step: 'planner-tick', error: 'boom' }]);
    expect(parsed!.hooks.map((h) => `${h.hook}:${h.state}`)).toEqual(['reap:failed', 'gaps:ran']);
    expect(parsed!.familyStops).toHaveLength(1);
    expect(parsed!.utcDay).toBe(D1);

    // Rows written before familyStops existed carry no such key — absent
    // is no evidence, not a contract violation.
    const older = JSON.parse(record(at(D1)));
    delete older['familyStops'];
    const olderParsed = parseSelfTickRecord(older);
    expect(olderParsed).not.toBeNull();
    expect(olderParsed!.familyStops).toEqual([]);

    // Whole-row contract violations reject the record.
    for (const bad of [
      null, 'x', [],
      { ...JSON.parse(record(at(D1))), schema: 'other.v9' },
      { ...JSON.parse(record(at(D1))), at: 'not-a-date' },
      { ...JSON.parse(record(at(D1))), mode: 'restart' },
      { ...JSON.parse(record(at(D1))), state: 'crashed' },
      { ...JSON.parse(record(at(D1))), failedSteps: 'none' },
      { ...JSON.parse(record(at(D1))), hooks: {} },
      { ...JSON.parse(record(at(D1))), familyStops: 'all' },
    ]) {
      expect(parseSelfTickRecord(bad)).toBeNull();
    }
  });

  it('counts malformed and off-contract lines without guessing', () => {
    const { records, invalidRows } = parseSelfTickJournal([
      'not json',
      '{"schema":"fleet.self-tick-record.v1"}',
      record(at(D1)),
      '',
      record(at(D2), { state: 'bogus' }),
    ].join('\n'));
    expect(records).toHaveLength(1);
    expect(invalidRows).toBe(3);
  });
});

describe('foldSelfTickEvidence', () => {
  const recordsOf = (lines: readonly string[]) => parseSelfTickJournal(lines.join('\n')).records;

  it('folds each adverse cell at the recurring bars and ignores deliberate states', () => {
    const lines = [
      ...recurring(stepFailing),
      ...recurring(busyTick),
      ...recurring(hookFailing),
      ...recurring(hookBlind),
      ...recurring(familyFiring),
      // Deliberate states: skipped hooks, ran hooks, clean runs — never cells.
      record(at(D1), {
        hooks: [
          { hook: 'autofill', state: 'skipped', items: null, count: null, note: 'dry-run' },
          { hook: 'gaps', state: 'skipped', items: null, count: null, note: 'autofill skipped' },
          { hook: 'reap', state: 'skipped', items: null, count: null, note: 'dry-run' },
          { hook: 'stranded-requeue', state: 'skipped', items: null, count: null, note: 'dry-run' },
        ],
      }),
      record(at(D2)),
    ];
    const folded = foldSelfTickEvidence(recordsOf(lines), { nowMs: NOW_MS });
    expect(folded.records).toBe(17);
    expect(folded.cells.map((c) => c.key).sort()).toEqual([
      'busy',
      'family:src=nightly',
      'hook:reap:failed',
      'hook:stranded-requeue:not-recorded',
      'step:planner-tick',
    ]);
    const step = folded.cells.find((c) => c.key === 'step:planner-tick')!;
    expect(step.units).toBe(SELF_TICK_MIN_UNITS);
    expect(step.days.size).toBe(3);
    expect(step.samples).toEqual(['planner exploded']);
  });

  it('stays quiet below the recurring bars and outside the window', () => {
    // Three failures on ONE UTC day only.
    const oneDay = foldSelfTickEvidence(recordsOf([
      stepFailing('2026-11-30'), stepFailing('2026-11-30'), stepFailing('2026-11-30'),
    ]), { nowMs: NOW_MS });
    expect(oneDay.cells).toEqual([]);

    // Two records across two days — under the units bar.
    const two = foldSelfTickEvidence(recordsOf([stepFailing(D1), stepFailing(D2)]), { nowMs: NOW_MS });
    expect(two.cells).toEqual([]);

    // Old records outside the 7-day window never count.
    const stale = foldSelfTickEvidence(recordsOf(recurring((d) => stepFailing(d)).map((l) => l)), { nowMs: NOW_MS });
    expect(stale.records).toBe(3);
    const ancient = foldSelfTickEvidence(recordsOf([
      record(at('2026-11-01')), record(at('2026-11-01'), { failedSteps: [{ step: 'planner-tick', error: 'x' }] }),
      record(at('2026-11-02'), { failedSteps: [{ step: 'planner-tick', error: 'x' }] }),
      record(at('2026-11-03'), { failedSteps: [{ step: 'planner-tick', error: 'x' }] }),
    ]), { nowMs: NOW_MS });
    expect(ancient.records).toBe(0);
    expect(ancient.outsideWindow).toBe(4);
    expect(ancient.cells).toEqual([]);
  });
});

describe('selfTickBacklogItems', () => {
  it('emits one item per recurring cell with stable ids, prompts and metadata', async () => {
    const lines = [
      ...recurring(stepFailing),
      ...recurring(busyTick),
      ...recurring(hookFailing),
      ...recurring(hookBlind),
      ...recurring(familyFiring),
      record(at(D1)),
    ];
    const dir = await runsDir('runs-all', lines);
    const items = await selfTickBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW_MS) });
    expect(items).toHaveLength(5);
    const family = items.find((i) => i.id.startsWith('selftick-family-'))!;
    expect(family.id).toMatch(/^selftick-family-[0-9a-f]{12}$/);
    expect(new Set(items.map((i) => i.id))).toEqual(new Set([
      'selftick-step-planner-tick',
      'selftick-busy',
      'selftick-hook-reap-failed',
      'selftick-hook-stranded-requeue-unrecorded',
      family.id,
    ]));
    expect(items.every((i) => i.priority === 3 && i.area === 'fleet-self-tick' && i.repo === 'ashlrai/phantom')).toBe(true);
    expect(items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    const step = items.find((i) => i.id === 'selftick-step-planner-tick')!;
    expect(step.prompt).toContain('queue/self-tick.jsonl');
    expect(step.prompt).toContain('planner-tick');
    expect(step.prompt).toContain('planner exploded');
    const busy = items.find((i) => i.id === 'selftick-busy')!;
    expect(busy.prompt).toContain('single-runner lock');
    const hook = items.find((i) => i.id === 'selftick-hook-reap-failed')!;
    expect(hook.prompt).toContain("'failed'");
    expect(hook.prompt).toContain('worktree reap blew up');
    const blind = items.find((i) => i.id === 'selftick-hook-stranded-requeue-unrecorded')!;
    expect(blind.prompt).toContain('not-recorded');
    expect(family.prompt).toContain('src=nightly');
    expect(family.prompt).toContain('auto_0of12_merged_0_empty_src=nightly');
    // Deterministic cap respected.
    expect(items.length).toBeLessThanOrEqual(Math.min(SELF_TICK_BACKLOG_MAX_ITEMS, 25));
    const limited = await selfTickBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW_MS), limit: 2 });
    expect(limited).toHaveLength(2);
  });

  it('emits nothing below the bars, on missing or unreadable journals, or for another repository', async () => {
    // Below the units bar: two records across two days.
    const few = await runsDir('runs-few', [stepFailing(D1), stepFailing(D2)]);
    expect(await selfTickBacklogItems({ repo: 'ashlrai/phantom', runsDir: few, now: new Date(NOW_MS) })).toEqual([]);

    // Below the days bar: three records on one UTC day.
    const oneDay = await runsDir('runs-oneday', [
      stepFailing('2026-11-30'), stepFailing('2026-11-30'), stepFailing('2026-11-30'),
    ]);
    expect(await selfTickBacklogItems({ repo: 'ashlrai/phantom', runsDir: oneDay, now: new Date(NOW_MS) })).toEqual([]);

    // Missing runs dir and missing journal.
    const empty = await runsDir('runs-empty', []);
    await rm(join(empty, JOURNAL));
    expect(await selfTickBacklogItems({ repo: 'ashlrai/phantom', runsDir: empty, now: new Date(NOW_MS) })).toEqual([]);
    expect(await selfTickBacklogItems({ repo: 'ashlrai/phantom', runsDir: join(home, 'no-such'), now: new Date(NOW_MS) })).toEqual([]);

    // A directory where the journal should be is not a file.
    const dirAsFile = join(home, 'runs-dirfile');
    await mkdir(join(dirAsFile, 'queue', JOURNAL), { recursive: true });
    expect(await selfTickBacklogItems({ repo: 'ashlrai/phantom', runsDir: dirAsFile, now: new Date(NOW_MS) })).toEqual([]);

    // Garbage lines are not evidence.
    const junk = await runsDir('runs-junk', ['not json', '{"schema":"fleet.self-tick-record.v1"}', '']);
    expect(await selfTickBacklogItems({ repo: 'ashlrai/phantom', runsDir: junk, now: new Date(NOW_MS) })).toEqual([]);

    // Another repository never inherits this install's evidence.
    const dir = await runsDir('runs-repo', recurring(stepFailing));
    expect(await selfTickBacklogItems({ repo: 'ashlrai/other', runsDir: dir, now: new Date(NOW_MS) })).toEqual([]);
    expect(await selfTickBacklogItems({ repo: 'AshlrAI/Phantom', runsDir: dir, now: new Date(NOW_MS) })).toHaveLength(1);
  });

  it('states truncated tails as lower bounds and scrubs journal strings in prompts', async () => {
    // >512 KiB of retained rows: the bounded tail drops the oldest bytes.
    const filler: string[] = [];
    for (let i = 0; i < 4000; i += 1) {
      filler.push(record(at(D1, i % 24), { failedSteps: [{ step: 'inbox-acks', error: `pad-${i}` }] }));
    }
    const dir = await runsDir('runs-big', [...filler, ...recurring(stepFailing)]);
    const items = await selfTickBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW_MS) });
    expect(items.length).toBeGreaterThan(0);
    expect(items.some((i) => i.prompt.includes('lower bound'))).toBe(true);
  }, 30_000);

  it('scrubs secret-shaped text out of journal errors before it reaches a prompt', async () => {
    const token = '123456789:AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHJ';
    const dir = await runsDir('runs-secret', recurring((d) =>
      record(at(d), { failedSteps: [{ step: 'planner-tick', error: `fetch failed ${token}` }] })));
    const items = await selfTickBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW_MS) });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).not.toContain(token);
    expect(items[0]!.prompt).toContain('[REDACTED]');
  });

  it('derives stable ids so a refresh re-adds nothing', async () => {
    const dir = await runsDir('runs-stable', [...recurring(stepFailing), ...recurring(busyTick)]);
    const opts = { repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW_MS) };
    const first = await selfTickBacklogItems(opts);
    const second = await selfTickBacklogItems(opts);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
  });

  it('appends self-tick items through discovery and dedupes on refresh', async () => {
    const runs = join(home, '.ashlr-runs');
    await mkdir(join(runs, 'queue'), { recursive: true });
    // discoverBacklog anchors the evidence window on the wall clock, so
    // the fixtures use days relative to real now — three distinct UTC
    // days inside the window, like the fixed-date fixtures above.
    const dayAgo = (days: number): string => new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
    const recent = (make: (day: string) => string): string[] => [1, 2, 3].map((d) => make(`${dayAgo(d)}T08:00:00.000Z`));
    const stepLines = recent((iso) => record(iso, { failedSteps: [{ step: 'planner-tick', error: 'planner exploded' }] }));
    const busyLines = recent((iso) => record(iso, { state: 'busy', hooks: [], failedSteps: [] }));
    await writeFile(join(runs, JOURNAL), [...stepLines, ...busyLines].join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const selfTickItems = first.items.filter((i) => i.id.startsWith('selftick-'));
    expect(selfTickItems.map((i) => i.id).sort()).toEqual(['selftick-busy', 'selftick-step-planner-tick']);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(selfTickItems)).toBe(2);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('selftick-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('selftick-'))).toHaveLength(2);
  });
});
