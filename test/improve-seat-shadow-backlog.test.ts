import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { seatShadowBacklogItems } from '../src/core/improve/seat-shadow-backlog.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

let home: string;
let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };
beforeEach(() => {
  saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
  delete process.env.ASHLR_HOME;
  delete process.env.ASHLR_RUNS_DIR;
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'improve-seat-shadow-')));
  process.env.HOME = home;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(home, { recursive: true, force: true });
});

const NOW = new Date('2026-11-23T12:00:00Z');
const NOW_MS = NOW.getTime();
const daysAgo = (days: number): string => new Date(NOW_MS - days * 86_400_000).toISOString();

const REPO = 'ashlrai/phantom';

interface Opts {
  source?: string;
  task?: string;
  /** decision.seatId — string pick or null for "router found nothing". */
  pick?: string | null;
  /** actual block; undefined writes the tick-hooks echo shape, null writes no actual. */
  actual?: { engine: string; seatId: string | null } | null;
  at?: string;
}

let seq = 0;
/** One shadow decision in the writer's v1 shape (isDecisionRecord contract). */
const shadow = (days: number, opts: Opts = {}): Record<string, unknown> => ({
  v: 1,
  at: opts.at ?? daysAgo(days),
  source: opts.source ?? 'daemon',
  request: { task: opts.task ?? 'code', difficulty: 'low', contextTokens: 1024, autonomous: true },
  decision: {
    seatId: opts.pick === undefined ? 'devin' : opts.pick,
    candidates: ['devin'],
    exclusions: [],
    why: `seat pick ${++seq}`,
    mode: 'balanced',
  },
  actual: opts.actual === undefined
    ? { engine: 'devin-cli', seatId: opts.pick === undefined ? 'devin' : opts.pick }
    : opts.actual,
});

/** n agreeing records (pick 'devin', devin-cli backend, devin seat ran). */
const clean = (days: number, n: number, opts: Opts = {}): Record<string, unknown>[] =>
  Array.from({ length: n }, () => shadow(days, opts));

/** Records spread across `span` days so a cell meets the 2-day bar. */
const spread = <T>(make: (day: number) => T, days: number[]): T[] => days.map(make);

const routingDir = (): string => {
  const dir = path.join(home, '.ashlr', 'routing');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
};

const writeJournal = (rows: Record<string, unknown>[], file = 'decisions.jsonl', dir?: string): string => {
  const target = dir ?? routingDir();
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, file), rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return target;
};

