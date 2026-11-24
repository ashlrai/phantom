import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SOURCE_YIELD_ADVERSE_MIN,
  SOURCE_YIELD_MAX_ITEMS,
  SOURCE_YIELD_WINDOW_HOURS,
  sourceYieldBacklogItems,
} from '../src/core/improve/source-yield-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import {
  appendUserBacklogItems,
  readUserBacklogItems,
  validBacklogItem,
} from '../src/core/cloud/backlog.js';

vi.mock('../src/core/improve/source-yield-backlog.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/improve/source-yield-backlog.js')>();
  return { ...actual, sourceYieldBacklogItems: vi.fn(actual.sourceYieldBacklogItems) };
});

const realFeed = (await vi.importActual<typeof import('../src/core/improve/source-yield-backlog.js')>(
  '../src/core/improve/source-yield-backlog.js',
)).sourceYieldBacklogItems;
const feedMock = vi.mocked(sourceYieldBacklogItems);

const REPO = 'ashlrai/phantom';
const NOW = Date.parse('2026-11-18T12:00:00Z');
const at = (hoursAgo: number) => new Date(NOW - hoursAgo * 3_600_000).toISOString();
const row = (fields: Record<string, unknown>) => JSON.stringify(fields);

const launch = (job: string, hoursAgo = 96, extra: Record<string, unknown> = {}) =>
  row({ event: 'launch', job, repo: 'phantom', lane: 'work', tier: 'mid', ts: at(hoursAgo), ...extra });
const finishEmpty = (job: string, hoursAgo = 90) =>
  row({ event: 'finish', job, empty: true, ts: at(hoursAgo) });
const publishPr = (job: string, hoursAgo = 80) =>
  row({ event: 'publish', job, class: 'pr', url: `https://example.invalid/pr/${job}`, ts: at(hoursAgo) });
const outcomeMerged = (job: string, hoursAgo = 70) =>
  row({ event: 'outcome', job, state: 'MERGED', ts: at(hoursAgo) });
const publishAbort = (job: string, hoursAgo = 88) =>
  row({ event: 'publish', job, class: 'abort', ts: at(hoursAgo) });

/** `count` filler launches that each finish empty — a producer with nothing to show. */
function emptyProducerLines(prefix: string, count: number, hoursAgoStart = 96): string[] {
  const lines: string[] = [];
  for (let i = 0; i < count; i++) {
    const job = `${prefix}${i}A1118${i}Q8`;
    lines.push(launch(job, hoursAgoStart - i), finishEmpty(job, hoursAgoStart - i - 6));
  }
  return lines;
}

let previousAshlrHome: string | undefined;
let previousRunsDir: string | undefined;
let home: string;

beforeEach(() => {
  feedMock.mockReset();
  feedMock.mockImplementation(realFeed);
  previousAshlrHome = process.env.ASHLR_HOME;
  previousRunsDir = process.env.ASHLR_RUNS_DIR;
  home = mkdtempSync(join(tmpdir(), 'ashlr-source-yield-backlog-'));
  process.env.ASHLR_HOME = home;
  delete process.env.ASHLR_RUNS_DIR;
});

