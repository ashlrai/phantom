import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SELF_HEAL_CYCLE_MIN_UNITS,
  foldSelfHealCycleEvidence,
  parseSelfHealCycleJournal,
  parseSelfHealCycleRecord,
  selfHealCycleBacklogItems,
} from '../src/core/improve/self-heal-cycle-backlog.js';
import { selfHealCycleJournalPath, selfHealCycleRow } from '../src/core/fleet/self-heal.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const NOW_MS = Date.parse('2026-12-01T12:00:00.000Z');
const JOURNAL = join('metrics', 'self-heal-cycles.jsonl');
const DAY_MS = 24 * 60 * 60 * 1000;
const REPO_A = '/Users/operator/checkouts/phantom';
const REPO_B = '/Users/operator/checkouts/widget';

let home: string;
let saved: Record<string, string | undefined>;
beforeEach(async () => {
  saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
  delete process.env.ASHLR_HOME;
  delete process.env.ASHLR_RUNS_DIR;
  home = await mkdtemp(join(tmpdir(), 'improve-selfhealcycle-'));
  process.env.HOME = home;
});
afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await rm(home, { recursive: true, force: true });
});

const cycle = (at: string, over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    schema: 'fleet.self-heal-cycle.v1',
    at,
    enrolled: 10,
    checked: 10,
    broken: [],
    brokenTotal: 0,
    healProposed: 0,
    ...over,
  });

const at = (day: string, hour = 8): string => `${day}T${String(hour).padStart(2, '0')}:00:00.000Z`;
const D1 = '2026-11-28';
const D2 = '2026-11-29';
const D3 = '2026-11-30';

/** Three records across three UTC days — past both recurring bars for one cell. */
const recurring = (line: (day: string) => string): string[] => [line(D1), line(D2), line(D3)];

const deferredCycle = (day: string): string =>
  cycle(at(day), { enrolled: 14, checked: 9, deferred: 5, budgetExhausted: true });
const brokenCycle = (day: string): string =>
  cycle(at(day), { broken: [REPO_A], brokenTotal: 1, healProposed: 1 });
const mixedCycle = (day: string): string =>
  cycle(at(day), { enrolled: 12, checked: 8, deferred: 4, broken: [REPO_A, REPO_B], brokenTotal: 2, healProposed: 2, budgetExhausted: true });
const cleanCycle = (day: string): string => cycle(at(day));

const runsDir = async (name: string, lines: readonly string[]): Promise<string> => {
  const dir = join(home, name);
  await mkdir(join(dir, 'metrics'), { recursive: true });
  await writeFile(join(dir, JOURNAL), lines.join('\n') + '\n');
  return dir;
};

describe('parseSelfHealCycleRecord / parseSelfHealCycleJournal', () => {
  it('accepts the writer contract and drops off-contract fields honestly', () => {
    const parsed = parseSelfHealCycleRecord(JSON.parse(cycle(at(D1), {
      enrolled: 12,
      checked: 8,
      deferred: 4,
      budgetExhausted: true,
      broken: [REPO_A, '', '   ', 42, `${'x'.repeat(2000)}`],
      brokenTotal: 5,
      healProposed: 3,
    })));
    expect(parsed).not.toBeNull();
    expect(parsed!.enrolled).toBe(12);
    expect(parsed!.checked).toBe(8);
    expect(parsed!.deferred).toBe(4);
    expect(parsed!.budgetExhausted).toBe(true);
    // Non-string, blank and over-long path entries are dropped, never guessed.
    expect(parsed!.broken).toEqual([REPO_A]);
    expect(parsed!.utcDay).toBe(D1);

    // deferred and budgetExhausted absent is the writer's clean-cycle shape.
    const clean = parseSelfHealCycleRecord(JSON.parse(cleanCycle(D1)));
    expect(clean).not.toBeNull();
    expect(clean!.deferred).toBe(0);
    expect(clean!.budgetExhausted).toBe(false);
  });

  it('rejects rows that break the writer invariants', () => {
    const base = JSON.parse(cycle(at(D1)));
    for (const bad of [
      null, 'x', [],
      { ...base, schema: 'other.v9' },
      { ...base, at: 'not-a-date' },
      { ...base, enrolled: -1 },
      { ...base, checked: 1.5 },
      { ...base, healProposed: 'two' },
      // checked + deferred must equal enrolled — the writer's own invariant.
      { ...base, enrolled: 10, checked: 8, deferred: 3 },
      // brokenTotal counts every broken repo the capped list came from.
      { ...base, broken: [REPO_A, REPO_B], brokenTotal: 1 },
      { ...base, deferred: 'later' },
      { ...base, budgetExhausted: 'yes' },
      { ...base, broken: 'none' },
    ]) {
      expect(parseSelfHealCycleRecord(bad)).toBeNull();
    }
  });

  it('counts malformed and off-contract lines without guessing', () => {
    const { records, invalidRows } = parseSelfHealCycleJournal([
      'not json',
      '{"schema":"fleet.self-heal-cycle.v1"}',
      cleanCycle(D1),
      '',
      cycle(at(D2), { checked: 99 }),
    ].join('\n'));
    expect(records).toHaveLength(1);
    expect(invalidRows).toBe(3);
  });
});

