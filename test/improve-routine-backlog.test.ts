import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverBacklog } from '../src/core/improve/discover.js';
import {
  foldRoutineAttemptCells,
  parseRoutineAttemptRows,
  ROUTINE_BACKLOG_MAX_ITEMS,
  ROUTINE_MIN_DAYS,
  ROUTINE_MIN_UNITS,
  routineBacklogItems,
  type RoutineAttemptRow,
} from '../src/core/improve/routine-backlog.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

let home: string;
let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };
beforeEach(() => {
  saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
  delete process.env.ASHLR_HOME;
  delete process.env.ASHLR_RUNS_DIR;
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'improve-routine-')));
  process.env.HOME = home;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(home, { recursive: true, force: true });
});

const NOW = new Date('2026-11-23T12:00:00Z');
const NOW_MS = NOW.getTime();
/** ISO timestamp `days` before NOW (fractional hours allowed via `hours`). */
const at = (days: number, hours = 0): string =>
  new Date(NOW_MS - days * 86400_000 + hours * 3600_000).toISOString();

const REPO = 'ashlrai/phantom';

interface JournalRow {
  routine?: string;
  executor?: string;
  at?: string;
  duration?: number;
  costEstimate?: number;
  outcome?: string;
  slot?: string;
}

/** One runs.jsonl Attempt row under the writer's contract. */
const row = (over: Partial<JournalRow> & { routine: string; outcome: string }): JournalRow => ({
  executor: 'codex-main',
  at: at(1),
  duration: 1200,
  costEstimate: 0.02,
  slot: '2026-11-22T11:00',
  ...over,
});

const journal = (rows: Array<JournalRow | string>): string =>
  rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';

const writeJournal = (rows: Array<JournalRow | string> | string): string => {
  const dir = path.join(home, 'routines');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'runs.jsonl');
  fs.writeFileSync(file, typeof rows === 'string' ? rows : journal(rows));
  return file;
};

const attempt = (routine: string, executor: string, outcome: string, daysAgo: number, hours = 0): RoutineAttemptRow => ({
  atMs: NOW_MS - daysAgo * 86400_000 + hours * 3600_000,
  utcDay: new Date(NOW_MS - daysAgo * 86400_000 + hours * 3600_000).toISOString().slice(0, 10),
  routine,
  executor,
  outcome,
  durationMs: 100,
  costEstimate: 0.01,
});

describe('parseRoutineAttemptRows', () => {
  it('keeps contract rows and skips malformed or off-contract lines', () => {
    const rows = parseRoutineAttemptRows(journal([
      'not json',
      '{"routine":"Bad Routine!","executor":"codex-main","at":"2026-11-22T00:00:00Z","duration":1,"costEstimate":0,"outcome":"failed"}',
      '{"routine":"nightly-audit","executor":"Bad Executor!","at":"2026-11-22T00:00:00Z","duration":1,"costEstimate":0,"outcome":"failed"}',
      '{"routine":"nightly-audit","executor":"codex-main","at":"not-a-date","duration":1,"costEstimate":0,"outcome":"failed"}',
      '{"routine":"nightly-audit","executor":"codex-main","at":"2026-11-22T00:00:00Z","duration":-1,"costEstimate":0,"outcome":"failed"}',
      '{"routine":"nightly-audit","executor":"codex-main","at":"2026-11-22T00:00:00Z","duration":1,"costEstimate":NaN,"outcome":"failed"}',
      '{"routine":"nightly-audit","executor":"codex-main","at":"2026-11-22T00:00:00Z","duration":1,"costEstimate":0,"outcome":"bogus"}',
      '{"routine":"nightly-audit","executor":"codex-main","at":"2026-11-22T00:00:00Z","duration":1,"costEstimate":0,"outcome":"failed","slot":42}',
      `{"routine":"nightly-audit","executor":"codex-main","at":"${at(1)}","duration":1200,"costEstimate":0.02,"outcome":"failed","slot":"2026-11-22T11:00","extraField":"ignored"}`,
      row({ routine: 'morning-summary', executor: 'none', outcome: 'unavailable', at: at(2), duration: 0, costEstimate: 0 }),
    ]));
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ routine: 'nightly-audit', executor: 'codex-main', outcome: 'failed', durationMs: 1200 });
    expect(rows[1]).toMatchObject({ routine: 'morning-summary', executor: 'none', outcome: 'unavailable', durationMs: 0 });
  });
});

