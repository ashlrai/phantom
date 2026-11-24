import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  SOURCE_HEAL_BACKLOG_MAX_ITEMS,
  SOURCE_HEAL_MIN_UNITS,
  foldSourceHealEvidence,
  parseSourceHealEntry,
  parseSourceHealLedger,
  sourceHealBacklogItems,
  type SourceHealRow,
} from '../src/core/improve/source-heal-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';
import type { WorktreeProbe } from '../src/core/worktree-doctor.js';

const NOW_MS = Date.parse('2026-12-01T12:00:00.000Z');
const DAY_MS = 24 * 60 * 60 * 1000;

let home: string;
let saved: Record<string, string | undefined>;
beforeEach(async () => {
  saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR, ASHLR_BRIDGE_HEAL_LOG: process.env.ASHLR_BRIDGE_HEAL_LOG };
  delete process.env.ASHLR_HOME;
  delete process.env.ASHLR_RUNS_DIR;
  // The suite pins this under the worker home (absent = missing journal);
  // delete it so logPath/root/probe resolution is what each test exercises.
  delete process.env.ASHLR_BRIDGE_HEAL_LOG;
  home = await mkdtemp(join(tmpdir(), 'improve-source-heal-'));
  process.env.HOME = home;
});
afterEach(async () => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  await rm(home, { recursive: true, force: true });
});

const D1 = '2026-11-28';
const D2 = '2026-11-29';
const D3 = '2026-11-30';

const REPAIR = 'npm ci --ignore-scripts --no-audit --no-fund';

/** One journal line exactly as healSource's record() writes it. */
const heal = (day: string, hour: number, event: string, over: Record<string, unknown> = {}): string => {
  const base: Record<string, unknown> = {
    schema: 'phm.bridge.source-heal/1',
    at: `${day}T${String(hour).padStart(2, '0')}:00:00.000Z`,
    event,
    ok: event === 'probe' || event === 'repaired',
    reason: event === 'probe' ? 'source tools start' : event === 'repaired' ? REPAIR : 'repair ran but tools still do not start',
    tsgo: event === 'probe' || event === 'repaired',
    eslint: event === 'probe' || event === 'repaired',
    ...over,
  };
  return JSON.stringify(base);
};

const skipped = (day: string, hour: number, reason: string, over: Record<string, unknown> = {}): string =>
  heal(day, hour, 'skipped', { ok: false, reason, tsgo: false, eslint: true, ...over });

/** Three records of one kind across three UTC days — past both recurring bars. */
const recurring = (line: (day: string) => string): string[] => [line(D1), line(D2), line(D3)];

const journalFor = async (name: string, lines: readonly string[]): Promise<string> => {
  const path = join(home, name);
  await writeFile(path, lines.length === 0 ? '' : lines.join('\n') + '\n');
  return path;
};

const row = (day: string, hour: number, event: SourceHealRow['event'], over: Partial<SourceHealRow> = {}): SourceHealRow => ({
  atMs: Date.parse(`${day}T${String(hour).padStart(2, '0')}:00:00.000Z`),
  utcDay: day,
  event,
  ok: event === 'probe' || event === 'repaired',
  reason: event === 'probe' ? 'source tools start' : event === 'repaired' ? REPAIR : 'repair ran but tools still do not start',
  tsgo: event === 'probe' || event === 'repaired',
  eslint: event === 'probe' || event === 'repaired',
  ...over,
});