describe('foldSelfHealCycleEvidence', () => {
  const recordsOf = (lines: readonly string[]) => parseSelfHealCycleJournal(lines.join('\n')).records;

  it('folds deferred and broken cells at the recurring bars and ignores clean cycles', () => {
    const lines = [
      ...recurring(deferredCycle),
      ...recurring(brokenCycle),
      cleanCycle(D1), cleanCycle(D2), cleanCycle(D3),
    ];
    const folded = foldSelfHealCycleEvidence(recordsOf(lines), { nowMs: NOW_MS });
    expect(folded.records).toBe(9);
    expect(folded.cells.map((c) => c.key).sort()).toEqual(['broken:' + REPO_A, 'deferred']);
    const deferred = folded.cells.find((c) => c.key === 'deferred')!;
    expect(deferred.units).toBe(SELF_HEAL_CYCLE_MIN_UNITS);
    expect(deferred.days.size).toBe(3);
    expect(deferred.deferredTotal).toBe(15);
    expect(deferred.budgetExhaustedUnits).toBe(3);
    const broken = folded.cells.find((c) => c.key === `broken:${REPO_A}`)!;
    expect(broken.units).toBe(3);
    expect(broken.days.size).toBe(3);
  });

  it('keeps distinct broken repos in distinct cells and counts shared cycles once per repo', () => {
    const lines = recurring(mixedCycle);
    const folded = foldSelfHealCycleEvidence(recordsOf(lines), { nowMs: NOW_MS });
    const keys = folded.cells.map((c) => c.key).sort();
    expect(keys).toEqual([`broken:${REPO_A}`, `broken:${REPO_B}`, 'deferred']);
    const deferred = folded.cells.find((c) => c.key === 'deferred')!;
    expect(deferred.deferredTotal).toBe(12);
  });

  it('stays quiet below the recurring bars and outside the window', () => {
    // Three deferrals on ONE UTC day only.
    const oneDay = foldSelfHealCycleEvidence(recordsOf([
      deferredCycle('2026-11-30'), deferredCycle('2026-11-30'), deferredCycle('2026-11-30'),
    ]), { nowMs: NOW_MS });
    expect(oneDay.cells).toEqual([]);

    // Two records across two days — under the units bar.
    const two = foldSelfHealCycleEvidence(recordsOf([deferredCycle(D1), deferredCycle(D2)]), { nowMs: NOW_MS });
    expect(two.cells).toEqual([]);

    // Old records outside the 7-day window never count.
    const ancient = foldSelfHealCycleEvidence(recordsOf([
      deferredCycle('2026-11-01'), deferredCycle('2026-11-02'), deferredCycle('2026-11-03'),
      brokenCycle('2026-11-01'), brokenCycle('2026-11-02'), brokenCycle('2026-11-03'),
    ]), { nowMs: NOW_MS });
    expect(ancient.records).toBe(0);
    expect(ancient.outsideWindow).toBe(6);
    expect(ancient.cells).toEqual([]);
  });
});