describe('foldRoutineAttemptCells', () => {
  it('keys routine cells on routine-side outcomes and executor cells on executor-side ones', () => {
    const cells = foldRoutineAttemptCells([
      attempt('nightly-audit', 'codex-main', 'failed', 1),
      attempt('nightly-audit', 'codex-main', 'failed', 2),
      attempt('nightly-audit', 'claude-pro', 'unavailable', 1), // unreachable shape; unavailable always executor 'none' in practice
      attempt('morning-summary', 'none', 'unavailable', 1),
      attempt('morning-summary', 'none', 'unavailable', 2),
      attempt('fleet-triage', 'omlx-local', 'unhealthy', 1),
      attempt('fleet-triage', 'omlx-local', 'unhealthy', 3),
      attempt('docs-drain', 'claude-pro', 'quota', 1),
      attempt('docs-drain', 'claude-pro', 'success', 1), // working state never counts
      attempt('docs-drain', 'claude-pro', 'submitted', 2), // working state never counts
    ], NOW_MS);
    const routineCells = cells.filter((c) => c.dimension === 'routine');
    const executorCells = cells.filter((c) => c.dimension === 'executor');
    // Routine cells: only 'failed' and 'unavailable'.
    expect(routineCells.map((c) => [c.id, c.outcome, c.rows])).toEqual([
      ['morning-summary', 'unavailable', 2],
      ['nightly-audit', 'failed', 2],
      ['nightly-audit', 'unavailable', 1],
    ]);
    // Executor cells: only failed/quota/rate-limit/unhealthy on real executors.
    expect(executorCells.map((c) => [c.id, c.outcome, c.rows])).toEqual([
      ['codex-main', 'failed', 2],
      ['omlx-local', 'unhealthy', 2],
      ['claude-pro', 'quota', 1],
    ]);
    // 'none' never forms a cell — the unavailable sentinel names no executor.
    expect(executorCells.some((c) => c.id === 'none')).toBe(false);
  });

  it('tallies counterparty ids and marks the lower bound', () => {
    const cells = foldRoutineAttemptCells([
      attempt('nightly-audit', 'codex-main', 'failed', 1),
      attempt('nightly-audit', 'codex-main', 'failed', 2),
      attempt('nightly-audit', 'claude-pro', 'failed', 3),
      attempt('r-one', 'omlx-local', 'unhealthy', 1),
      attempt('r-two', 'omlx-local', 'unhealthy', 2),
      attempt('r-three', 'omlx-local', 'unhealthy', 4),
    ], NOW_MS, undefined, true);
    const routine = cells.find((c) => c.dimension === 'routine')!;
    expect(routine.partners).toEqual([
      { text: 'codex-main', count: 2 },
      { text: 'claude-pro', count: 1 },
    ]);
    const executor = cells.find((c) => c.dimension === 'executor')!;
    expect(executor.id).toBe('omlx-local');
    expect(executor.partners).toHaveLength(3);
    expect(executor.lowerBound).toBe(true);
    expect(executor.firstSeen).toBe(at(4));
    expect(executor.lastSeen).toBe(at(1));
  });

  it('drops rows outside the window and beyond the future-skew allowance', () => {
    const cells = foldRoutineAttemptCells([
      attempt('old-routine', 'codex-main', 'failed', 8),
      attempt('old-routine', 'codex-main', 'failed', 9),
      attempt('old-routine', 'codex-main', 'failed', 10),
      attempt('future-routine', 'codex-main', 'failed', -1),
      attempt('future-routine', 'codex-main', 'failed', -1, 1),
      attempt('future-routine', 'codex-main', 'failed', -1, 2),
      attempt('in-window', 'codex-main', 'failed', 1),
    ], NOW_MS);
    // One-row cells sort executor before routine on the dimension tiebreak.
    expect(cells.map((c) => c.id)).toEqual(['codex-main', 'in-window']);
  });
});