describe('parseSourceHealEntry / parseSourceHealLedger', () => {
  it('accepts every event in the writer contract and rejects off-contract rows', () => {
    for (const event of ['probe', 'repaired', 'failed', 'skipped']) {
      const parsed = parseSourceHealEntry(JSON.parse(heal(D1, 8, event)));
      expect(parsed).not.toBeNull();
      expect(parsed).toMatchObject({ event, utcDay: D1, ok: event === 'probe' || event === 'repaired' });
    }
    // A skipped row carries the deferred outcome and the broken-tool state.
    const deferred = parseSourceHealEntry(JSON.parse(skipped(D1, 8, 'already repaired within the last hour')));
    expect(deferred).toMatchObject({ event: 'skipped', ok: false, reason: 'already repaired within the last hour', tsgo: false, eslint: true });

    for (const bad of [
      null, 'x', [],
      { at: `${D1}T08:00:00.000Z`, event: 'failed', ok: false, reason: 'r', tsgo: false, eslint: false },
      { schema: 'phm.bridge.source-heal/2', at: `${D1}T08:00:00.000Z`, event: 'failed', ok: false, reason: 'r', tsgo: false, eslint: false },
      { schema: 'phm.bridge.source-heal/1', at: 'not-a-date', event: 'failed', ok: false, reason: 'r', tsgo: false, eslint: false },
      { schema: 'phm.bridge.source-heal/1', at: `${D1}T08:00:00.000Z`, event: 'healed', ok: false, reason: 'r', tsgo: false, eslint: false },
      { schema: 'phm.bridge.source-heal/1', at: `${D1}T08:00:00.000Z`, event: 'failed', reason: 'r', tsgo: false, eslint: false },
      { schema: 'phm.bridge.source-heal/1', at: `${D1}T08:00:00.000Z`, event: 'failed', ok: 'no', reason: 'r', tsgo: false, eslint: false },
      { schema: 'phm.bridge.source-heal/1', at: `${D1}T08:00:00.000Z`, event: 'failed', ok: false, reason: 'r', tsgo: 'no', eslint: false },
      { schema: 'phm.bridge.source-heal/1', at: `${D1}T08:00:00.000Z`, event: 'failed', ok: false, reason: 'r', tsgo: false },
      { schema: 'phm.bridge.source-heal/1', at: `${D1}T08:00:00.000Z`, event: 'failed', ok: false, reason: '', tsgo: false, eslint: false },
      { schema: 'phm.bridge.source-heal/1', at: `${D1}T08:00:00.000Z`, event: 'failed', ok: false, reason: 42, tsgo: false, eslint: false },
      { schema: 'phm.bridge.source-heal/1', at: `${D1}T08:00:00.000Z`, event: 'failed', ok: false, reason: 'r'.repeat(513), tsgo: false, eslint: false },
    ]) {
      expect(parseSourceHealEntry(bad)).toBeNull();
    }
  });

  it('counts malformed and off-contract lines without guessing', () => {
    const { rows: parsed, invalidRows } = parseSourceHealLedger([
      'not json',
      '{"schema":"phm.bridge.source-heal/1"}',
      heal(D1, 8, 'failed'),
      '',
      heal(D2, 8, 'skipped', { reason: '' }),
    ].join('\n'));
    expect(parsed).toHaveLength(1);
    expect(invalidRows).toBe(3);
  });
});