afterEach(() => {
  if (previousAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = previousAshlrHome;
  if (previousRunsDir === undefined) delete process.env.ASHLR_RUNS_DIR;
  else process.env.ASHLR_RUNS_DIR = previousRunsDir;
  rmSync(home, { recursive: true, force: true });
});

describe('sourceYieldBacklogItems', () => {
  it('emits one valid item per recurring no-land producer', async () => {
    const items = await sourceYieldBacklogItems({
      repo: REPO,
      now: NOW,
      jobsText: emptyProducerLines('RQ-MD', 6).join('\n'),
      queueText: '',
    });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item.id).toMatch(/^fleet-source-yield-[0-9a-f]{16}$/);
    expect(item.title).toContain('filler');
    expect(item.area).toBe('source-yield');
    expect(item.priority).toBe(3);
    expect(item.repo).toBe(REPO);
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item.prompt).toContain('6 launches');
    expect(item.prompt).toContain('0 merge');
    expect(item.prompt).toContain('6 empty');
    expect(item.prompt).toContain('jobs.yield-by.v1');
    expect(item.prompt).toContain('phm jobs yield --by source');
    expect(item.prompt).toContain('queue/router-queue.md');
    expect(item.prompt).toContain('no-change');
  });

  it('attributes launches through the queue src= tag when the id prefix says other', async () => {
    const lines = [
      ...Array.from({ length: 6 }, (_, i) => [
        launch(`RQ-DVL-BUS-${1795099400 + i}`, 96 - i),
        finishEmpty(`RQ-DVL-BUS-${1795099400 + i}`, 90 - i),
      ]).flat(),
    ];
    const queue = Array.from({ length: 6 }, (_, i) =>
      `- READY RQ-DVL-BUS-${1795099400 + i} (P1, pool=work, src=leader): do the thing`).join('\n');
    const items = await sourceYieldBacklogItems({ repo: REPO, now: NOW, jobsText: lines.join('\n'), queueText: queue });
    // No launch-row tag and an 'other' id prefix: only the queue src=leader join attributes these.
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toContain('leader');
    // Without the queue the same ledger is all 'other' — a catch-all that never emits.
    expect(await sourceYieldBacklogItems({ repo: REPO, now: NOW, jobsText: lines.join('\n'), queueText: null })).toEqual([]);
  });

  it('stays quiet below the judging and recurring bars', async () => {
    // Fewer than JOB_STOP_MIN_LAUNCHES launches.
    expect(await sourceYieldBacklogItems({
      repo: REPO, now: NOW, jobsText: emptyProducerLines('RQ-MD', 5).join('\n'), queueText: '',
    })).toEqual([]);
    // Enough launches but too few recorded empty/aborted verdicts (the rest still in flight).
    const inFlight = Array.from({ length: 6 }, (_, i) => launch(`RQ-MD9A1118${i}Q8`, 96 - i)).join('\n');
    expect(await sourceYieldBacklogItems({ repo: REPO, now: NOW, jobsText: inFlight, queueText: '' })).toEqual([]);
    // Enough launches and verdicts but merges landed — yield is not bottoming out.
    const landing = Array.from({ length: 6 }, (_, i) => {
      const job = `RQ-MD8A1118${i}Q8`;
      return [launch(job, 96 - i), publishPr(job, 80 - i), outcomeMerged(job, 70 - i)].join('\n');
    }).join('\n');
    const mergedItems = await sourceYieldBacklogItems({ repo: REPO, now: NOW, jobsText: landing, queueText: '' });
    expect(mergedItems).toEqual([]);
    // A mixed producer: some merges keep merged-per-launch under the stop bar only when merges are rare.
    const mostlyEmpty = [
      ...Array.from({ length: 5 }, (_, i) => {
        const job = `RQ-MD7A1118${i}Q8`;
        return [launch(job, 96 - i), finishEmpty(job, 92 - i)].join('\n');
      }),
      ...Array.from({ length: 15 }, (_, i) => {
        const job = `RQ-MD6A1118${i}Q8`;
        return [launch(job, 90 - i), publishPr(job, 80 - i), outcomeMerged(job, 70 - i)].join('\n');
      }),
    ].join('\n');
    // 20 launches, 15 merges → merged_per_launch 0.75, healthy; nothing emits.
    expect(await sourceYieldBacklogItems({ repo: REPO, now: NOW, jobsText: mostlyEmpty, queueText: '' })).toEqual([]);
  });

  it('withholds on a null ledger and on another repository', async () => {
    expect(await sourceYieldBacklogItems({ repo: REPO, now: NOW, jobsText: null, queueText: '' })).toEqual([]);
    expect(await sourceYieldBacklogItems({ repo: REPO, now: NOW, jobsText: '', queueText: '' })).toEqual([]);
    const jobs = emptyProducerLines('RQ-MD', 6).join('\n');
    expect(await sourceYieldBacklogItems({ repo: 'ashlrai/other-repo', now: NOW, jobsText: jobs, queueText: '' })).toEqual([]);
    // A bare repository name still matches the fleet gate but carries no owner/repo field.
    const bare = await sourceYieldBacklogItems({ repo: 'phantom', now: NOW, jobsText: jobs, queueText: '' });
    expect(bare).toHaveLength(1);
    expect(bare[0]!.repo).toBeUndefined();
  });

  it('never emits for the other catch-all source', async () => {
    // RQ-DVL ids classify as 'other' — a catch-all, not a producer.
    const jobs = Array.from({ length: 8 }, (_, i) => {
      const job = `RQ-DVL-BUS-${1795099400 + i}`;
      return [launch(job, 96 - i), finishEmpty(job, 92 - i)].join('\n');
    }).join('\n');
    expect(await sourceYieldBacklogItems({ repo: REPO, now: NOW, jobsText: jobs, queueText: '' })).toEqual([]);
  });

  it('derives stable ids so a refresh re-adds nothing', async () => {
    const jobs = emptyProducerLines('RQ-MD', 6).join('\n');
    const first = await sourceYieldBacklogItems({ repo: REPO, now: NOW, jobsText: jobs, queueText: '' });
    const second = await sourceYieldBacklogItems({ repo: REPO, now: NOW, jobsText: jobs, queueText: '' });
    expect(second.map((item) => item.id)).toEqual(first.map((item) => item.id));
    // Shifted tallies on the same source keep the same id — no twin items.
    const shifted = await sourceYieldBacklogItems({
      repo: REPO, now: NOW, jobsText: emptyProducerLines('RQ-MD', 7).join('\n'), queueText: '',
    });
    expect(shifted.map((item) => item.id)).toEqual(first.map((item) => item.id));
  });

  it('emits per source and honors the item cap', async () => {
    const filler = emptyProducerLines('RQ-MD', 6, 96);
    const leader = Array.from({ length: 6 }, (_, i) => {
      const job = `RQ-BETYIELDN2${i}GQ8`;
      return [launch(job, 90 - i, { src: 'leader' }), publishAbort(job, 86 - i)].join('\n');
    }).join('\n');
    const items = await sourceYieldBacklogItems({
      repo: REPO, now: NOW, jobsText: `${filler.join('\n')}\n${leader}`, queueText: '', limit: 1,
    });
    expect(items).toHaveLength(1);
    const both = await sourceYieldBacklogItems({ repo: REPO, now: NOW, jobsText: `${filler.join('\n')}\n${leader}`, queueText: '' });
    expect(both.length).toBeGreaterThanOrEqual(2);
    expect(both.every((item) => validBacklogItem(item) !== null)).toBe(true);
    expect(new Set(both.map((item) => item.id)).size).toBe(both.length);
  });

  it('reads the real ledgers under a runs dir', async () => {
    const runsDir = join(home, 'runs');
    mkdirSync(join(runsDir, 'metrics'), { recursive: true });
    mkdirSync(join(runsDir, 'queue'), { recursive: true });
    writeFileSync(join(runsDir, 'metrics', 'jobs.jsonl'), `${emptyProducerLines('RQ-MD', 6).join('\n')}\n`);
    writeFileSync(join(runsDir, 'queue', 'router-queue.md'), '- READY RQ-MD0A11180Q8 (P1, pool=work, src=filler): x\n');
    const items = await sourceYieldBacklogItems({ repo: REPO, runsDir, now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toContain('filler');
    // A missing ledger is unknown, never zero.
    expect(await sourceYieldBacklogItems({ repo: REPO, runsDir: join(home, 'nope'), now: NOW })).toEqual([]);
  });
});

describe('sourceYieldBacklogItems constants', () => {
  it('exposes the documented window, bars and item bounds', () => {
    expect(SOURCE_YIELD_WINDOW_HOURS).toBe(24 * 7);
    expect(SOURCE_YIELD_ADVERSE_MIN).toBe(3);
    expect(SOURCE_YIELD_MAX_ITEMS).toBeGreaterThan(0);
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
      id: 'fleet-source-yield-deadbeefdeadbeef',
      title: "Job producer 'sentinel' keeps launching work that never merges",
      prompt: 'Sentinel prompt naming the producer-yield evidence.',
      area: 'source-yield',
      priority: 3 as const,
      repo: REPO,
    };
    feedMock.mockResolvedValueOnce([sentinel]);
    const first = await discoverBacklog(REPO, { gh: greenGh });
    expect(feedMock).toHaveBeenCalledWith({ repo: REPO });
    const yieldItems = first.items.filter((item) => item.id === sentinel.id);
    expect(yieldItems).toHaveLength(1);
    expect(first.items.every((item) => validBacklogItem(item) !== null)).toBe(true);
    expect(appendUserBacklogItems(yieldItems)).toBe(1);
    feedMock.mockResolvedValueOnce([sentinel]);
    const second = await discoverBacklog(REPO, { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((item) => item.id === sentinel.id))).toBe(0);
    expect(readUserBacklogItems().filter((item) => item.id === sentinel.id)).toHaveLength(1);
  });
});
