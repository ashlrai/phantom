import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  foldPrecheckSkipCells,
  PRECHECK_SKIP_MAX_ITEMS,
  PRECHECK_SKIP_RECURRING,
  PRECHECK_SKIP_WINDOW_HOURS,
  precheckSkipBacklogItems,
} from '../src/core/improve/precheck-skip-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const HOUR = 3_600_000;
const NOW = Date.now();

/** dispatchd writes `time.strftime("%F %T")` — local wall time, no offset. */
const stamp = (ms: number): string => {
  const d = new Date(ms);
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};
const row = (job: string, code: number, reason: string, hoursAgo: number): string =>
  `${stamp(NOW - hoursAgo * HOUR)}\t${job}\t${code}\t${reason}`;

describe('foldPrecheckSkipCells', () => {
  it('groups skips by code and digit-normalized reason shape across distinct jobs', () => {
    const cells = foldPrecheckSkipCells([
      row('RQ-A1', 10, 'id_merged_pr_101', 1),
      row('RQ-A2', 10, 'id_merged_pr_102', 2),
      row('RQ-A3', 10, 'id_merged_pr_103', 3),
      row('RQ-B1', 13, 'files_and_tests_exist', 4),
      row('RQ-B2', 13, 'files_and_tests_exist', 5),
    ].join('\n'), NOW, PRECHECK_SKIP_WINDOW_HOURS * HOUR);
    const groups = cells.filter((c) => c.kind === 'group');
    expect(groups).toHaveLength(2);
    const merged = groups.find((c) => c.code === '10')!;
    expect(merged.shape).toBe('id_merged_pr_#');
    expect(merged.count).toBe(3);
    expect(merged.rows).toBe(3);
    expect(merged.jobs.sort()).toEqual(['RQ-A1', 'RQ-A2', 'RQ-A3']);
    const files = groups.find((c) => c.code === '13')!;
    expect(files.shape).toBe('files_and_tests_exist');
    expect(files.count).toBe(2);
  });

  it('folds repeated skips of one job into a repeat cell', () => {
    const cells = foldPrecheckSkipCells([
      row('RQ-R1', 13, 'symbols_defined', 1),
      row('RQ-R1', 10, 'id_merged_pr_7', 2),
      row('RQ-R1', 14, 'dupcheck_already_done', 3),
      row('RQ-S1', 13, 'symbols_defined', 4),
    ].join('\n'), NOW, PRECHECK_SKIP_WINDOW_HOURS * HOUR);
    const repeat = cells.find((c) => c.kind === 'repeat')!;
    expect(repeat.job).toBe('RQ-R1');
    expect(repeat.count).toBe(3);
    expect(repeat.rows).toBe(3);
    expect(repeat.codes.map((t) => t.text).sort()).toEqual(['10', '13', '14']);
    expect(repeat.reasons).toHaveLength(3);
  });

  it('excludes rows outside the window, in the future, and with unusable timestamps', () => {
    const cells = foldPrecheckSkipCells([
      row('RQ-OLD1', 13, 'files_and_tests_exist', PRECHECK_SKIP_WINDOW_HOURS + 1),
      row('RQ-OLD2', 13, 'files_and_tests_exist', PRECHECK_SKIP_WINDOW_HOURS + 2),
      row('RQ-OLD3', 13, 'files_and_tests_exist', PRECHECK_SKIP_WINDOW_HOURS + 3),
      row('RQ-FUT1', 13, 'files_and_tests_exist', -2),
      row('RQ-FUT2', 13, 'files_and_tests_exist', -3),
      row('RQ-FUT3', 13, 'files_and_tests_exist', -4),
      'not a timestamp\tRQ-BAD1\t13\tfiles_and_tests_exist',
      '2026-13-40 99:99:99\tRQ-BAD2\t13\tfiles_and_tests_exist',
      row('RQ-NEW1', 13, 'files_and_tests_exist', 1),
      row('RQ-NEW2', 13, 'files_and_tests_exist', 2),
      row('RQ-NEW3', 13, 'files_and_tests_exist', 3),
    ].join('\n'), NOW, PRECHECK_SKIP_WINDOW_HOURS * HOUR);
    const group = cells.find((c) => c.kind === 'group' && c.code === '13')!;
    expect(group.count).toBe(3);
    expect(group.jobs.sort()).toEqual(['RQ-NEW1', 'RQ-NEW2', 'RQ-NEW3']);
    const repeats = cells.filter((c) => c.kind === 'repeat');
    expect(repeats.map((c) => c.job).sort()).toEqual(['RQ-NEW1', 'RQ-NEW2', 'RQ-NEW3']);
    expect(repeats.every((c) => c.count < PRECHECK_SKIP_RECURRING)).toBe(true);
  });

  it('drops malformed rows instead of folding them', () => {
    const cells = foldPrecheckSkipCells([
      'only\tthree\tcells',
      `${stamp(NOW - HOUR)}\tbad id\t13\tfiles_and_tests_exist`,
      `${stamp(NOW - HOUR)}\tRQ-X1\t13\tbad/reason`,
      `${stamp(NOW - HOUR)}\tRQ-X2\t13\t${'x'.repeat(401)}`,
      `${stamp(NOW - HOUR)}\tRQ-X3\t13`,
      '',
      row('RQ-OK1', 13, 'files_and_tests_exist', 1),
      row('RQ-OK2', 13, 'files_and_tests_exist', 2),
      row('RQ-OK3', 13, 'files_and_tests_exist', 3),
    ].join('\n'), NOW, PRECHECK_SKIP_WINDOW_HOURS * HOUR);
    const group = cells.find((c) => c.kind === 'group')!;
    expect(group.count).toBe(3);
    expect(group.jobs.sort()).toEqual(['RQ-OK1', 'RQ-OK2', 'RQ-OK3']);
  });

  it('flattens and caps recorded reason text before quoting it', () => {
    const cells = foldPrecheckSkipCells([
      row('RQ-T1', 11, 'pr_9_green   clean', 1),
      row('RQ-T2', 11, 'pr_10_green   clean', 2),
      row('RQ-T3', 11, 'pr_11_green   clean', 3),
    ].join('\n'), NOW, PRECHECK_SKIP_WINDOW_HOURS * HOUR);
    const group = cells.find((c) => c.kind === 'group')!;
    expect(group.reasons[0]!.text).not.toContain('  ');
    expect(group.reasons[0]!.text.length).toBeLessThanOrEqual(160);
    expect(group.shape).toBe('pr_#_green clean');
  });
});

