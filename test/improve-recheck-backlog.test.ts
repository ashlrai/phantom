import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  foldRecheckCells,
  RECHECK_MAX_ITEMS,
  RECHECK_RECURRING,
  RECHECK_WINDOW_MS,
  recheckBacklogItems,
} from '../src/core/improve/recheck-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import {
  appendUserBacklogItems,
  readUserBacklogItems,
  validBacklogItem,
} from '../src/core/cloud/backlog.js';

vi.mock('../src/core/improve/recheck-backlog.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/improve/recheck-backlog.js')>();
  return { ...actual, recheckBacklogItems: vi.fn(actual.recheckBacklogItems) };
});

const realFeed = (await vi.importActual<typeof import('../src/core/improve/recheck-backlog.js')>(
  '../src/core/improve/recheck-backlog.js',
)).recheckBacklogItems;
const feedMock = vi.mocked(recheckBacklogItems);

const REPO = 'ashlrai/phantom';
const NOW = Date.parse('2026-11-23T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();
const row = (fields: Record<string, unknown>) => JSON.stringify(fields);

const SECTION_STATES = { runtime: 'VERIFIED', claims: 'VERIFIED', bridge: 'VERIFIED', task: 'VERIFIED' } as const;

/** One verdict row in the writer's fleet.recheck-record.v1 shape. */
function verdict(overall: string, asOf: string, opts: {
  sections?: Partial<Record<keyof typeof SECTION_STATES, string>>;
  missing?: Partial<Record<'runtime' | 'claims' | 'bridge' | 'task', string[]>>;
  extraSections?: Record<string, unknown>;
} = {}): string {
  const states = { ...SECTION_STATES, ...(opts.sections ?? {}) };
  const sectionEntry = (name: keyof typeof SECTION_STATES) => ({
    state: states[name],
    ...(name === 'runtime' ? { host: 'test-host', installedVersion: '1.0.0' } : {}),
    ...(name === 'claims' ? { active: 0 } : {}),
    ...(name === 'bridge' ? { missingBridge: null } : {}),
    ...(name === 'task' ? { id: null, owner: null, claimReceipt: null } : {}),
    asOf,
  });
  return row({
    schema: 'fleet.recheck-record.v1',
    asOf,
    overall,
    sections: {
      runtime: sectionEntry('runtime'),
      claims: sectionEntry('claims'),
      bridge: sectionEntry('bridge'),
      task: sectionEntry('task'),
      missing: {
        overall: [],
        runtime: opts.missing?.runtime ?? [],
        claims: opts.missing?.claims ?? [],
        bridge: opts.missing?.bridge ?? [],
        task: opts.missing?.task ?? [],
      },
      ...(opts.extraSections ?? {}),
    },
  });
}

/** `count` rows all reporting the same non-clean section state. */
function recurringSectionRows(section: 'runtime' | 'claims' | 'bridge' | 'task', state: string, count: number, hoursStart = 96): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const at = hoursAgo(hoursStart - i * 12);
    out.push(verdict(state, at, { sections: { [section]: state } }));
  }
  return out;
}

let previousAshlrHome: string | undefined;
let home: string;

beforeEach(() => {
  feedMock.mockReset();
  feedMock.mockImplementation(realFeed);
  previousAshlrHome = process.env.ASHLR_HOME;
  home = mkdtempSync(join(tmpdir(), 'ashlr-recheck-backlog-'));
  process.env.ASHLR_HOME = home;
});