describe('seatShadowBacklogItems', () => {
  it('turns recurring seat divergence into a valid priority-3 backlog item', async () => {
    const rows = spread(
      (d) => shadow(d, { pick: 'devin', actual: { engine: 'devin-cli', seatId: 'codex-cmp' } }),
      [0, 1, 2],
    );
    const items = await seatShadowBacklogItems({ repo: REPO, dir: writeJournal(rows), now: NOW_MS });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.id).toMatch(/^seat-shadow-seat-[0-9a-f]{16}$/);
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item).toMatchObject({ priority: 3, repo: REPO, area: 'seat-shadow' });
    expect(item.prompt).toContain('devin→codex-cmp');
    expect(item.prompt).toContain('3');
    expect(item.prompt).toContain('decisions.jsonl');
    expect(item.prompt).toContain('recordShadowDecision');
    expect(item.prompt).toContain('no-change');
  });

  it('turns recurring engine-class divergence into an item naming the pair', async () => {
    const rows = spread(
      (d) => shadow(d, { pick: 'codex-cmp', actual: { engine: 'devin-cli', seatId: null } }),
      [0, 1, 2],
    );
    const items = await seatShadowBacklogItems({ repo: REPO, dir: writeJournal(rows), now: NOW_MS });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.id).toMatch(/^seat-shadow-engine-[0-9a-f]{16}$/);
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item.prompt).toContain('codex-cmp:codex>devin-cli:devin');
    expect(item.prompt).toContain('engineOfSeatId');
    expect(item.prompt).toContain('no-change');
  });

  it('turns a null pick beside a running budget engine into a no-seat item', async () => {
    const rows = spread(
      (d) => shadow(d, { pick: null, actual: { engine: 'claude', seatId: null } }),
      [0, 1, 2],
    );
    const items = await seatShadowBacklogItems({ repo: REPO, dir: writeJournal(rows), now: NOW_MS });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.id).toMatch(/^seat-shadow-no-seat-[0-9a-f]{16}$/);
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item.prompt).toContain('claude:claude');
    expect(item.prompt).toContain('no eligible seat');
  });

  it('catches a backend contradicting an honored seat pick', async () => {
    // actual.seatId echoes the pick (the tick-hooks shape) but the recorded
    // backend maps to a different engine class — internal inconsistency.
    const rows = spread(
      (d) => shadow(d, { pick: 'devin', actual: { engine: 'claude', seatId: 'devin' } }),
      [0, 1, 2],
    );
    const items = await seatShadowBacklogItems({ repo: REPO, dir: writeJournal(rows), now: NOW_MS });
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toMatch(/^seat-shadow-engine-/);
    expect(items[0]!.prompt).toContain('devin:devin>claude:claude');
  });

  it('stays quiet on agreement, unmapped backends, missing actuals and the test source', async () => {
    // Agreement: same seat, matching engine class.
    expect(await seatShadowBacklogItems({ repo: REPO, dir: writeJournal(clean(1, 10)), now: NOW_MS })).toEqual([]);
    // Unmapped backend (ashlrcode has no BudgetEngine class): cannot compare, never divergence.
    const unmapped = spread((d) => shadow(d, { pick: 'devin', actual: { engine: 'ashlrcode', seatId: null } }), [0, 1, 2]);
    expect(await seatShadowBacklogItems({ repo: REPO, dir: writeJournal(unmapped), now: NOW_MS })).toEqual([]);
    // No-seat beside an unmapped backend: unknown stays unknown.
    const noSeatUnmapped = spread((d) => shadow(d, { pick: null, actual: { engine: 'ashlrcode', seatId: null } }), [0, 1, 2]);
    expect(await seatShadowBacklogItems({ repo: REPO, dir: writeJournal(noSeatUnmapped), now: NOW_MS })).toEqual([]);
    // actual: null records carry no comparison.
    const noActual = spread((d) => shadow(d, { actual: null }), [0, 1, 2]);
    expect(await seatShadowBacklogItems({ repo: REPO, dir: writeJournal(noActual), now: NOW_MS })).toEqual([]);
    // 'test' source is fixture evidence, not fleet behavior.
    const tested = spread((d) => shadow(d, { source: 'test', pick: 'devin', actual: { engine: 'claude', seatId: null } }), [0, 1, 2]);
    expect(await seatShadowBacklogItems({ repo: REPO, dir: writeJournal(tested), now: NOW_MS })).toEqual([]);
    // Fleet machinery evidence never lands on another repository's backlog.
    const dir = writeJournal(spread((d) => shadow(d, { pick: 'devin', actual: { engine: 'claude', seatId: null } }), [0, 1, 2]));
    expect(await seatShadowBacklogItems({ repo: 'ashlrai/lexicon', dir, now: NOW_MS })).toEqual([]);
    expect(await seatShadowBacklogItems({ repo: '', dir, now: NOW_MS })).toEqual([]);
  });

  it('enforces the recurring bar: count and distinct UTC days', async () => {
    // Two divergences never reach the count bar.
    const two = spread((d) => shadow(d, { pick: 'devin', actual: { engine: 'claude', seatId: null } }), [0, 1]);
    expect(await seatShadowBacklogItems({ repo: REPO, dir: writeJournal(two), now: NOW_MS })).toEqual([]);
    // Three divergences on one UTC day never reach the days bar.
    const oneDay = spread(() => shadow(0, { pick: 'devin', actual: { engine: 'claude', seatId: null } }), [0, 0, 0]);
    expect(await seatShadowBacklogItems({ repo: REPO, dir: writeJournal(oneDay), now: NOW_MS })).toEqual([]);
  });

  it('windows rows by at and refuses stamps past the future skew', async () => {
    // Divergence 8 days old sits outside the 7-day window.
    const stale = spread(() => shadow(8, { pick: 'devin', actual: { engine: 'claude', seatId: null } }), [8, 8, 8]);
    expect(await seatShadowBacklogItems({ repo: REPO, dir: writeJournal(stale), now: NOW_MS })).toEqual([]);

    // Two in-window rows plus one stamped hours ahead: the future row is
    // refused, leaving the cell below the count bar.
    const dir = routingDir();
    const rows = [
      shadow(1, { pick: 'devin', actual: { engine: 'claude', seatId: null } }),
      shadow(1, { pick: 'devin', actual: { engine: 'claude', seatId: null } }),
      shadow(1, { pick: 'devin', actual: { engine: 'claude', seatId: null }, at: new Date(NOW_MS + 2 * 3_600_000).toISOString() }),
    ];
    writeJournal(rows, 'decisions.jsonl', dir);
    expect(await seatShadowBacklogItems({ repo: REPO, dir, now: NOW_MS })).toEqual([]);

    // Inside the five-minute skew the stamp still counts as same-host drift.
    const skewedDir = fs.mkdtempSync(path.join(home, 'routing-'));
    const skewed = [
      shadow(1, { pick: 'devin', actual: { engine: 'claude', seatId: null } }),
      shadow(1, { pick: 'devin', actual: { engine: 'claude', seatId: null } }),
      shadow(1, { pick: 'devin', actual: { engine: 'claude', seatId: null }, at: new Date(NOW_MS + 30_000).toISOString() }),
    ];
    writeJournal(skewed, 'decisions.jsonl', skewedDir);
    const items = await seatShadowBacklogItems({ repo: REPO, dir: skewedDir, now: NOW_MS });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('3');
  });

  it('folds the rotated decisions.1.jsonl generation beside the live file', async () => {
    const dir = routingDir();
    writeJournal(spread((d) => shadow(d, { pick: 'devin', actual: { engine: 'claude', seatId: null } }), [5, 6]), 'decisions.1.jsonl', dir);
    writeJournal(spread((d) => shadow(d, { pick: 'devin', actual: { engine: 'claude', seatId: null } }), [0, 1]), 'decisions.jsonl', dir);
    const items = await seatShadowBacklogItems({ repo: REPO, dir, now: NOW_MS });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('4');
  });

  it('skips malformed lines and records missing the contract', async () => {
    const dir = routingDir();
    const good = spread((d) => shadow(d, { pick: 'devin', actual: { engine: 'claude', seatId: null } }), [0, 1, 2]);
    const lines = [
      'not json',
      JSON.stringify({ v: 2, at: daysAgo(1), source: 'daemon' }),
      JSON.stringify({ v: 1, at: 'not-a-date', source: 'daemon', request: {}, decision: { seatId: 'devin', candidates: [], exclusions: [], why: 'x' }, actual: null }),
      // decision.seatId of the wrong type is malformed evidence, never guessed.
      JSON.stringify({ v: 1, at: daysAgo(1), source: 'daemon', request: { task: 'code' }, decision: { seatId: 42, candidates: [], exclusions: [], why: 'x' }, actual: { engine: 'claude', seatId: null } }),
      ...good.map((r) => JSON.stringify(r)),
    ];
    fs.writeFileSync(path.join(dir, 'decisions.jsonl'), lines.join('\n') + '\n');
    const items = await seatShadowBacklogItems({ repo: REPO, dir, now: NOW_MS });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('3');
  });

  it('emits one item per recurring cell, sorted by divergences, and honours the limit', async () => {
    const rows = [
      // engine cell: 4 divergences
      ...spread((d) => shadow(d, { task: 'code', pick: 'codex-cmp', actual: { engine: 'devin-cli', seatId: null } }), [0, 1, 2, 3]),
      // no-seat cell: 3 divergences on a different task
      ...spread((d) => shadow(d, { task: 'review', pick: null, actual: { engine: 'claude', seatId: null } }), [0, 1, 2]),
    ];
    const items = await seatShadowBacklogItems({ repo: REPO, dir: writeJournal(rows), now: NOW_MS });
    expect(items).toHaveLength(2);
    expect(items[0]!.id).toMatch(/^seat-shadow-engine-/);
    expect(items[1]!.id).toMatch(/^seat-shadow-no-seat-/);
    const one = await seatShadowBacklogItems({ repo: REPO, dir: writeJournal(rows), now: NOW_MS, limit: 1 });
    expect(one).toHaveLength(1);
    expect(one[0]!.id).toMatch(/^seat-shadow-engine-/);
  });

  it('derives stable ids so a refresh re-adds nothing', async () => {
    const dir = writeJournal(spread((d) => shadow(d, { pick: 'devin', actual: { engine: 'claude', seatId: null } }), [0, 1, 2]));
    const first = await seatShadowBacklogItems({ repo: REPO, dir, now: NOW_MS });
    const second = await seatShadowBacklogItems({ repo: REPO, dir, now: NOW_MS });
    expect(first).toHaveLength(1);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
  });

  it('yields nothing for a missing routing dir', async () => {
    expect(await seatShadowBacklogItems({ repo: REPO, dir: path.join(home, 'no-such-dir'), now: NOW_MS })).toEqual([]);
  });

  it('reads the default routing dir under HOME/.ashlr/routing', async () => {
    writeJournal(spread((d) => shadow(d, { pick: 'devin', actual: { engine: 'claude', seatId: null } }), [0, 1, 2]));
    const items = await seatShadowBacklogItems({ repo: REPO, now: NOW_MS });
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toMatch(/^seat-shadow-engine-/);
  });

  it('states lower bounds when a journal tail hits the reader cap', async () => {
    // 600 agreeing-then-diverging records push the file past the 500-record
    // read cap: the newest 500 return, the cell still qualifies, and the
    // prompt must say the counts are a lower bound.
    const dir = routingDir();
    const rows: Record<string, unknown>[] = [];
    for (let i = 0; i < 600; i += 1) {
      rows.push(shadow(i % 8, i >= 3 ? { pick: 'devin', actual: { engine: 'claude', seatId: null } } : {}));
    }
    writeJournal(rows, 'decisions.jsonl', dir);
    const items = await seatShadowBacklogItems({ repo: REPO, dir, now: NOW_MS });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('lower bound');
  });

  it('appends seat-shadow items through discovery and dedupes on refresh', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    try {
      process.env.ASHLR_RUNS_DIR = path.join(home, 'runs');
      writeJournal(spread((d) => shadow(d, { pick: 'devin', actual: { engine: 'claude', seatId: null } }), [0, 1, 2]));
      const greenGh = async (args: string[]) => {
        const p = args[4] ?? '';
        if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
        return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
      };
      const first = await discoverBacklog(REPO, { gh: greenGh });
      const shadowItems = first.items.filter((i) => i.id.startsWith('seat-shadow-'));
      expect(shadowItems).toHaveLength(1);
      expect(shadowItems[0]!.id).toMatch(/^seat-shadow-engine-/);
      expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
      expect(appendUserBacklogItems(shadowItems)).toBe(shadowItems.length);
      const second = await discoverBacklog(REPO, { gh: greenGh });
      expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('seat-shadow-')))).toBe(0);
      expect(readUserBacklogItems().filter((i) => i.id.startsWith('seat-shadow-'))).toHaveLength(shadowItems.length);
    } finally {
      vi.useRealTimers();
    }
  });
});