describe('precheckSkipBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'precheck-skip-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  /** A runs dir holding only queue/precheck-skips.tsv. */
  async function runsDir(name: string, lines: string[]): Promise<string> {
    const dir = join(home, name);
    await mkdir(join(dir, 'queue'), { recursive: true });
    await writeFile(join(dir, 'queue', 'precheck-skips.tsv'), lines.join('\n') + '\n');
    return dir;
  }

  const groupRows = (): string[] => [
    row('RQ-G1', 13, 'files_and_tests_exist', 1),
    row('RQ-G2', 13, 'files_and_tests_exist', 2),
    row('RQ-G3', 13, 'files_and_tests_exist', 3),
  ];
  const repeatRows = (): string[] => [
    row('RQ-P1', 13, 'symbols_defined', 1),
    row('RQ-P1', 10, 'id_merged_pr_55', 2),
    row('RQ-P1', 14, 'dupcheck_already_done', 3),
  ];

  it('emits a group item for a recurring (code, reason) skip signature', async () => {
    const dir = await runsDir('runs-group', groupRows());
    const items = await precheckSkipBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom', area: 'precheck-skips' });
    expect(item!.id).toMatch(/^fleet-precheck-skip-[0-9a-f]{16}$/);
    expect(item!.title).toContain('code 13');
    expect(item!.title).toContain('files_and_tests_exist');
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item!.prompt).toContain('DONE-NOOP');
    expect(item!.prompt).toContain('precheck-skips.tsv');
    expect(item!.prompt).toContain('phm fleet precheck-repeats');
    expect(item!.prompt).toContain('RQ-G1');
    expect(item!.prompt).toContain('no-change');
    expect(item!.prompt).toContain('pinned');
  });

  it('emits a repeat item for a job id the queue keeps resurrecting', async () => {
    const dir = await runsDir('runs-repeat', repeatRows());
    const items = await precheckSkipBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) });
    const repeat = items.find((i) => i.title.includes('RQ-P1'));
    expect(repeat).toBeDefined();
    expect(repeat!.prompt).toContain('resurrecting');
    expect(repeat!.prompt).toContain('dupcheck_already_done');
    expect(validBacklogItem(repeat)).not.toBeNull();
  });

  it('emits both cell kinds and honours the limit', async () => {
    const dir = await runsDir('runs-both', [...groupRows(), ...repeatRows()]);
    const items = await precheckSkipBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(2);
    expect(new Set(items.map((i) => i.id)).size).toBe(2);
    expect(await precheckSkipBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW), limit: 1 })).toHaveLength(1);
    expect(PRECHECK_SKIP_RECURRING).toBe(3);
    expect(items.length).toBeLessThanOrEqual(PRECHECK_SKIP_MAX_ITEMS);
  });

  it('emits nothing below the recurring bar', async () => {
    const dir = await runsDir('runs-quiet', [
      row('RQ-Q1', 13, 'files_and_tests_exist', 1),
      row('RQ-Q2', 13, 'files_and_tests_exist', 2),
      row('RQ-Q3', 13, 'symbols_defined', 3),
      row('RQ-Q3', 13, 'symbols_defined', 4),
    ]);
    expect(await precheckSkipBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) })).toEqual([]);
  });

  it('emits nothing for a missing ledger, a degraded read, or another repository', async () => {
    expect(await precheckSkipBacklogItems({ repo: 'ashlrai/phantom', runsDir: join(home, 'no-such'), now: new Date(NOW) })).toEqual([]);

    // A directory where the ledger should be is a degraded source, never an empty one.
    const bad = join(home, 'runs-bad');
    await mkdir(join(bad, 'queue', 'precheck-skips.tsv'), { recursive: true });
    expect(await precheckSkipBacklogItems({ repo: 'ashlrai/phantom', runsDir: bad, now: new Date(NOW) })).toEqual([]);

    const dir = await runsDir('runs-repo', groupRows());
    expect(await precheckSkipBacklogItems({ repo: 'ashlrai/other', runsDir: dir, now: new Date(NOW) })).toEqual([]);
    expect(await precheckSkipBacklogItems({ repo: '', runsDir: dir, now: new Date(NOW) })).toEqual([]);
    expect(await precheckSkipBacklogItems({ repo: 'AshlrAI/Phantom', runsDir: dir, now: new Date(NOW) })).toHaveLength(1);
  });

  it('derives stable ids so a refresh re-adds nothing', async () => {
    const dir = await runsDir('runs-stable', groupRows());
    const opts = { repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) };
    const first = await precheckSkipBacklogItems(opts);
    const second = await precheckSkipBacklogItems(opts);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
  });

  it('appends precheck-skip items through discovery and dedupes on refresh', async () => {
    const runs = join(home, '.ashlr-runs');
    await mkdir(join(runs, 'queue'), { recursive: true });
    await writeFile(join(runs, 'queue', 'precheck-skips.tsv'), [...groupRows(), ...repeatRows()].join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const skipItems = first.items.filter((i) => i.id.startsWith('fleet-precheck-skip-'));
    expect(skipItems).toHaveLength(2);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(skipItems)).toBe(2);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('fleet-precheck-skip-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('fleet-precheck-skip-'))).toHaveLength(2);
  });
});