describe('routineBacklogItems', () => {
  it('turns a routine whose attempts keep failing into a valid item', async () => {
    const items = await routineBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([
        row({ routine: 'nightly-audit', outcome: 'failed', at: at(1) }),
        row({ routine: 'nightly-audit', outcome: 'failed', at: at(1, 5) }),
        row({ routine: 'nightly-audit', outcome: 'failed', at: at(3) }),
        row({ routine: 'nightly-audit', outcome: 'failed', at: at(5) }),
        row({ routine: 'nightly-audit', outcome: 'success', at: at(2) }),
      ]),
    });
    // The same rows also evidence the executor cell — both families emit.
    expect(items).toHaveLength(2);
    const routineItem = items.find((i) => i.title.includes('nightly-audit'))!;
    const executorItem = items.find((i) => i.title.includes('codex-main'))!;
    for (const item of items) {
      expect(validBacklogItem(item)).not.toBeNull();
      expect(item).toMatchObject({ priority: 3, repo: REPO, area: 'routines' });
      expect(item.id).toMatch(/^fleet-routine-[0-9a-f]{16}$/);
      expect(item.prompt).toContain('runs.jsonl');
      expect(item.prompt).toContain('no-change');
    }
    expect(routineItem.title).toBe(`Scheduled routine 'nightly-audit' keeps ending 'failed'`);
    expect(routineItem.prompt).toContain('4 \'failed\' attempt row(s)');
    expect(routineItem.prompt).toContain('3 distinct UTC day(s)');
    expect(routineItem.prompt).toContain("'codex-main' ×4");
    expect(executorItem.title).toBe(`Routine executor 'codex-main' keeps recording 'failed'`);
    expect(executorItem.prompt).toContain('nightly-audit');
  });

  it('turns a starved routine into an unavailable item with no executor cell', async () => {
    const items = await routineBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([
        row({ routine: 'starved-job', executor: 'none', outcome: 'unavailable', at: at(1), duration: 0, costEstimate: 0 }),
        row({ routine: 'starved-job', executor: 'none', outcome: 'unavailable', at: at(2), duration: 0, costEstimate: 0 }),
        row({ routine: 'starved-job', executor: 'none', outcome: 'unavailable', at: at(4), duration: 0, costEstimate: 0 }),
      ]),
    });
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toBe(`Scheduled routine 'starved-job' keeps finding no eligible executor`);
    expect(items[0]!.prompt).toContain('no executor was eligible');
    expect(items[0]!.prompt).not.toContain('Executors recorded');
  });

  it('folds provider-side outcomes into executor cells only, never routine cells', async () => {
    const items = await routineBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([
        row({ routine: 'docs-drain', executor: 'claude-pro', outcome: 'quota', at: at(1) }),
        row({ routine: 'release-check', executor: 'claude-pro', outcome: 'quota', at: at(2) }),
        row({ routine: 'docs-drain', executor: 'claude-pro', outcome: 'quota', at: at(3) }),
        row({ routine: 'docs-drain', executor: 'claude-pro', outcome: 'rate-limit', at: at(5) }),
        row({ routine: 'fleet-triage', executor: 'omlx-local', outcome: 'unhealthy', at: at(1) }),
        row({ routine: 'fleet-triage', executor: 'omlx-local', outcome: 'unhealthy', at: at(2) }),
        row({ routine: 'docs-drain', executor: 'omlx-local', outcome: 'unhealthy', at: at(4) }),
      ]),
    });
    // quota×3 on claude-pro and unhealthy×3 on omlx-local reach the bars; the lone
    // rate-limit row folds into its own cell but stays below it — executor cells only.
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.title).sort()).toEqual([
      `Routine executor 'claude-pro' keeps recording 'quota'`,
      `Routine executor 'omlx-local' keeps recording 'unhealthy'`,
    ]);
    expect(items.every((i) => i.title.startsWith('Routine executor'))).toBe(true);
    const quota = items.find((i) => i.title.includes('claude-pro'))!;
    expect(quota.prompt).toContain("'docs-drain' ×2");
    expect(quota.prompt).toContain("'release-check' ×1");
  });

  it('emits nothing below the recurring bars of rows and distinct days', async () => {
    // Three rows but a single UTC day — under the days bar.
    const oneDay = writeJournal([
      row({ routine: 'nightly-audit', outcome: 'failed', at: at(1) }),
      row({ routine: 'nightly-audit', outcome: 'failed', at: at(1, 3) }),
      row({ routine: 'nightly-audit', outcome: 'failed', at: at(1, 6) }),
    ]);
    expect(await routineBacklogItems({ repo: REPO, journalPath: oneDay, now: NOW })).toEqual([]);
    // Two rows across two days — under the units bar.
    const twoRows = writeJournal([
      row({ routine: 'nightly-audit', outcome: 'failed', at: at(1) }),
      row({ routine: 'nightly-audit', outcome: 'failed', at: at(3) }),
    ]);
    expect(await routineBacklogItems({ repo: REPO, journalPath: twoRows, now: NOW })).toEqual([]);
    expect(ROUTINE_MIN_UNITS).toBe(3);
    expect(ROUTINE_MIN_DAYS).toBe(2);
  });

  it('never counts working outcomes: success and submitted rows emit nothing', async () => {
    const items = await routineBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([
        row({ routine: 'nightly-audit', outcome: 'success', at: at(1) }),
        row({ routine: 'nightly-audit', outcome: 'success', at: at(2) }),
        row({ routine: 'nightly-audit', outcome: 'submitted', at: at(3) }),
        row({ routine: 'nightly-audit', outcome: 'submitted', at: at(4) }),
        row({ routine: 'nightly-audit', outcome: 'submitted', at: at(5) }),
      ]),
    });
    expect(items).toEqual([]);
  });

  it('yields nothing for a missing or malformed journal', async () => {
    expect(await routineBacklogItems({ repo: REPO, journalPath: path.join(home, 'no-such.jsonl'), now: NOW })).toEqual([]);
    const file = writeJournal([
      'not json',
      '{"routine":"nightly-audit","executor":"codex-main","at":"2026-11-22T00:00:00Z","duration":1,"costEstimate":0,"outcome":"bogus"}',
      '{"schema":"other.v1","routine":"nightly-audit","executor":"codex-main","at":"2026-11-22T00:00:00Z","duration":1,"costEstimate":0,"outcome":"failed"}',
      '{"routine":"nightly-audit","executor":"codex-main","outcome":"failed"}',
    ]);
    expect(await routineBacklogItems({ repo: REPO, journalPath: file, now: NOW })).toEqual([]);
    expect(await routineBacklogItems({ repo: '', journalPath: file, now: NOW })).toEqual([]);
    expect(await routineBacklogItems({ repo: 'not-a-repo', journalPath: file, now: NOW })).toEqual([]);
  });

  it('emits nothing for another repository or an empty repo', async () => {
    const file = writeJournal([
      row({ routine: 'nightly-audit', outcome: 'failed', at: at(1) }),
      row({ routine: 'nightly-audit', outcome: 'failed', at: at(3) }),
      row({ routine: 'nightly-audit', outcome: 'failed', at: at(5) }),
    ]);
    expect(await routineBacklogItems({ repo: 'ashlrai/other', journalPath: file, now: NOW })).toEqual([]);
    expect(await routineBacklogItems({ repo: 'AshlrAI/Phantom', journalPath: file, now: NOW })).toHaveLength(2);
  });

  it('drops rows outside the 7-day window and beyond the future-skew allowance', async () => {
    const stale = writeJournal([
      row({ routine: 'nightly-audit', outcome: 'failed', at: at(8) }),
      row({ routine: 'nightly-audit', outcome: 'failed', at: at(9) }),
      row({ routine: 'nightly-audit', outcome: 'failed', at: at(10) }),
    ]);
    expect(await routineBacklogItems({ repo: REPO, journalPath: stale, now: NOW })).toEqual([]);
    const future = writeJournal([
      row({ routine: 'nightly-audit', outcome: 'failed', at: at(-1) }),
      row({ routine: 'nightly-audit', outcome: 'failed', at: at(-1, 1) }),
      row({ routine: 'nightly-audit', outcome: 'failed', at: at(-1, 2) }),
    ]);
    expect(await routineBacklogItems({ repo: REPO, journalPath: future, now: NOW })).toEqual([]);
  });

  it('states truncation as a lower bound in the prompt', async () => {
    const file = writeJournal([
      row({ routine: 'nightly-audit', outcome: 'failed', at: at(1) }),
      row({ routine: 'nightly-audit', outcome: 'failed', at: at(3) }),
      row({ routine: 'nightly-audit', outcome: 'failed', at: at(5) }),
    ]);
    // Pad the journal past the 512 KiB tail so the read reports truncated.
    fs.writeFileSync(file, 'x'.repeat(600 * 1024) + '\n' + fs.readFileSync(file, 'utf8'));
    const items = await routineBacklogItems({ repo: REPO, journalPath: file, now: NOW });
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) expect(item.prompt).toContain('lower bound');
  });

  it('derives stable ids so a refresh re-adds nothing', async () => {
    const rows = [
      row({ routine: 'nightly-audit', outcome: 'failed', at: at(1) }),
      row({ routine: 'nightly-audit', outcome: 'failed', at: at(3) }),
      row({ routine: 'nightly-audit', outcome: 'failed', at: at(5) }),
    ];
    const file = writeJournal(rows);
    const first = await routineBacklogItems({ repo: REPO, journalPath: file, now: NOW });
    const second = await routineBacklogItems({ repo: REPO, journalPath: file, now: NOW });
    expect(first.length).toBeGreaterThan(0);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    // Shifted tallies on the same cells re-derive the same ids.
    const grown = writeJournal([...rows, row({ routine: 'nightly-audit', outcome: 'failed', at: at(6) })]);
    const third = await routineBacklogItems({ repo: REPO, journalPath: grown, now: NOW });
    expect(third.map((i) => i.id)).toEqual(first.map((i) => i.id));
    expect(first.length).toBeLessThanOrEqual(ROUTINE_BACKLOG_MAX_ITEMS);
  });

  it('reads the default journal path under the Ashlr home', async () => {
    // The writer's own layout: <ashlr home>/routines/runs.jsonl.
    writeJournal([
      row({ routine: 'nightly-audit', outcome: 'failed', at: at(1) }),
      row({ routine: 'nightly-audit', outcome: 'failed', at: at(3) }),
      row({ routine: 'nightly-audit', outcome: 'failed', at: at(5) }),
    ]);
    const src = path.join(home, 'routines', 'runs.jsonl');
    const dir = path.join(home, '.ashlr', 'routines');
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(src, path.join(dir, 'runs.jsonl'));
    const items = await routineBacklogItems({ repo: REPO, now: NOW });
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.id.startsWith('fleet-routine-'))).toBe(true);
  });

  it('appends routine items through discovery and dedupes on refresh', async () => {
    const dir = path.join(home, '.ashlr', 'routines');
    fs.mkdirSync(dir, { recursive: true });
    const now = Date.now();
    fs.writeFileSync(path.join(dir, 'runs.jsonl'), journal([1, 3, 5].map((days) => row({
      routine: 'nightly-audit', outcome: 'failed', at: new Date(now - days * 86400_000).toISOString(),
    }))));
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog(REPO, { gh: greenGh });
    const routineItems = first.items.filter((i) => i.id.startsWith('fleet-routine-'));
    expect(routineItems).toHaveLength(2);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(routineItems)).toBe(routineItems.length);
    const second = await discoverBacklog(REPO, { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('fleet-routine-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('fleet-routine-'))).toHaveLength(routineItems.length);
  });
});
