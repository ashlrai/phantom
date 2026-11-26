import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  foldGitContentionCells,
  GIT_CONTENTION_MIN_DAYS,
  GIT_CONTENTION_MIN_UNITS,
  gitContentionBacklogItems,
  parseGitContentionRows,
  type GitOperationRecord,
} from '../src/core/improve/git-contention-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const J = (o: Record<string, unknown>): string => JSON.stringify(o);
const op = (
  operation: GitOperationRecord['operation'],
  atMs: number,
  extra: Partial<GitOperationRecord> = {},
): GitOperationRecord => ({
  machine: 'mac-a', lane: 'work', operation, atMs,
  utcDay: new Date(atMs).toISOString().slice(0, 10),
  failed: null, retries: null, ...extra,
});

describe('parseGitContentionRows', () => {
  const NOW = Date.parse('2026-11-23T12:00:00.000Z');
  const CUTOFF = NOW - 7 * DAY;
  const TS = '2026-11-23T10:00:00.000Z';

  it('keeps only writer-contract git_operation rows inside the window', () => {
    const rows = [
      J({ event: 'git_operation', machine: 'mac-a', lane: 'work', ts: TS, operation: 'index.lock', failed: true }),
      J({ event: 'git_operation', machine: 'mac-a', lane: 'work', ts: TS, operation: 'fetch', elapsed_ms: 900, retries: 0 }),
      J({ event: 'git_operation', machine: 'mac-a', lane: 'work', timestamp: TS, operation: 'push', elapsed_ms: 200, retries: 2 }),
      J({ type: 'git_operation', machine: 'mac-b', lane: 'router', ts: TS, operation: 'worktree_add', elapsed_ms: 5000 }),
      J({ event: 'git_operation', machine: 'mac-a', lane: 'work', ts: TS, operation: 'rebase' }), // off-vocabulary
      J({ event: 'git_operation', machine: '', lane: 'work', ts: TS, operation: 'fetch' }), // empty machine
      J({ event: 'git_operation', machine: 'mac-a', ts: TS, operation: 'fetch' }), // missing lane
      J({ event: 'git_operation', machine: 'mac-a', lane: 'work', operation: 'fetch' }), // no timestamp
      J({ event: 'git_operation', machine: 'mac-a', lane: 'work', ts: '2026-11-10T10:00:00.000Z', operation: 'fetch' }), // outside window
      J({ event: 'git_operation', machine: 'mac-a', lane: 'work', ts: '2026-11-24T10:00:00.000Z', operation: 'fetch' }), // future
      J({ event: 'launch', job: 'RQ-1', ts: TS }), // not a git row
      'not json at all', '',
    ].join('\n');
    const parsed = parseGitContentionRows(rows, CUTOFF, NOW);
    expect(parsed).toHaveLength(4);
    expect(parsed.map((r) => r.operation)).toEqual(['index.lock', 'fetch', 'push', 'worktree_add']);
    expect(parsed[0]).toMatchObject({ machine: 'mac-a', lane: 'work', failed: true, atMs: Date.parse(TS) });
    expect(parsed[1]).toMatchObject({ retries: 0 });
    expect(parsed[2]).toMatchObject({ machine: 'mac-a', retries: 2, atMs: Date.parse(TS) }); // timestamp dialect accepted
    expect(parsed[3]).toMatchObject({ machine: 'mac-b', lane: 'router' });
  });

  it('drops malformed field shapes instead of guessing', () => {
    const rows = [
      J({ event: 'git_operation', machine: 'mac-a', lane: 'work', ts: TS, operation: 'fetch', retries: 'lots' }),
      J({ event: 'git_operation', machine: 'mac-a', lane: 'work', ts: TS, operation: 'index.lock', failed: 'yes' }),
      J({ event: 'git_operation', machine: 'mac-a', lane: 'work', ts: TS, operation: 'push', retries: 1.5 }),
      'null', '[]', '42',
    ].join('\n');
    const parsed = parseGitContentionRows(rows, CUTOFF, NOW);
    expect(parsed).toHaveLength(3);
    expect(parsed[0]).toMatchObject({ operation: 'fetch', retries: null });
    expect(parsed[1]).toMatchObject({ operation: 'index.lock', failed: null });
    expect(parsed[2]).toMatchObject({ operation: 'push', retries: null });
  });
});