describe('foldSourceHealEvidence', () => {
  it('folds each recurring kind and counts healthy probes without making them cells', () => {
    const lines = [
      ...recurring((d) => heal(d, 8, 'failed', { ok: false, tsgo: false, eslint: true })),
      ...recurring((d) => heal(d, 9, 'probe')),
      heal(D3, 10, 'probe'),
      // A kind below the bars never becomes a cell.
      heal(D1, 11, 'repaired'), heal(D2, 11, 'repaired'),
    ];
    const { rows: parsed } = parseSourceHealLedger(lines.join('\n'));
    const folded = foldSourceHealEvidence(parsed, { nowMs: NOW_MS });
    expect(folded.records).toBe(9);
    expect(folded.healthyProbes).toBe(4);
    expect(folded.cells.map((c) => c.kind)).toEqual(['failed']);
    const cell = folded.cells[0]!;
    expect(cell.units).toBe(SOURCE_HEAL_MIN_UNITS);
    expect(cell.days.size).toBe(3);
    expect(cell.tsgoBroken).toBe(3);
    expect(cell.eslintBroken).toBe(0);
    expect(cell.reasons.get('repair ran but tools still do not start')).toBe(3);
  });

  it('tallies each kind separately with its own reasons and tool state', () => {
    const lines = [
      ...recurring((d) => skipped(d, 8, 'already repaired within the last hour')),
      ...recurring((d) => heal(d, 9, 'failed', { ok: false, reason: 'repair command failed', tsgo: false, eslint: false })),
    ];
    const { rows: parsed } = parseSourceHealLedger(lines.join('\n'));
    const folded = foldSourceHealEvidence(parsed, { nowMs: NOW_MS });
    expect(folded.cells.map((c) => c.kind).sort()).toEqual(['failed', 'skipped']);
    const skippedCell = folded.cells.find((c) => c.kind === 'skipped')!;
    expect(skippedCell.reasons.get('already repaired within the last hour')).toBe(3);
    const failedCell = folded.cells.find((c) => c.kind === 'failed')!;
    expect(failedCell.tsgoBroken).toBe(3);
    expect(failedCell.eslintBroken).toBe(3);
  });

  it('stays quiet below the recurring bars and outside the window', () => {
    // Three failures on ONE UTC day only — a storm, not a recurrence.
    const oneDay = foldSourceHealEvidence(
      [row(D3, 8, 'failed'), row(D3, 9, 'failed'), row(D3, 10, 'failed'), row(D3, 11, 'failed')],
      { nowMs: NOW_MS },
    );
    expect(oneDay.cells).toEqual([]);

    // Two records across two days — under the units bar.
    const two = foldSourceHealEvidence([row(D1, 8, 'failed'), row(D2, 8, 'failed')], { nowMs: NOW_MS });
    expect(two.cells).toEqual([]);

    // Old records outside the 7-day window never count.
    const ancient = foldSourceHealEvidence(
      [row('2026-11-10', 8, 'failed'), row('2026-11-11', 8, 'failed'), row('2026-11-12', 8, 'failed'), row('2026-11-13', 8, 'failed')],
      { nowMs: NOW_MS },
    );
    expect(ancient.records).toBe(0);
    expect(ancient.outsideWindow).toBe(4);
    expect(ancient.cells).toEqual([]);
  });
});