afterEach(() => {
  if (previousAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = previousAshlrHome;
  rmSync(home, { recursive: true, force: true });
});

describe('recheckBacklogItems', () => {
  it('emits one valid item per recurring non-clean cell', async () => {
    const logText = [
      ...recurringSectionRows('claims', 'UNKNOWN', 4),
      verdict('BLOCKED', hoursAgo(90), { sections: { task: 'BLOCKED' }, missing: { task: ['task: 2 candidate(s) lack a named owner'] } }),
      verdict('BLOCKED', hoursAgo(84), { sections: { task: 'BLOCKED' }, missing: { task: ['task: 5 candidate(s) lack a named owner'] } }),
      verdict('BLOCKED', hoursAgo(78), { sections: { task: 'BLOCKED' }, missing: { task: ['task: 1 candidate(s) lack a named owner'] } }),
    ].join('\n');
    const items = await recheckBacklogItems({ repo: REPO, now: NOW, logText });
    expect(items.length).toBeGreaterThanOrEqual(3);
    for (const item of items) {
      expect(item.id).toMatch(/^fleet-recheck-[0-9a-f]{16}$/);
      expect(item.area).toBe('fleet-recheck');
      expect(item.priority).toBe(3);
      expect(item.repo).toBe(REPO);
      expect(validBacklogItem(item)).not.toBeNull();
      expect(item.prompt).toContain('recheck-log.jsonl');
      expect(item.prompt).toContain('phm fleet recheck-record');
      expect(item.prompt).toContain('no-change');
    }
    const titles = items.map((i) => i.title).join(' | ');
    expect(titles).toContain('claims');
    expect(titles).toContain('task');
    // Digit normalization groups the count-carrying reason into one cell.
    const reasonItems = items.filter((i) => i.title.includes('missing reason'));
    expect(reasonItems).toHaveLength(1);
    expect(reasonItems[0]!.title).toContain('candidate(s) lack a named owner');
  });

  it('stays quiet below the recurring bar and on clean verdicts', async () => {
    // Two non-clean rows: under RECHECK_RECURRING.
    const two = [
      verdict('UNKNOWN', hoursAgo(90), { sections: { claims: 'UNKNOWN' } }),
      verdict('UNKNOWN', hoursAgo(84), { sections: { claims: 'UNKNOWN' } }),
    ].join('\n');
    expect(await recheckBacklogItems({ repo: REPO, now: NOW, logText: two })).toEqual([]);
    // Three clean rows never emit.
    const clean = [verdict('VERIFIED', hoursAgo(90)), verdict('VERIFIED', hoursAgo(84)), verdict('VERIFIED', hoursAgo(78))].join('\n');
    expect(await recheckBacklogItems({ repo: REPO, now: NOW, logText: clean })).toEqual([]);
    // A single recurring reason among clean verdicts still emits on its own cell.
    const reasonOnly = [
      verdict('VERIFIED', hoursAgo(90), { missing: { task: ['task: work board inbox degraded'] } }),
      verdict('VERIFIED', hoursAgo(84), { missing: { task: ['task: work board inbox degraded'] } }),
      verdict('VERIFIED', hoursAgo(78), { missing: { task: ['task: work board inbox degraded'] } }),
    ].join('\n');
    const reasonItems = await recheckBacklogItems({ repo: REPO, now: NOW, logText: reasonOnly });
    expect(reasonItems).toHaveLength(1);
    expect(reasonItems[0]!.title).toContain('work board inbox degraded');
  });

  it('ignores rows outside the window, malformed lines and unverifiable shapes', async () => {
    const stale = recurringSectionRows('bridge', 'BLOCKED', 4, 24 * 30);
    const fresh = recurringSectionRows('bridge', 'BLOCKED', 3, 48);
    const mixed = [
      ...stale,
      ...fresh,
      'not json at all',
      row({ schema: 'other.v9', asOf: hoursAgo(1), overall: 'BLOCKED' }),
      verdict('UNKNOWN', 'not-a-date', { sections: { task: 'UNKNOWN' } }),
      verdict('UNKNOWN', hoursAgo(200), { sections: { task: 'UNKNOWN' } }), // 200h ago sits outside the 7-day window
      '',
    ].join('\n');
    const items = await recheckBacklogItems({ repo: REPO, now: NOW, logText: mixed });
    // Only the 3 fresh BLOCKED rows count; stale rows fell outside the window.
    const sectionItems = items.filter((i) => i.title.includes('bridge'));
    expect(sectionItems.length).toBeGreaterThanOrEqual(1);
    expect(sectionItems[0]!.prompt).toContain('3 recorded');
  });

  it('withholds on a null log and on another repository', async () => {
    expect(await recheckBacklogItems({ repo: REPO, now: NOW, logText: null })).toEqual([]);
    expect(await recheckBacklogItems({ repo: REPO, now: NOW, logText: '' })).toEqual([]);
    const logText = recurringSectionRows('claims', 'UNKNOWN', 4).join('\n');
    expect(await recheckBacklogItems({ repo: 'ashlrai/other-repo', now: NOW, logText })).toEqual([]);
    // A bare repository name still matches the fleet gate but carries no owner/repo field.
    // The rows carry overall UNKNOWN too, so the verdict and section cells both emit.
    const bare = await recheckBacklogItems({ repo: 'phantom', now: NOW, logText });
    expect(bare.length).toBeGreaterThanOrEqual(1);
    expect(bare.every((item) => item.repo === undefined)).toBe(true);
  });

  it('derives stable ids so a refresh re-adds nothing', async () => {
    const logText = recurringSectionRows('claims', 'UNKNOWN', 4).join('\n');
    const first = await recheckBacklogItems({ repo: REPO, now: NOW, logText });
    const second = await recheckBacklogItems({ repo: REPO, now: NOW, logText });
    expect(second.map((item) => item.id)).toEqual(first.map((item) => item.id));
    // Shifted tallies on the same cells keep the same ids — no twin items.
    const shifted = await recheckBacklogItems({
      repo: REPO, now: NOW, logText: recurringSectionRows('claims', 'UNKNOWN', 5).join('\n'),
    });
    expect(shifted.map((item) => item.id)).toEqual(first.map((item) => item.id));
  });

  it('honors the item cap and emits per cell', async () => {
    const logText = [
      ...recurringSectionRows('runtime', 'UNKNOWN', 3, 96),
      ...recurringSectionRows('claims', 'BLOCKED', 3, 90),
      ...recurringSectionRows('bridge', 'UNKNOWN', 3, 84),
      ...recurringSectionRows('task', 'BLOCKED', 3, 78),
    ].join('\n');
    const limited = await recheckBacklogItems({ repo: REPO, now: NOW, logText, limit: 2 });
    expect(limited).toHaveLength(2);
    const all = await recheckBacklogItems({ repo: REPO, now: NOW, logText });
    expect(all.length).toBeGreaterThanOrEqual(4);
    expect(all.length).toBeLessThanOrEqual(RECHECK_MAX_ITEMS);
    expect(new Set(all.map((item) => item.id)).size).toBe(all.length);
    expect(all.every((item) => validBacklogItem(item) !== null)).toBe(true);
  });

  it('reads the real log under an ashlr home', async () => {
    const fleetDir = join(home, 'fleet');
    mkdirSync(fleetDir, { recursive: true });
    writeFileSync(join(fleetDir, 'recheck-log.jsonl'), `${recurringSectionRows('claims', 'UNKNOWN', 4).join('\n')}\n`);
    const items = await recheckBacklogItems({ repo: REPO, rootDir: home, now: NOW });
    // Overall UNKNOWN rides along with the section state, so both cells emit.
    expect(items.length).toBeGreaterThanOrEqual(1);
    expect(items.some((item) => item.title.includes('claims'))).toBe(true);
    // A missing log is unknown, never zero.
    expect(await recheckBacklogItems({ repo: REPO, rootDir: join(home, 'nope'), now: NOW })).toEqual([]);
  });
});

describe('foldRecheckCells', () => {
  it('counts verdict, section and reason cells inside the window only', () => {
    const text = [
      verdict('BLOCKED', hoursAgo(10), { sections: { task: 'BLOCKED' }, missing: { task: ['task: 1 candidate(s) lack a claim receipt'] } }),
      verdict('BLOCKED', hoursAgo(20), { sections: { task: 'BLOCKED' }, missing: { task: ['task: 9 candidate(s) lack a claim receipt'] } }),
      verdict('BLOCKED', hoursAgo(30), { sections: { task: 'BLOCKED' }, missing: { task: ['task: 4 candidate(s) lack a claim receipt'] } }),
      verdict('VERIFIED', hoursAgo(40)),
      'garbage line',
    ].join('\n');
    const fold = foldRecheckCells(text, { nowMs: NOW });
    expect(fold.rows).toBe(4);
    expect(fold.invalidRows).toBe(1);
    const keys = fold.cells.map((c) => c.key);
    expect(keys).toContain('verdict:BLOCKED');
    expect(keys).toContain('section:task:BLOCKED');
    expect(keys).toContain('reason:task: # candidate(s) lack a claim receipt');
    // Ordering: highest count first — all three cells have count 3 here.
    expect(fold.cells.every((c) => c.count === 3)).toBe(true);
  });

  it('exposes the documented bars', () => {
    expect(RECHECK_WINDOW_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(RECHECK_RECURRING).toBe(3);
    expect(RECHECK_MAX_ITEMS).toBeGreaterThan(0);
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
      id: 'fleet-recheck-deadbeefdeadbeef',
      title: 'Fleet recheck keeps reporting an overall BLOCKED verdict',
      prompt: 'Sentinel prompt naming the recheck verdict evidence.',
      area: 'fleet-recheck',
      priority: 3 as const,
      repo: REPO,
    };
    feedMock.mockResolvedValueOnce([sentinel]);
    const first = await discoverBacklog(REPO, { gh: greenGh });
    expect(feedMock).toHaveBeenCalledWith({ repo: REPO });
    const recheckItems = first.items.filter((item) => item.id === sentinel.id);
    expect(recheckItems).toHaveLength(1);
    expect(first.items.every((item) => validBacklogItem(item) !== null)).toBe(true);
    expect(appendUserBacklogItems(recheckItems)).toBe(1);
    feedMock.mockResolvedValueOnce([sentinel]);
    const second = await discoverBacklog(REPO, { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((item) => item.id === sentinel.id))).toBe(0);
    expect(readUserBacklogItems().filter((item) => item.id === sentinel.id)).toHaveLength(1);
  });
});