describe('foldGitContentionCells', () => {
  const T0 = Date.parse('2026-11-20T08:00:00.000Z');
  const T1 = Date.parse('2026-11-21T08:00:00.000Z');

  it('counts index.lock rows only on a recorded failure, fetch/push only on recorded positive retries', () => {
    const cells = foldGitContentionCells([
      op('index.lock', T0, { failed: true, machine: 'mac-a', lane: 'work' }),
      op('index.lock', T0 + MIN, { failed: true, machine: 'mac-a', lane: 'work' }),
      op('index.lock', T1, { failed: true, machine: 'mac-b', lane: 'safe-git' }),
      op('index.lock', T1, { failed: false, machine: 'mac-a', lane: 'work' }), // not a recorded failure
      op('index.lock', T1, { machine: 'mac-a', lane: 'work' }), // failed unrecorded — unknown, not adverse
      op('fetch', T0, { retries: 2, machine: 'mac-a', lane: 'work' }),
      op('fetch', T0 + MIN, { retries: 0, machine: 'mac-a', lane: 'work' }), // clean
      op('fetch', T1, { machine: 'mac-b', lane: 'router' }), // retries unrecorded
      op('push', T0, { retries: 1, machine: 'mac-a', lane: 'work' }),
      op('push', T1, { retries: 3, machine: 'mac-b', lane: 'inbox' }),
      op('push', T1, { retries: 0, machine: 'mac-a', lane: 'work' }),
      op('worktree_add', T0, { machine: 'mac-a', lane: 'worktree-reaper' }),
      op('worktree_remove', T1, { machine: 'mac-a', lane: 'worktree-reaper' }),
    ]);
    const byKind = new Map(cells.map((c) => [c.kind, c]));
    expect([...byKind.keys()].sort()).toEqual(['fetch', 'index.lock', 'push']);
    const lock = byKind.get('index.lock')!;
    expect(lock).toMatchObject({ rows: 3, days: 2, machines: 2, retries: null, lowerBound: false });
    expect(lock.lanes).toEqual([{ text: 'work', count: 2 }, { text: 'safe-git', count: 1 }]);
    expect(lock.firstSeen).toBe(new Date(T0).toISOString());
    expect(lock.lastSeen).toBe(new Date(T1).toISOString());
    expect(byKind.get('fetch')).toMatchObject({ rows: 1, days: 1, retries: 2 }); // retries summed across the op's rows
    expect(byKind.get('push')).toMatchObject({ rows: 2, days: 2, retries: 4 });
  });

  it('sanitizes lane text, counts machines without naming them, and marks truncation', () => {
    const dirtyLane = `lane\n${'l'.repeat(120)}`;
    const cells = foldGitContentionCells([
      op('index.lock', T0, { failed: true, machine: `mac-${'x'.repeat(200)}`, lane: dirtyLane }),
      op('index.lock', T0 + MIN, { failed: true, machine: 'mac-b', lane: dirtyLane }),
      op('index.lock', T1, { failed: true, machine: 'mac-b', lane: dirtyLane }),
    ], true);
    expect(cells).toHaveLength(1);
    const cell = cells[0]!;
    expect(cell.lowerBound).toBe(true);
    expect(cell.machines).toBe(2);
    expect(cell.lanes[0]!.text.length).toBeLessThanOrEqual(80);
    expect(cell.lanes[0]!.text).not.toContain('\n');
    expect(JSON.stringify(cell)).not.toContain('mac-x');
  });
});

