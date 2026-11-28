import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DROP_REJECT_MAX_ITEMS,
  DROP_REJECT_RECURRING,
  DROP_REJECT_WINDOW_HOURS,
  dropRejectBacklogItems,
  foldDropRejectCells,
} from '../src/core/improve/drop-reject-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const HOUR = 3_600_000;
const NOW = Date.now();
const WINDOW_MS = DROP_REJECT_WINDOW_HOURS * HOUR;

const reject = (id: string, reason: string, hoursAgo: number) => ({ id, reason, atMs: NOW - hoursAgo * HOUR });

describe('foldDropRejectCells', () => {
  it('groups rejections by digit-normalized reason shape across distinct ids', () => {
    const cells = foldDropRejectCells([
      reject('AAA111', 'too-large-8102-bytes', 1),
      reject('BBB222', 'too-large-8221-bytes', 2),
      reject('CCC333', 'too-large-8300-bytes', 3),
      reject('DDD444', 'denied-path', 4),
      reject('EEE555', 'denied-path', 5),
    ], NOW, WINDOW_MS);
    expect(cells).toHaveLength(2);
    const large = cells.find((c) => c.shape === 'too-large-#-bytes')!;
    expect(large.count).toBe(3);
    expect(large.rows).toBe(3);
    expect(large.ids.sort()).toEqual(['AAA111', 'BBB222', 'CCC333']);
    const denied = cells.find((c) => c.shape === 'denied-path')!;
    expect(denied.count).toBe(2);
    expect(denied.reasons[0]!.text).toBe('denied-path');
  });

  it('counts one id once toward the recurring bar while rows keep file evidence', () => {
    const cells = foldDropRejectCells([
      reject('AAA111', 'denied-path-1', 1),
      reject('AAA111', 'denied-path-2', 2),
      reject('BBB222', 'denied-path-9', 3),
      reject('CCC333', 'denied-path-8', 4),
    ], NOW, WINDOW_MS);
    const cell = cells.find((c) => c.shape === 'denied-path-#')!;
    expect(cell.count).toBe(3);
    expect(cell.rows).toBe(4);
    expect(cell.ids.sort()).toEqual(['AAA111', 'BBB222', 'CCC333']);
  });

  it('excludes rows outside the window, beyond future skew, and with unusable timestamps', () => {
    const cells = foldDropRejectCells([
      reject('OLD11', 'denied-path', DROP_REJECT_WINDOW_HOURS + 1),
      reject('OLD22', 'denied-path', DROP_REJECT_WINDOW_HOURS + 2),
      reject('OLD33', 'denied-path', DROP_REJECT_WINDOW_HOURS + 3),
      reject('FUT11', 'denied-path', -1), // an hour ahead — beyond skew
      reject('FUT22', 'denied-path', -0.2), // 12 minutes ahead — beyond skew
      reject('FUT33', 'denied-path', -0.05), // 3 minutes ahead — inside the 5-minute skew
      reject('NEW11', 'denied-path', 1),
      reject('NEW22', 'denied-path', 2),
      reject('NEW33', 'denied-path', 3),
      { id: 'BAD44', reason: 'denied-path', atMs: Number.NaN },
    ], NOW, WINDOW_MS);
    const cell = cells.find((c) => c.shape === 'denied-path')!;
    // Only FUT33 (inside skew) and the NEW rows count; OLD rows and the NaN row do not.
    expect(cell.count).toBe(4);
    // ids quotes at most MAX_EXAMPLE_IDS examples in first-seen order.
    expect(cell.ids).toEqual(['FUT33', 'NEW11', 'NEW22']);
  });

  it('skips rows whose reason normalizes to nothing and flattens quoted text', () => {
    const cells = foldDropRejectCells([
      reject('AAA111', '   ', 1),
      reject('BBB222', 'denied-path\nwith\ttabs', 2),
      reject('CCC333', 'denied-path\nwith\ttabs', 3),
      reject('DDD444', 'denied-path\nwith\ttabs', 4),
    ], NOW, WINDOW_MS);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.shape).toBe('denied-path with tabs');
    expect(cells[0]!.reasons[0]!.text).not.toContain('\n');
    expect(cells[0]!.reasons[0]!.text.length).toBeLessThanOrEqual(160);
  });

  it('marks cells as lower bounds when the listing was capped', () => {
    const cells = foldDropRejectCells([
      reject('AAA111', 'denied-path', 1),
      reject('BBB222', 'denied-path', 2),
      reject('CCC333', 'denied-path', 3),
    ], NOW, WINDOW_MS, true);
    expect(cells[0]!.lowerBound).toBe(true);
  });
});