describe('sourceHealBacklogItems', () => {
  it('emits one item per recurring kind with stable ids, prompts and metadata', async () => {
    const log = await journalFor('heal-all.jsonl', [
      ...recurring((d) => heal(d, 8, 'failed', { ok: false, tsgo: false, eslint: true })),
      ...recurring((d) => skipped(d, 9, 'already repaired within the last hour')),
      ...recurring((d) => heal(d, 10, 'probe')),
      // A kind below the bars never emits.
      heal(D1, 11, 'repaired'), heal(D2, 11, 'repaired'),
    ]);
    const items = await sourceHealBacklogItems({ repo: 'ashlrai/phantom', logPath: log, now: new Date(NOW_MS) });
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.priority === 3 && i.area === 'source-heal' && i.repo === 'ashlrai/phantom')).toBe(true);
    expect(items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(new Set(items.map((i) => i.id)).size).toBe(2);
    expect(items.every((i) => i.id.startsWith('source-heal-') && i.id.length <= 120)).toBe(true);

    const failed = items.find((i) => i.title.includes('failing'))!;
    const skippedItem = items.find((i) => i.title.includes('skipped'))!;
    expect(failed.prompt).toContain("'failed' record(s) across 3 UTC days");
    expect(failed.prompt).toContain('repair ran but tools still do not start');
    expect(failed.prompt).toContain('tsgo still broken in 3 row(s)');
    expect(failed.prompt).toContain('bridge-source-repair.jsonl');
    expect(failed.prompt).toContain('bridge-heal.mjs');
    expect(failed.prompt).toContain('no-change');
    expect(failed.prompt).toContain('3 healthy');
    expect(skippedItem.prompt).toContain('already repaired within the last hour');
    expect(skippedItem.prompt).toContain('wedged lock');
  });

  it('emits nothing below the bars, on a missing or junk journal, or for another repository', async () => {
    // Below the units bar: two records across two days.
    const few = await journalFor('heal-few.jsonl', [heal(D1, 8, 'failed', { ok: false }), heal(D2, 8, 'failed', { ok: false })]);
    expect(await sourceHealBacklogItems({ repo: 'ashlrai/phantom', logPath: few, now: new Date(NOW_MS) })).toEqual([]);

    // Below the days bar: four records on one UTC day.
    const oneDay = await journalFor('heal-oneday.jsonl', [
      heal(D3, 8, 'failed', { ok: false }), heal(D3, 9, 'failed', { ok: false }),
      heal(D3, 10, 'failed', { ok: false }), heal(D3, 11, 'failed', { ok: false }),
    ]);
    expect(await sourceHealBacklogItems({ repo: 'ashlrai/phantom', logPath: oneDay, now: new Date(NOW_MS) })).toEqual([]);

    // Missing file and a directory where the file should be.
    expect(await sourceHealBacklogItems({ repo: 'ashlrai/phantom', logPath: join(home, 'no-such.jsonl'), now: new Date(NOW_MS) })).toEqual([]);
    const dir = join(home, 'heal-dir');
    await mkdir(dir, { recursive: true });
    expect(await sourceHealBacklogItems({ repo: 'ashlrai/phantom', logPath: dir, now: new Date(NOW_MS) })).toEqual([]);

    // Garbage journals are not evidence.
    const junk = await journalFor('heal-junk.jsonl', ['not json', '{"schema":"phm.bridge.source-heal/1"}', '']);
    expect(await sourceHealBacklogItems({ repo: 'ashlrai/phantom', logPath: junk, now: new Date(NOW_MS) })).toEqual([]);

    // Healthy probes alone are not evidence.
    const healthy = await journalFor('heal-healthy.jsonl', recurring((d) => heal(d, 8, 'probe')));
    expect(await sourceHealBacklogItems({ repo: 'ashlrai/phantom', logPath: healthy, now: new Date(NOW_MS) })).toEqual([]);

    // Another repository never inherits this install's heal evidence.
    const log = await journalFor('heal-repo.jsonl', recurring((d) => heal(d, 8, 'failed', { ok: false })));
    expect(await sourceHealBacklogItems({ repo: 'ashlrai/other', logPath: log, now: new Date(NOW_MS) })).toEqual([]);
    expect(await sourceHealBacklogItems({ repo: 'AshlrAI/Phantom', logPath: log, now: new Date(NOW_MS) })).toHaveLength(1);
  });

  it('honours $ASHLR_BRIDGE_HEAL_LOG and resolves the journal through findSource + repairLogPath', async () => {
    const lines = recurring((d) => heal(d, 8, 'failed', { ok: false, tsgo: false, eslint: false }));

    // Env override wins over source resolution (the ASHLR_RUNS_DIR convention).
    const viaEnv = await journalFor('heal-env.jsonl', lines);
    process.env.ASHLR_BRIDGE_HEAL_LOG = viaEnv;
    expect(await sourceHealBacklogItems({ repo: 'ashlrai/phantom', now: new Date(NOW_MS) })).toHaveLength(1);
    delete process.env.ASHLR_BRIDGE_HEAL_LOG;

    // Source resolution: a checkout whose .git holds the journal — the
    // same pair the writer's caller and `phm doctor worktree` use.
    const source = join(home, 'src-checkout');
    await mkdir(join(source, '.git'), { recursive: true });
    await writeFile(join(source, '.git', 'bridge-source-repair.jsonl'), lines.join('\n') + '\n');
    const probe = (commonDir: string | null): WorktreeProbe => ({
      exists: () => false,
      isSymlink: () => false,
      realpath: (p) => p,
      starts: () => false,
      git: () => commonDir,
      readText: () => null,
    });
    const viaSource = await sourceHealBacklogItems({ repo: 'ashlrai/phantom', root: source, probe: probe('.git'), now: new Date(NOW_MS) });
    expect(viaSource).toHaveLength(1);

    // Git cannot identify a source → no journal to fold → no items.
    expect(await sourceHealBacklogItems({ repo: 'ashlrai/phantom', root: source, probe: probe(null), now: new Date(NOW_MS) })).toEqual([]);
  });

  it('states truncated journal tails as lower bounds and scrubs journal strings', async () => {
    // >4 MiB of retained rows: the bounded tail drops the oldest bytes,
    // so every count is a lower bound. The recurring cell's early rows
    // sit at the file's tail so the bounded read retains them.
    const filler: string[] = [];
    for (let i = 0; i < 30000; i += 1) {
      filler.push(heal(D3, i % 24, 'probe'));
    }
    const log = await journalFor('heal-big.jsonl', [...filler, ...recurring((d) => heal(d, 8, 'failed', { ok: false }))]);
    const items = await sourceHealBacklogItems({ repo: 'ashlrai/phantom', logPath: log, now: new Date(NOW_MS) });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('lower bound');
  }, 30_000);

  it('scrubs secret-shaped text out of journal reasons before it reaches a prompt', async () => {
    const token = '123456789:AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHHJ';
    const log = await journalFor('heal-secret.jsonl', recurring((d) => skipped(d, 8, `repair lock error ${token}`)));
    const items = await sourceHealBacklogItems({ repo: 'ashlrai/phantom', logPath: log, now: new Date(NOW_MS) });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).not.toContain(token);
    expect(items[0]!.prompt).toContain('[REDACTED]');
  });

  it('honours the item limit and derives stable ids across calls', async () => {
    const log = await journalFor('heal-stable.jsonl', [
      ...recurring((d) => heal(d, 8, 'failed', { ok: false })),
      ...recurring((d) => skipped(d, 9, 'already repaired within the last hour')),
      ...recurring((d) => heal(d, 10, 'repaired')),
    ]);
    const opts = { repo: 'ashlrai/phantom', logPath: log, now: new Date(NOW_MS) };
    const first = await sourceHealBacklogItems(opts);
    const second = await sourceHealBacklogItems(opts);
    expect(first).toHaveLength(3);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    const limited = await sourceHealBacklogItems({ ...opts, limit: 2 });
    expect(limited).toHaveLength(2);
    expect(limited.length).toBeLessThanOrEqual(Math.min(SOURCE_HEAL_BACKLOG_MAX_ITEMS, 12));
  });

  it('appends source-heal items through discovery and dedupes on refresh', async () => {
    // discoverBacklog anchors the evidence window on the wall clock, so
    // the fixtures use days relative to real now — three distinct UTC
    // days inside the window, like the fixed-date fixtures above.
    const dayAgo = (days: number): string => new Date(Date.now() - days * DAY_MS).toISOString().slice(0, 10);
    const iso = (days: number, hour: number): string => `${dayAgo(days)}T${String(hour).padStart(2, '0')}:00:00.000Z`;
    const line = (days: number, hour: number, event: string, over: Record<string, unknown> = {}): string =>
      JSON.stringify({
        schema: 'phm.bridge.source-heal/1', at: iso(days, hour), event,
        ok: event === 'probe' || event === 'repaired',
        reason: event === 'probe' ? 'source tools start' : event === 'repaired' ? REPAIR : 'repair ran but tools still do not start',
        tsgo: event === 'probe' || event === 'repaired',
        eslint: event === 'probe' || event === 'repaired',
        ...over,
      });
    const log = join(home, 'bridge-source-repair.jsonl');
    await writeFile(log, [1, 2, 3].map((d) => [
      line(d, 8, 'failed', { ok: false, tsgo: false, eslint: true }),
      line(d, 9, 'skipped', { ok: false, reason: 'already repaired within the last hour', tsgo: false, eslint: true }),
    ].join('\n')).join('\n') + '\n');
    process.env.ASHLR_BRIDGE_HEAL_LOG = log;
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const items = first.items.filter((i) => i.id.startsWith('source-heal-'));
    expect(items).toHaveLength(2);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(items)).toBe(2);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('source-heal-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('source-heal-'))).toHaveLength(2);
  });
});
