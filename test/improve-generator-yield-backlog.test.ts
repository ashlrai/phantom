import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  GENERATION_CELL_MIN_DAYS,
  GENERATION_CELL_MIN_EVENTS,
  GENERATION_WINDOW_MS,
  GENERATOR_YIELD_MAX_ITEMS,
  foldGenerationRejections,
  generatorYieldBacklogItems,
} from '../src/core/improve/generator-yield-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import {
  appendUserBacklogItems,
  readUserBacklogItems,
  validBacklogItem,
} from '../src/core/cloud/backlog.js';

vi.mock('../src/core/improve/generator-yield-backlog.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/improve/generator-yield-backlog.js')>();
  return { ...actual, generatorYieldBacklogItems: vi.fn(actual.generatorYieldBacklogItems) };
});

const realFeed = (await vi.importActual<typeof import('../src/core/improve/generator-yield-backlog.js')>(
  '../src/core/improve/generator-yield-backlog.js',
)).generatorYieldBacklogItems;
const feedMock = vi.mocked(generatorYieldBacklogItems);

const REPO = 'ashlrai/phantom';
const NOW = Date.parse('2026-11-23T12:00:00Z');
/** ISO stamp `days` UTC days plus `hours` before NOW — distinct day buckets when the day differs. */
const at = (days: number, hours = 0) => new Date(NOW - days * 86_400_000 - hours * 3_600_000).toISOString();

/** One queue.generation-event.v1 row in the writers' shape. */
function gen(job: string, src: string, event: 'drafted' | 'rejected', ts: string, reason?: string): string {
  return JSON.stringify({ schema: 'queue.generation-event.v1', job, src, event, ...(reason !== undefined ? { reason } : {}), ts });
}
const rej = (job: string, src: string, reason: string, ts: string) => gen(job, src, 'rejected', ts, reason);
const draft = (job: string, src: string, ts: string) => gen(job, src, 'drafted', ts);

/**
 * `count` rejections for one (src, reason) cell spread across `days`
 * distinct UTC days — the recurring-bar fixture. Jobs are distinct per
 * event so the cell's job tally matches its event tally.
 */
function recurringRows(src: string, reason: string, count: number, dayList: number[], prefix: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    out.push(rej(`${prefix}-${i}`, src, reason, at(dayList[i % dayList.length]!, (i % 5) * 2)));
  }
  return out;
}

let previousAshlrHome: string | undefined;
let previousRunsDir: string | undefined;
let home: string;
let runsDir: string;

beforeEach(() => {
  feedMock.mockReset();
  feedMock.mockImplementation(realFeed);
  previousAshlrHome = process.env.ASHLR_HOME;
  previousRunsDir = process.env.ASHLR_RUNS_DIR;
  home = mkdtempSync(join(tmpdir(), 'ashlr-generation-backlog-'));
  runsDir = join(home, 'runs');
  process.env.ASHLR_HOME = home;
  process.env.ASHLR_RUNS_DIR = runsDir;
});