describe('dropRejectBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'drop-reject-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  /** A runs dir whose leader/drop/done holds the given file names, each stamped hoursAgo. */
  async function runsDir(name: string, files: { file: string; hoursAgo: number }[]): Promise<string> {
    const dir = join(home, name);
    const done = join(dir, 'leader', 'drop', 'done');
    await mkdir(done, { recursive: true });
    for (const { file, hoursAgo } of files) {
      const path = join(done, file);
      await writeFile(path, 'rejected prompt\n');
      const at = new Date(NOW - hoursAgo * HOUR);
      await utimes(path, at, at);
    }
    return dir;
  }

  const recurring = (prefix: string): { file: string; hoursAgo: number }[] => [
    { file: `RQ-PHX-${prefix}AAA111.md.denied-path`, hoursAgo: 1 },
    { file: `RQ-PHX-${prefix}BBB222.md.denied-path`, hoursAgo: 2 },
    { file: `RQ-PHX-${prefix}CCC333.md.denied-path`, hoursAgo: 3 },
  ];

  it('emits an item for a recurring reason shape across distinct drops', async () => {
    const dir = await runsDir('runs-group', recurring('G'));
    const items = await dropRejectBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom', area: 'drop-rejects' });
    expect(item!.id).toMatch(/^fleet-drop-reject-[0-9a-f]{16}$/);
    expect(item!.title).toContain('denied-path');
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item!.prompt).toContain('leader/drop/done/');
    expect(item!.prompt).toContain('RQ-PHX-GAAA111');
    expect(item!.prompt).toContain('drop-job-writer.ts');
    expect(item!.prompt).toContain('orch-ingest');
    expect(item!.prompt).toContain('no-change');
    expect(item!.prompt).toContain('pinned');
  });

  it('emits nothing below the recurring bar of distinct ids', async () => {
    const dir = await runsDir('runs-quiet', [
      { file: 'RQ-PHX-QAAA111.md.denied-path', hoursAgo: 1 },
      { file: 'RQ-PHX-QBBB222.md.denied-path', hoursAgo: 2 },
      { file: 'RQ-PHX-QCCC333.md.other-reason', hoursAgo: 3 },
      { file: 'RQ-PHX-QDDD444.md.other-reason', hoursAgo: 4 },
    ]);
    expect(await dropRejectBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) })).toEqual([]);
  });

  it('ignores files outside the window, unparseable names and non-files', async () => {
    const dir = await runsDir('runs-mixed', [
      { file: 'RQ-PHX-MAAA111.md.denied-path', hoursAgo: DROP_REJECT_WINDOW_HOURS + 1 },
      { file: 'RQ-PHX-MBBB222.md.denied-path', hoursAgo: DROP_REJECT_WINDOW_HOURS + 2 },
      { file: 'RQ-PHX-MCCC333.md.denied-path', hoursAgo: DROP_REJECT_WINDOW_HOURS + 3 },
      { file: 'RQ-PHX-plain.md', hoursAgo: 1 },
      { file: 'notes.txt', hoursAgo: 1 },
      { file: 'RQ-PHX-lowercase.md.denied-path', hoursAgo: 1 },
      { file: 'RQ-PHX-DDD444.md.denied-path', hoursAgo: 1 },
      { file: 'RQ-PHX-EEE555.md.denied-path', hoursAgo: 2 },
      { file: 'RQ-PHX-FFF666.md.denied-path', hoursAgo: 3 },
    ]);
    // Only the three in-window done-name files count; the rest are skipped.
    const items = await dropRejectBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('RQ-PHX-DDD444');
    expect(items[0]!.prompt).not.toContain('RQ-PHX-MAAA111');
  });

  it('skips symlinked entries and a symlinked done directory', async () => {
    const dir = await runsDir('runs-links', [
      ...recurring('L'),
      { file: 'RQ-PHX-LLL777.md.denied-path', hoursAgo: 4 },
    ]);
    const done = join(dir, 'leader', 'drop', 'done');
    const outside = join(home, 'outside-target');
    await writeFile(outside, 'not evidence\n');
    await symlink(outside, join(done, 'RQ-PHX-EEE888.md.denied-path'));
    const items = await dropRejectBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).not.toContain('RQ-PHX-EEE888');

    const linked = join(home, 'runs-linked-dir');
    await mkdir(join(linked, 'leader', 'drop'), { recursive: true });
    await symlink(done, join(linked, 'leader', 'drop', 'done'));
    expect(await dropRejectBacklogItems({ repo: 'ashlrai/phantom', runsDir: linked, now: new Date(NOW) })).toEqual([]);
  });

  it('emits nothing for a missing done directory, a file where the dir should be, or another repository', async () => {
    expect(await dropRejectBacklogItems({ repo: 'ashlrai/phantom', runsDir: join(home, 'no-such'), now: new Date(NOW) })).toEqual([]);

    const bad = join(home, 'runs-bad');
    await mkdir(join(bad, 'leader', 'drop'), { recursive: true });
    await writeFile(join(bad, 'leader', 'drop', 'done'), 'not a directory\n');
    expect(await dropRejectBacklogItems({ repo: 'ashlrai/phantom', runsDir: bad, now: new Date(NOW) })).toEqual([]);

    const dir = await runsDir('runs-repo', recurring('R'));
    expect(await dropRejectBacklogItems({ repo: 'ashlrai/other', runsDir: dir, now: new Date(NOW) })).toEqual([]);
    expect(await dropRejectBacklogItems({ repo: '', runsDir: dir, now: new Date(NOW) })).toEqual([]);
    expect(await dropRejectBacklogItems({ repo: 'AshlrAI/Phantom', runsDir: dir, now: new Date(NOW) })).toHaveLength(1);
  });

  it('derives stable ids so a refresh re-adds nothing and honours the limit', async () => {
    const dir = await runsDir('runs-stable', [
      ...recurring('S'),
      { file: 'RQ-PHX-STU888.md.too-large-9100-bytes', hoursAgo: 1 },
      { file: 'RQ-PHX-STV999.md.too-large-9200-bytes', hoursAgo: 2 },
      { file: 'RQ-PHX-STW000.md.too-large-9300-bytes', hoursAgo: 3 },
    ]);
    const opts = { repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) };
    const first = await dropRejectBacklogItems(opts);
    const second = await dropRejectBacklogItems(opts);
    expect(first).toHaveLength(2);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    expect(new Set(first.map((i) => i.id)).size).toBe(2);
    expect(await dropRejectBacklogItems({ ...opts, limit: 1 })).toHaveLength(1);
    expect(DROP_REJECT_RECURRING).toBe(3);
    expect(first.length).toBeLessThanOrEqual(DROP_REJECT_MAX_ITEMS);
    // The digit-normalized shape groups the three too-large files into one cell.
    expect(first.find((i) => i.title.includes('too-large-#-bytes'))).toBeDefined();
  });

  it('appends drop-reject items through discovery and dedupes on refresh', async () => {
    const runs = join(home, '.ashlr-runs');
    const done = join(runs, 'leader', 'drop', 'done');
    await mkdir(done, { recursive: true });
    for (const { file, hoursAgo } of recurring('D')) {
      const path = join(done, file);
      await writeFile(path, 'rejected prompt\n');
      const at = new Date(NOW - hoursAgo * HOUR);
      await utimes(path, at, at);
    }
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const rejectItems = first.items.filter((i) => i.id.startsWith('fleet-drop-reject-'));
    expect(rejectItems).toHaveLength(1);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(rejectItems)).toBe(1);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('fleet-drop-reject-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('fleet-drop-reject-'))).toHaveLength(1);
  });
});