describe('gitContentionBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };
  const NOW = Date.now();
  const DAY1 = new Date(NOW - 2 * DAY).toISOString();
  const DAY2 = new Date(NOW - DAY).toISOString();

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'git-contention-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  /** A runs dir: an optional metrics/jobs.jsonl ledger. */
  async function runsDir(name: string, ledger?: string[]): Promise<string> {
    const dir = join(home, name);
    await mkdir(join(dir, 'metrics'), { recursive: true });
    if (ledger !== undefined) await writeFile(join(dir, 'metrics', 'jobs.jsonl'), ledger.join('\n') + '\n');
    return dir;
  }
  const gitRow = (operation: string, ts: string, extra: Record<string, unknown> = {}): string =>
    J({ event: 'git_operation', machine: 'mac-a', lane: 'work', ts, operation, ...extra });
  const lockRow = (ts: string, extra: Record<string, unknown> = {}): string =>
    gitRow('index.lock', ts, { failed: true, ...extra });

  it('emits an index.lock item for a recurring cell and validates it', async () => {
    const dir = await runsDir('runs-lock', [
      lockRow(DAY1), lockRow(DAY1, { lane: 'safe-git' }), lockRow(DAY2, { machine: 'mac-b' }),
      gitRow('fetch', DAY2, { elapsed_ms: 900, retries: 0 }),
      gitRow('worktree_add', DAY2, { elapsed_ms: 4000 }),
    ]);
    const items = await gitContentionBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom', area: 'git-contention' });
    expect(item!.id).toMatch(/^fleet-git-index\.lock-[0-9a-f]{16}$/);
    expect(item!.title).toContain('index.lock');
    expect(validBacklogItem(item)).not.toBeNull();
    for (const s of [
      'index.lock', '3 recorded index.lock failure row(s)', '2 distinct UTC day(s)',
      '2 fleet host(s)', "'work' ×2", 'job-latency', 'no-change',
    ]) expect(item!.prompt).toContain(s);
    // Hostnames are counted, never printed.
    expect(item!.prompt).not.toContain('mac-a');
    expect(item!.prompt).not.toContain('mac-b');
  });

  it('emits fetch and push cells only on recorded positive retries', async () => {
    const dir = await runsDir('runs-retries', [
      gitRow('fetch', DAY1, { elapsed_ms: 900, retries: 2 }),
      gitRow('fetch', DAY1, { elapsed_ms: 950, retries: 1 }),
      gitRow('fetch', DAY2, { elapsed_ms: 1000, retries: 1 }),
      gitRow('fetch', DAY2, { elapsed_ms: 800, retries: 0 }),
      gitRow('push', DAY1, { elapsed_ms: 300, retries: 4 }),
      gitRow('push', DAY2, { elapsed_ms: 250, retries: 1 }),
      gitRow('push', DAY2, { elapsed_ms: 260, retries: 2 }),
      gitRow('push', DAY2, { elapsed_ms: 270, retries: 0 }),
    ]);
    const items = await gitContentionBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) });
    expect(items.map((i) => i.id)).toEqual([
      expect.stringMatching(/^fleet-git-fetch-/),
      expect.stringMatching(/^fleet-git-push-/),
    ]);
    const fetch = items.find((i) => i.id.includes('fetch'))!;
    expect(fetch.title).toContain('fetch');
    expect(fetch.prompt).toContain('4 retries recorded'); // 2 + 1 + 1 + 0 across the op's rows
    const push = items.find((i) => i.id.includes('push'))!;
    expect(push.prompt).toContain('7 retries recorded'); // 4 + 1 + 2 + 0
  });

  it('emits nothing below the recurring bars of rows and days', async () => {
    // Three adverse rows but all on one UTC day — under the days bar.
    const sameDay = await runsDir('runs-sameday', [
      lockRow('2026-11-20T01:00:00.000Z'), lockRow('2026-11-20T02:00:00.000Z'), lockRow('2026-11-20T03:00:00.000Z'),
    ]);
    const pinnedNow = new Date('2026-11-23T12:00:00.000Z');
    expect(await gitContentionBacklogItems({ repo: 'ashlrai/phantom', runsDir: sameDay, now: pinnedNow })).toEqual([]);
    // Rows across two days but under the units bar.
    const thin = await runsDir('runs-thin', [lockRow(DAY1), lockRow(DAY2)]);
    expect(await gitContentionBacklogItems({ repo: 'ashlrai/phantom', runsDir: thin, now: new Date(NOW) })).toEqual([]);
    expect(GIT_CONTENTION_MIN_UNITS).toBe(3);
    expect(GIT_CONTENTION_MIN_DAYS).toBe(2);
  });

  it('emits nothing for clean observations, missing ledgers, or another repository', async () => {
    const clean = await runsDir('runs-clean', [
      gitRow('index.lock', DAY1, { failed: false }),
      gitRow('index.lock', DAY2, { failed: false }),
      gitRow('index.lock', DAY2), // failed unrecorded — unknown stays unknown
      gitRow('fetch', DAY1, { elapsed_ms: 900, retries: 0 }),
      gitRow('fetch', DAY2, { elapsed_ms: 1000, retries: 0 }),
      gitRow('worktree_add', DAY1, { elapsed_ms: 9000 }),
      gitRow('worktree_remove', DAY2, { elapsed_ms: 8000 }),
    ]);
    expect(await gitContentionBacklogItems({ repo: 'ashlrai/phantom', runsDir: clean, now: new Date(NOW) })).toEqual([]);
    expect(await gitContentionBacklogItems({ repo: 'ashlrai/phantom', runsDir: join(home, 'no-such'), now: new Date(NOW) })).toEqual([]);
    const empty = await runsDir('runs-empty', []);
    expect(await gitContentionBacklogItems({ repo: 'ashlrai/phantom', runsDir: empty, now: new Date(NOW) })).toEqual([]);

    const dir = await runsDir('runs-repo', [lockRow(DAY1), lockRow(DAY2), lockRow(DAY2)]);
    expect(await gitContentionBacklogItems({ repo: 'ashlrai/other', runsDir: dir, now: new Date(NOW) })).toEqual([]);
    expect(await gitContentionBacklogItems({ repo: 'AshlrAI/Phantom', runsDir: dir, now: new Date(NOW) })).toHaveLength(1);
  });

  it('states truncation as a lower bound in the prompt', async () => {
    const dir = await runsDir('runs-trunc', [lockRow(DAY1), lockRow(DAY2), lockRow(DAY2)]);
    // Pad the ledger past the 16 MiB tail bound so the read reports truncated.
    const pad = 'x'.repeat(17 * 1024 * 1024);
    await writeFile(join(dir, 'metrics', 'jobs.jsonl'), pad + '\n' + [lockRow(DAY1), lockRow(DAY2), lockRow(DAY2)].join('\n') + '\n');
    const items = await gitContentionBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('lower bound');
  });

  it('appends git-contention items through discovery and dedupes on refresh', async () => {
    const runs = join(home, '.ashlr-runs');
    await mkdir(join(runs, 'metrics'), { recursive: true });
    await writeFile(join(runs, 'metrics', 'jobs.jsonl'),
      [lockRow(DAY1), lockRow(DAY2), lockRow(DAY2)].join('\n') + '\n');
    const savedRuns = process.env.ASHLR_RUNS_DIR;
    process.env.ASHLR_RUNS_DIR = runs;
    try {
      const greenGh = async (args: string[]) => {
        const p = args[4] ?? '';
        if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
        return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
      };
      const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
      const items = first.items.filter((i) => i.id.startsWith('fleet-git-'));
      expect(items).toHaveLength(1);
      expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
      expect(appendUserBacklogItems(items)).toBe(1);
      const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
      expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('fleet-git-')))).toBe(0);
      expect(readUserBacklogItems().filter((i) => i.id.startsWith('fleet-git-'))).toHaveLength(1);
    } finally {
      if (savedRuns === undefined) delete process.env.ASHLR_RUNS_DIR;
      else process.env.ASHLR_RUNS_DIR = savedRuns;
    }
  });
});