describe('selfHealCycleBacklogItems', () => {
  it('emits one item per recurring cell with stable ids, prompts and metadata', async () => {
    const dir = await runsDir('runs-all', [...recurring(deferredCycle), ...recurring(brokenCycle), cleanCycle(D1)]);
    const items = await selfHealCycleBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW_MS) });
    expect(items).toHaveLength(2);
    const deferred = items.find((i) => i.id === 'selfhealcycle-deferred')!;
    const broken = items.find((i) => i.id.startsWith('selfhealcycle-broken-'))!;
    expect(broken.id).toMatch(/^selfhealcycle-broken-[0-9a-f]{12}$/);
    expect(items.every((i) => i.priority === 3 && i.area === 'fleet-self-heal' && i.repo === 'ashlrai/phantom')).toBe(true);
    expect(items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(deferred.prompt).toContain('metrics/self-heal-cycles.jsonl');
    expect(deferred.prompt).toContain('deferred');
    expect(deferred.prompt).toContain('budgetExhausted');
    expect(deferred.prompt).toContain('no-change');
    // The broken checkout resolves by basename — the fixture path has no git origin.
    expect(broken.title).toContain('phantom');
    expect(broken.prompt).toContain(REPO_A);
    expect(broken.prompt).toContain('dedupes');
    // Deterministic cap respected.
    const limited = await selfHealCycleBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW_MS), limit: 1 });
    expect(limited).toHaveLength(1);
  });

  it('names a broken checkout by its proven owner/name when the git config resolves', async () => {
    // A checkout-shaped fixture: .git/config carries an origin remote.
    const checkout = join(home, 'checkouts', 'widget');
    await mkdir(join(checkout, '.git'), { recursive: true });
    await writeFile(join(checkout, '.git', 'config'), '[remote "origin"]\n\turl = git@github.com:ashlrai/widget.git\n');
    const dir = await runsDir('runs-identity', recurring((d) =>
      cycle(at(d), { broken: [checkout], brokenTotal: 1, healProposed: 1 })));
    const items = await selfHealCycleBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW_MS) });
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toContain('ashlrai/widget');
    expect(items[0]!.prompt).toContain('ashlrai/widget');
  });

  it('emits nothing below the bars, on missing or unreadable journals, or for another repository', async () => {
    // Below the units bar: two records across two days.
    const few = await runsDir('runs-few', [deferredCycle(D1), deferredCycle(D2)]);
    expect(await selfHealCycleBacklogItems({ repo: 'ashlrai/phantom', runsDir: few, now: new Date(NOW_MS) })).toEqual([]);

    // Below the days bar: three records on one UTC day.
    const oneDay = await runsDir('runs-oneday', [
      deferredCycle('2026-11-30'), deferredCycle('2026-11-30'), deferredCycle('2026-11-30'),
    ]);
    expect(await selfHealCycleBacklogItems({ repo: 'ashlrai/phantom', runsDir: oneDay, now: new Date(NOW_MS) })).toEqual([]);

    // Missing runs dir and missing journal.
    const empty = await runsDir('runs-empty', []);
    await rm(join(empty, JOURNAL));
    expect(await selfHealCycleBacklogItems({ repo: 'ashlrai/phantom', runsDir: empty, now: new Date(NOW_MS) })).toEqual([]);
    expect(await selfHealCycleBacklogItems({ repo: 'ashlrai/phantom', runsDir: join(home, 'no-such'), now: new Date(NOW_MS) })).toEqual([]);

    // A directory where the journal should be is not a file.
    const dirAsFile = join(home, 'runs-dirfile');
    await mkdir(join(dirAsFile, JOURNAL), { recursive: true });
    expect(await selfHealCycleBacklogItems({ repo: 'ashlrai/phantom', runsDir: dirAsFile, now: new Date(NOW_MS) })).toEqual([]);

    // Garbage lines are not evidence.
    const junk = await runsDir('runs-junk', ['not json', '{"schema":"fleet.self-heal-cycle.v1"}', '']);
    expect(await selfHealCycleBacklogItems({ repo: 'ashlrai/phantom', runsDir: junk, now: new Date(NOW_MS) })).toEqual([]);

    // Another repository never inherits this install's evidence.
    const dir = await runsDir('runs-repo', recurring(deferredCycle));
    expect(await selfHealCycleBacklogItems({ repo: 'ashlrai/other', runsDir: dir, now: new Date(NOW_MS) })).toEqual([]);
    expect(await selfHealCycleBacklogItems({ repo: 'AshlrAI/Phantom', runsDir: dir, now: new Date(NOW_MS) })).toHaveLength(1);
  });

  it('states truncated tails as lower bounds and scrubs journal strings in prompts', async () => {
    // >1 MiB of retained rows: the bounded tail drops the oldest bytes.
    const filler: string[] = [];
    for (let i = 0; i < 9000; i += 1) {
      filler.push(cycle(at(D1, i % 24), { checked: 9, deferred: 1 }));
    }
    const dir = await runsDir('runs-big', [...filler, ...recurring(deferredCycle)]);
    const items = await selfHealCycleBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW_MS) });
    expect(items.length).toBeGreaterThan(0);
    expect(items.some((i) => i.prompt.includes('lower bound'))).toBe(true);
  }, 30_000);

  it('scrubs secret-shaped text out of journal paths before it reaches a prompt', async () => {
    const token = '123456789:AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHJ';
    const secretPath = `/tmp/checkouts/${token}/repo`;
    const dir = await runsDir('runs-secret', recurring((d) =>
      cycle(at(d), { broken: [secretPath], brokenTotal: 1, healProposed: 1 })));
    const items = await selfHealCycleBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW_MS) });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).not.toContain(token);
    expect(items[0]!.prompt).toContain('[REDACTED]');
  });

  it('derives stable ids so a refresh re-adds nothing', async () => {
    const dir = await runsDir('runs-stable', [...recurring(deferredCycle), ...recurring(brokenCycle)]);
    const opts = { repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW_MS) };
    const first = await selfHealCycleBacklogItems(opts);
    const second = await selfHealCycleBacklogItems(opts);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
  });

  it('appends self-heal-cycle items through discovery and dedupes on refresh', async () => {
    const runs = join(home, '.ashlr-runs');
    await mkdir(join(runs, 'metrics'), { recursive: true });
    // discoverBacklog anchors the evidence window on the wall clock, so
    // the fixtures use days relative to real now — three distinct UTC
    // days inside the window, like the fixed-date fixtures above.
    const dayAgo = (days: number): string => new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
    const recent = (make: (day: string) => string): string[] => [1, 2, 3].map((d) => make(`${dayAgo(d)}T08:00:00.000Z`));
    // These helpers take the full ISO timestamp `recent` hands them.
    const deferredIso = (iso: string): string =>
      cycle(iso, { enrolled: 14, checked: 9, deferred: 5, budgetExhausted: true });
    const brokenIso = (iso: string): string =>
      cycle(iso, { broken: [REPO_A], brokenTotal: 1, healProposed: 1 });
    const cleanIso = (iso: string): string => cycle(iso);
    const lines = [
      ...recent(deferredIso),
      ...recent(brokenIso),
      ...recent(cleanIso),
    ];
    await writeFile(join(runs, JOURNAL), lines.join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const items = first.items.filter((i) => i.id.startsWith('selfhealcycle-'));
    expect(items).toHaveLength(2);
    expect(items.some((i) => i.id === 'selfhealcycle-deferred')).toBe(true);
    expect(items.some((i) => i.id.startsWith('selfhealcycle-broken-'))).toBe(true);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(items)).toBe(2);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('selfhealcycle-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('selfhealcycle-'))).toHaveLength(2);
  });
});