afterEach(() => {
  if (previousAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = previousAshlrHome;
  if (previousRunsDir === undefined) delete process.env.ASHLR_RUNS_DIR;
  else process.env.ASHLR_RUNS_DIR = previousRunsDir;
  rmSync(home, { recursive: true, force: true });
});

describe('generatorYieldBacklogItems', () => {
  it('emits one valid item per recurring (src, reason) refusal cell', async () => {
    const text = [
      // autofill:bet / stopped_family: 4 rejections across 3 distinct UTC days.
      ...recurringRows('autofill:bet', 'stopped_family', 4, [5, 4, 3, 2], 'bet-x'),
      // autofill:idea / missing_capability: 4 rejections across 2 distinct UTC days.
      ...recurringRows('autofill:idea', 'missing_capability', 4, [4, 3, 4, 3], 'idea-y'),
      // Same-src drafted context for the refusal share.
      draft('bet-ok-1', 'autofill:bet', at(4)),
      draft('bet-ok-2', 'autofill:bet', at(3)),
    ].join('\n');
    const items = await generatorYieldBacklogItems({ repo: REPO, now: NOW, ledgerText: text });
    expect(items).toHaveLength(2);
    for (const item of items) {
      expect(item.id).toMatch(/^fleet-generation-[0-9a-f]{16}$/);
      expect(item.area).toBe('fleet-generation');
      expect(item.priority).toBe(3);
      expect(item.repo).toBe(REPO);
      expect(validBacklogItem(item)).not.toBeNull();
      expect(item.prompt).toContain('generation.jsonl');
      expect(item.prompt).toContain('phm queue yield');
      expect(item.prompt).toContain('no-change');
    }
    const bet = items.find((i) => i.title.includes('autofill:bet'))!;
    expect(bet.title).toContain('stopped_family');
    expect(bet.prompt).toContain('4 rejections');
    expect(bet.prompt).toContain('4 distinct UTC days');
    expect(bet.prompt).toContain('4 distinct jobs');
    // 4 rejections of 6 recorded autofill:bet decisions (4 rejected + 2 drafted).
    expect(bet.prompt).toContain('4 of 6 recorded autofill:bet decisions');
    expect(bet.prompt).toContain('bet-x-0');
    const idea = items.find((i) => i.title.includes('autofill:idea'))!;
    expect(idea.title).toContain('missing_capability');
    expect(idea.prompt).toContain('declared capabilities');
  });

  it('stays quiet below the recurring bars', async () => {
    // Three rejections: under GENERATION_CELL_MIN_EVENTS even across days.
    const few = recurringRows('autofill:bet', 'stopped_family', 3, [4, 3, 2], 'few').join('\n');
    expect(await generatorYieldBacklogItems({ repo: REPO, now: NOW, ledgerText: few })).toEqual([]);
    // Four rejections all inside one UTC day: under GENERATION_CELL_MIN_DAYS.
    const oneDay = [
      rej('same-0', 'autofill:bet', 'duplicate', at(2, 1)),
      rej('same-1', 'autofill:bet', 'duplicate', at(2, 3)),
      rej('same-2', 'autofill:bet', 'duplicate', at(2, 5)),
      rej('same-3', 'autofill:bet', 'duplicate', at(2, 7)),
    ].join('\n');
    expect(await generatorYieldBacklogItems({ repo: REPO, now: NOW, ledgerText: oneDay })).toEqual([]);
    // Drafted-only ledger: drafts never emit on their own.
    const draftsOnly = [draft('d-0', 'autofill:bet', at(1)), draft('d-1', 'autofill:idea', at(1))].join('\n');
    expect(await generatorYieldBacklogItems({ repo: REPO, now: NOW, ledgerText: draftsOnly })).toEqual([]);
  });

  it('counts replayed decisions once and preserves later observations of the same job', async () => {
    const src = 'autofill:bet';
    const first = rej('job-1', src, 'duplicate', at(4));
    const second = rej('job-1', src, 'duplicate', at(3));
    const drafted = draft('job-2', src, at(4));
    const aliasReplay = JSON.stringify({
      schema: 'queue.generation-event.v1',
      jobId: 'job-1',
      source: src,
      kind: 'rejected',
      reason: 'duplicate',
      timestamp: at(4).replace('Z', '+00:00'),
    });
    const replayed = [first, second, first, aliasReplay, second, drafted, drafted];
    const options = { repo: REPO, now: NOW };
    expect(foldGenerationRejections(replayed.join('\n'), { nowMs: NOW }))
      .toMatchObject({ rejections: 2, drafts: 1, cells: [] });
    expect(await generatorYieldBacklogItems({ ...options, ledgerText: replayed.join('\n') })).toEqual([]);

    const later = [rej('job-1', src, 'duplicate', at(2)), rej('job-1', src, 'duplicate', at(1))];
    const items = await generatorYieldBacklogItems({ ...options, ledgerText: [...replayed, ...later].join('\n') });
    expect(items).toHaveLength(1);
    expect(items[0]?.prompt).toContain('4 of 5 recorded autofill:bet decisions');
  });

  it('never emits the unknown-src catch-all and ignores malformed or out-of-window rows', async () => {
    const text = [
      // Unknown src: 10 rejections across 5 days — the catch-all never emits.
      ...recurringRows('unknown', 'stopped_family', 10, [6, 5, 4, 3, 2], 'mystery'),
      // A real recurring cell so the fold has something to prove it still works.
      ...recurringRows('autofill:bet', 'hourly_cap', 4, [4, 3, 4, 3], 'cap'),
      // Stale cell outside the window.
      ...recurringRows('autofill:idea', 'duplicate', 6, [30, 29, 28, 27], 'old'),
      // Malformed and foreign rows.
      'not json at all',
      JSON.stringify({ schema: 'other.v9', job: 'x', src: 'autofill:bet', event: 'rejected', reason: 'duplicate', ts: at(1) }),
      JSON.stringify({ job: 'no-ts', src: 'autofill:bet', event: 'rejected', reason: 'duplicate' }),
      JSON.stringify({ job: 'bad-ts', src: 'autofill:bet', event: 'rejected', reason: 'duplicate', ts: 'not-a-date' }),
      JSON.stringify({ src: 'autofill:bet', event: 'rejected', reason: 'duplicate', ts: at(1) }),
      JSON.stringify({ job: 'odd-event', src: 'autofill:bet', event: 'skipped', ts: at(1) }),
      '',
    ].join('\n');
    const items = await generatorYieldBacklogItems({ repo: REPO, now: NOW, ledgerText: text });
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toContain('hourly_cap');
    expect(items[0]!.prompt).not.toContain('mystery-0');
    expect(items[0]!.prompt).not.toContain('old-0');
    const fold = foldGenerationRejections(text, { nowMs: NOW });
    // In-window parsed decisions: 10 unknown-src + 4 cap rejections = 14
    // rejections; the 6 stale rows, torn line, missing-ts, bad-ts,
    // missing-job and odd-event rows contribute nothing.
    expect(fold.rejections).toBe(14);
  });

  it('withholds on a null or empty ledger and on another repository', async () => {
    expect(await generatorYieldBacklogItems({ repo: REPO, now: NOW, ledgerText: null })).toEqual([]);
    expect(await generatorYieldBacklogItems({ repo: REPO, now: NOW, ledgerText: '' })).toEqual([]);
    expect(await generatorYieldBacklogItems({ repo: REPO, now: NOW, ledgerText: '   \n  \n' })).toEqual([]);
    const text = recurringRows('autofill:bet', 'stopped_family', 4, [4, 3, 4, 3], 'bet-z').join('\n');
    expect(await generatorYieldBacklogItems({ repo: 'ashlrai/other-repo', now: NOW, ledgerText: text })).toEqual([]);
    // A bare repository name still matches the fleet gate but carries no owner/repo field.
    const bare = await generatorYieldBacklogItems({ repo: 'phantom', now: NOW, ledgerText: text });
    expect(bare).toHaveLength(1);
    expect(bare[0]!.repo).toBeUndefined();
  });

  it('derives stable ids so a refresh re-adds nothing', async () => {
    const text = [
      ...recurringRows('autofill:bet', 'stopped_family', 4, [4, 3, 4, 3], 'bet-s'),
      ...recurringRows('autofill:idea', 'missing_capability', 4, [4, 3, 4, 3], 'idea-s'),
    ].join('\n');
    const first = await generatorYieldBacklogItems({ repo: REPO, now: NOW, ledgerText: text });
    const second = await generatorYieldBacklogItems({ repo: REPO, now: NOW, ledgerText: text });
    expect(second.map((item) => item.id)).toEqual(first.map((item) => item.id));
    // Shifted tallies on the same cells keep the same ids — no twin items.
    const shifted = await generatorYieldBacklogItems({
      repo: REPO, now: NOW,
      ledgerText: [...recurringRows('autofill:bet', 'stopped_family', 6, [5, 4, 3, 2, 1, 1], 'bet-s'),
        ...recurringRows('autofill:idea', 'missing_capability', 5, [4, 3, 4, 3, 2], 'idea-s')].join('\n'),
    });
    expect(shifted.map((item) => item.id)).toEqual(first.map((item) => item.id));
  });

  it('honors the item cap', async () => {
    const text = [
      ...recurringRows('autofill:bet', 'stopped_family', 4, [4, 3, 4, 3], 'bet-c'),
      ...recurringRows('autofill:idea', 'missing_capability', 4, [4, 3, 4, 3], 'idea-c'),
      ...recurringRows('autofill:followup', 'duplicate', 4, [4, 3, 4, 3], 'fu-c'),
    ].join('\n');
    const limited = await generatorYieldBacklogItems({ repo: REPO, now: NOW, ledgerText: text, limit: 1 });
    expect(limited).toHaveLength(1);
    const all = await generatorYieldBacklogItems({ repo: REPO, now: NOW, ledgerText: text });
    expect(all).toHaveLength(3);
    expect(all.length).toBeLessThanOrEqual(GENERATOR_YIELD_MAX_ITEMS);
    expect(all.every((item) => validBacklogItem(item) !== null)).toBe(true);
  });

  it('reads the real ledger under a runs dir', async () => {
    mkdirSync(join(runsDir, 'metrics'), { recursive: true });
    writeFileSync(join(runsDir, 'metrics', 'generation.jsonl'), `${recurringRows('autofill:bet', 'stopped_family', 4, [4, 3, 4, 3], 'bet-r').join('\n')}\n`);
    const items = await generatorYieldBacklogItems({ repo: REPO, now: NOW });
    expect(items).toHaveLength(1);
    // A missing runs dir is unknown, never zero.
    expect(await generatorYieldBacklogItems({ repo: REPO, runsDir: join(home, 'nope'), now: NOW })).toEqual([]);
  });
});

describe('foldGenerationRejections', () => {
  it('counts windowed tallies and exposes the documented bars', () => {
    const text = [
      ...recurringRows('autofill:bet', 'stopped_family', 4, [5, 4, 3, 2], 'bet-f'),
      draft('bet-f-ok', 'autofill:bet', at(4)),
      'garbage',
    ].join('\n');
    const fold = foldGenerationRejections(text, { nowMs: NOW });
    expect(fold.rejections).toBe(4);
    expect(fold.drafts).toBe(1);
    expect(fold.tracked).toBe(1);
    expect(fold.cells).toHaveLength(1);
    const cell = fold.cells[0]!;
    expect(cell.src).toBe('autofill:bet');
    expect(cell.reason).toBe('stopped_family');
    expect(cell.events).toBe(4);
    expect(cell.days.size).toBe(4);
    expect(cell.jobs.size).toBe(4);
    expect(cell.srcDecisions).toBe(5);
    expect(GENERATION_WINDOW_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(GENERATION_CELL_MIN_EVENTS).toBe(4);
    expect(GENERATION_CELL_MIN_DAYS).toBe(2);
    expect(GENERATOR_YIELD_MAX_ITEMS).toBeGreaterThan(0);
  });

  it('accepts the field-dialect aliases the sibling folds use', () => {
    const schema = 'queue.generation-event.v1';
    const text = [
      JSON.stringify({ schema, job_id: 'alias-0', source: 'autofill:bet', kind: 'rejected', reason: 'duplicate', timestamp: at(4) }),
      JSON.stringify({ schema, id: 'alias-1', generator: 'autofill:bet', type: 'rejected', reason: 'duplicate', at: at(3) }),
      JSON.stringify({ schema, jobId: 'alias-2', src: 'autofill:bet', event: 'rejected', reason: 'duplicate', time: at(4) }),
      JSON.stringify({ schema, job: 'alias-3', src: 'autofill:bet', event: 'rejected', reason: 'duplicate', ts: at(3) }),
      // A reasonless row groups under 'unknown' — tracked, never firing alone.
      JSON.stringify({ schema, job: 'alias-4', src: 'autofill:bet', event: 'rejected', ts: at(2) }),
    ].join('\n');
    const fold = foldGenerationRejections(text, { nowMs: NOW });
    expect(fold.rejections).toBe(5);
    expect(fold.tracked).toBe(2);
    const cell = fold.cells[0]!;
    expect(cell.reason).toBe('duplicate');
    expect(cell.events).toBe(4);
    expect(cell.jobs.size).toBe(4);
  });
});

describe('discoverBacklog wiring', () => {
  const greenGh = async (args: string[]) => {
    const path = args[4] ?? '';
    if (path === 'repos/ashlrai/phantom') {
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
    }
    return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
  };

  it('appends feed items through discovery and dedupes on refresh', async () => {
    const sentinel = {
      id: 'fleet-generation-deadbeefdeadbeef',
      title: "Queue intake 'autofill:bet' keeps refusing candidates: stopped_family (4 in 7d)",
      prompt: 'Sentinel prompt naming the generation journal evidence.',
      area: 'fleet-generation',
      priority: 3 as const,
      repo: REPO,
    };
    feedMock.mockResolvedValueOnce([sentinel]);
    const first = await discoverBacklog(REPO, { gh: greenGh });
    expect(feedMock).toHaveBeenCalledWith({ repo: REPO });
    const feedItems = first.items.filter((item) => item.id === sentinel.id);
    expect(feedItems).toHaveLength(1);
    expect(first.items.every((item) => validBacklogItem(item) !== null)).toBe(true);
    expect(appendUserBacklogItems(feedItems)).toBe(1);
    feedMock.mockResolvedValueOnce([sentinel]);
    const second = await discoverBacklog(REPO, { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((item) => item.id === sentinel.id))).toBe(0);
    expect(readUserBacklogItems().filter((item) => item.id === sentinel.id)).toHaveLength(1);
  });
});