describe('selfHealCycleRow / selfHealCycleJournalPath', () => {
  it('renders the writer contract and resolves under the runs dir', () => {
    const row = JSON.parse(selfHealCycleRow({
      checked: 7,
      checkedRepos: [],
      broken: [REPO_A],
      healItems: [{ id: 'x' } as never],
      deferred: 3,
      budgetExhausted: true,
    }, new Date('2026-12-01T00:00:00.000Z')));
    expect(row).toEqual({
      schema: 'fleet.self-heal-cycle.v1',
      at: '2026-12-01T00:00:00.000Z',
      enrolled: 10,
      checked: 7,
      broken: [REPO_A],
      brokenTotal: 1,
      healProposed: 1,
      deferred: 3,
      budgetExhausted: true,
    });
    // The rendered row passes the fold's own contract.
    expect(parseSelfHealCycleRecord(row)).not.toBeNull();
    // Clean cycles omit the optional fields; broken lists cap at the writer bound.
    const clean = JSON.parse(selfHealCycleRow({ checked: 4, checkedRepos: [], broken: [], healItems: [] }, new Date('2026-12-01T00:00:00.000Z')));
    expect(clean).not.toHaveProperty('deferred');
    expect(clean).not.toHaveProperty('budgetExhausted');
    expect(clean.enrolled).toBe(4);
    const many = Array.from({ length: 60 }, (_, i) => `/r/${i}`);
    const capped = JSON.parse(selfHealCycleRow({ checked: 60, checkedRepos: [], broken: many, healItems: [] }));
    expect(capped.broken).toHaveLength(50);
    expect(capped.brokenTotal).toBe(60);
    // The path helper resolves metrics/self-heal-cycles.jsonl under any runs dir.
    expect(selfHealCycleJournalPath('/runs/x')).toBe(join('/runs/x', 'metrics', 'self-heal-cycles.jsonl'));
    expect(selfHealCycleJournalPath()).toContain('.ashlr-runs');
  });
});
