import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  foldReapCells,
  parseReapRows,
  WORKTREE_REAP_MAX_ITEMS,
  WORKTREE_REAP_RECURRING,
  worktreeReapBacklogItems,
  type WorktreeReapAction,
} from '../src/core/improve/worktree-reap-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';
import type { JobTimeline } from '../src/core/metrics/loop.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const J = (o: Record<string, unknown>): string => JSON.stringify(o);
const action = (job: string, atMs: number, kind: WorktreeReapAction['kind'] = 'remove-failed'): WorktreeReapAction =>
  ({ job, kind, reason: 'git-remove-failed', via: 'standard', atMs });
const timeline = (lane: string | null, repo: string | null = 'phantom'): Pick<JobTimeline, 'lane' | 'repo'> => ({ lane, repo });

describe('parseReapRows', () => {
  const NOW = Date.parse('2026-11-23T12:00:00.000Z');
  const CUTOFF = NOW - 7 * DAY;

  it('keeps only emit-worthy rows with worktree-shaped ids inside the window', () => {
    const rows = [
      J({ at: '2026-11-23T10:00:00.000Z', job: 'RQ-W1', status: 'failed', reason: 'git-remove-failed' }),
      J({ at: '2026-11-22T10:00:00.000Z', job: 'RQ-W2', status: 'refused', reason: 'unpushed-commits', via: 'stale-no-publish' }),
      J({ at: '2026-11-23T10:00:00.000Z', job: 'RQ-W3', status: 'removed' }),
      J({ at: '2026-11-23T10:00:00.000Z', job: 'RQ-W4', status: 'refused', reason: 'state-changed' }),
      J({ at: '2026-11-23T10:00:00.000Z', job: 'RQ-W5', status: 'refused' }),
      J({ at: '2026-11-23T10:00:00.000Z', job: 'RQ-W6', status: 'refused', reason: 'made-up' }),
      J({ at: '2026-11-23T10:00:00.000Z', job: 'bad id!', status: 'failed', reason: 'git-remove-failed' }),
      J({ at: '2026-11-10T10:00:00.000Z', job: 'RQ-W7', status: 'failed', reason: 'git-remove-failed' }), // outside window
      J({ at: '2026-11-24T10:00:00.000Z', job: 'RQ-W8', status: 'failed', reason: 'git-remove-failed' }), // future
      J({ job: 'RQ-W9', status: 'failed', reason: 'git-remove-failed' }), // no timestamp
      J({ at: '2026-11-23T10:00:00.000Z', job: 'RQ-W10', status: 'mystery' }),
      'not json at all',
      '',
    ].join('\n');
    const parsed = parseReapRows(rows, CUTOFF, NOW);
    expect(parsed.map((a) => [a.job, a.kind, a.via])).toEqual([
      ['RQ-W1', 'remove-failed', 'standard'],
      ['RQ-W2', 'unpushed-commits', 'stale-no-publish'],
    ]);
    expect(parsed[0]!.reason).toBe('git-remove-failed');
    expect(parsed[0]!.atMs).toBe(Date.parse('2026-11-23T10:00:00.000Z'));
  });
});

describe('foldReapCells', () => {
  const T0 = Date.parse('2026-11-23T08:00:00.000Z');
  const jobs = new Map<string, Pick<JobTimeline, 'lane' | 'repo'>>([
    ['RQ-W1', timeline('devin', 'phantom')],
    ['RQ-W2', timeline('devin', 'phantom')],
    ['RQ-W3', timeline('claude', 'phantom')],
    ['RQ-W4', timeline('devin', 'other-repo')],
  ]);

  it('groups by kind and lane, counts distinct jobs and keeps recorded tallies', () => {
    const cells = foldReapCells(
      [
        { ...action('RQ-W1', T0), reason: 'git-remove-failed' },
        { ...action('RQ-W2', T0 + MIN), reason: 'git-remove-failed' },
        { ...action('RQ-W1', T0 + 2 * MIN), reason: 'locked' }, // same job twice, second reason
        { ...action('RQ-W3', T0 + 3 * MIN, 'unpushed-commits'), reason: 'unpushed-commits' },
        { ...action('RQ-W4', T0 + 4 * MIN, 'unsafe-path'), reason: 'unsafe-path', via: 'stale-no-publish' },
      ],
      jobs,
    );
    expect(cells.map((c) => [c.kind, c.lane, c.count])).toEqual([
      ['remove-failed', 'devin', 2],
      ['unpushed-commits', 'claude', 1],
      ['unsafe-path', 'devin', 1],
    ]);
    const devin = cells[0]!;
    expect(devin.jobs).toEqual(['RQ-W1', 'RQ-W2']);
    expect(devin.repos).toEqual([{ text: 'phantom', count: 2 }]);
    expect(devin.reasons).toEqual([{ text: 'git-remove-failed', count: 2 }]);
    expect(devin.vias).toEqual([{ text: 'standard', count: 2 }]);
    expect(devin.firstSeen).toBe('2026-11-23T08:00:00.000Z');
    expect(devin.lastSeen).toBe('2026-11-23T08:02:00.000Z');
    expect(devin.lowerBound).toBe(false);
  });

  it('marks unattributed jobs unknown and never quotes unsafe ids', () => {
    const cells = foldReapCells(
      [action('RQ-W9', T0), action('RQ-W9', T0 + MIN), action('RQ-W9', T0 + 2 * MIN)],
      new Map(),
    );
    expect(cells).toHaveLength(1);
    expect(cells[0]!.lane).toBe('unknown');
    expect(cells[0]!.count).toBe(1); // three actions, one distinct job
    expect(cells[0]!.repos).toEqual([]);
  });

  it('flattens and caps ledger-recorded lane and repo text', () => {
    const dirty = new Map<string, Pick<JobTimeline, 'lane' | 'repo'>>([
      ['RQ-W1', timeline(`lane\n${'l'.repeat(100)}`, `r${'x'.repeat(200)}`)],
    ]);
    const cells = foldReapCells(
      [action('RQ-W1', T0), action('RQ-W1', T0 + MIN), action('RQ-W1', T0 + 2 * MIN)],
      dirty,
    );
    expect(cells).toHaveLength(1);
    expect(cells[0]!.lane.length).toBeLessThanOrEqual(60);
    expect(cells[0]!.repos[0]!.text.length).toBeLessThanOrEqual(120);
    expect(cells[0]!.lane).not.toContain('\n');
  });
});

describe('worktreeReapBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };
  const NOW = Date.now();
  const iso = (minAgo: number): string => new Date(NOW - minAgo * MIN).toISOString();

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'worktree-reap-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  /** A runs dir: the reap journal plus an optional jobs.jsonl. */
  async function runsDir(name: string, files: {
    reap?: string[];
    ledger?: string[];
  }): Promise<string> {
    const dir = join(home, name);
    await mkdir(join(dir, 'queue'), { recursive: true });
    await mkdir(join(dir, 'metrics'), { recursive: true });
    if (files.reap !== undefined) await writeFile(join(dir, 'queue', 'worktree-reap.jsonl'), files.reap.join('\n') + '\n');
    if (files.ledger !== undefined) await writeFile(join(dir, 'metrics', 'jobs.jsonl'), files.ledger.join('\n') + '\n');
    return dir;
  }
  const failRow = (job: string, min: number): string => J({ at: iso(min), job, status: 'failed', reason: 'git-remove-failed' });
  const refuseRow = (job: string, min: number, reason: string, via?: string): string =>
    J({ at: iso(min), job, status: 'refused', reason, ...(via === undefined ? {} : { via }) });
  const removedRow = (job: string, min: number): string => J({ at: iso(min), job, status: 'removed' });
  const launchRow = (job: string, min: number, lane = 'devin', repo = 'phantom'): string =>
    J({ event: 'launch', job, lane, repo, ts: iso(min) });

  it('emits a remove-failed item for a recurring lane cell and validates it', async () => {
    const dir = await runsDir('runs-fail', {
      reap: [failRow('RQ-W1', 60), failRow('RQ-W2', 120), failRow('RQ-W3', 180), failRow('RQ-W4', 90), removedRow('RQ-W9', 30)],
      ledger: [launchRow('RQ-W1', 400), launchRow('RQ-W2', 400), launchRow('RQ-W3', 400), launchRow('RQ-W4', 400, 'claude')],
    });
    const items = await worktreeReapBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom', area: 'worktree-reap' });
    expect(item!.id).toMatch(/^fleet-worktree-reap-[0-9a-f]{16}$/);
    expect(item!.title).toContain('failing to remove worktrees');
    expect(item!.title).toContain('devin');
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item!.prompt).toContain('RQ-W1');
    expect(item!.prompt).toContain('git-remove-failed');
    expect(item!.prompt).toContain('worktree-reap.jsonl');
    expect(item!.prompt).toContain('no-change');
    expect(item!.prompt).not.toContain('RQ-W9');
  });

  it('emits refused-kind items only for the stranding and unsafe reasons', async () => {
    const dir = await runsDir('runs-refuse', {
      reap: [
        refuseRow('RQ-W1', 60, 'unpushed-commits'), refuseRow('RQ-W2', 120, 'unpushed-commits'), refuseRow('RQ-W3', 180, 'unpushed-commits'),
        refuseRow('RQ-W4', 60, 'uncommitted-changes'), refuseRow('RQ-W5', 120, 'uncommitted-changes'), refuseRow('RQ-W6', 180, 'uncommitted-changes'),
        refuseRow('RQ-W7', 60, 'unsafe-path', 'stale-no-publish'), refuseRow('RQ-W8', 120, 'unsafe-path'), refuseRow('RQ-W9', 180, 'unsafe-path'),
        refuseRow('RQ-X1', 60, 'state-changed'), refuseRow('RQ-X2', 120, 'state-changed'), refuseRow('RQ-X3', 180, 'state-changed'),
      ],
      ledger: [
        launchRow('RQ-W1', 400), launchRow('RQ-W2', 400), launchRow('RQ-W3', 400),
        launchRow('RQ-W4', 400, 'claude'), launchRow('RQ-W5', 400, 'claude'), launchRow('RQ-W6', 400, 'claude'),
        launchRow('RQ-W7', 400), launchRow('RQ-W8', 400), launchRow('RQ-W9', 400),
      ],
    });
    const items = await worktreeReapBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) });
    expect(items.map((i) => i.title)).toEqual([
      'Job worktrees keep holding uncommitted changes on claude',
      'Job worktrees keep holding unpushed commits on devin',
      'The worktree reaper keeps refusing unsafe paths on devin',
    ]);
    expect(items.map((i) => i.id)).not.toEqual([items[0]!.id, items[0]!.id]);
    const unpushed = items.find((i) => i.title.includes('unpushed'))!;
    expect(unpushed.prompt).toContain('unpushed-commits');
    expect(unpushed.prompt).toContain('RQ-W1');
    const unsafe = items.find((i) => i.title.includes('unsafe'))!;
    expect(unsafe.prompt).toContain('unsafe-path');
    expect(unsafe.prompt).toContain('stale-no-publish');
    expect(items.every((i) => !i.prompt.includes('RQ-X1'))).toBe(true);
  });

  it('keeps the kinds in separate cells and honours the limit', async () => {
    const dir = await runsDir('runs-kinds', {
      reap: [
        failRow('RQ-W1', 60), failRow('RQ-W2', 120), failRow('RQ-W3', 180),
        refuseRow('RQ-U1', 60, 'unsafe-path'), refuseRow('RQ-U2', 120, 'unsafe-path'), refuseRow('RQ-U3', 180, 'unsafe-path'),
      ],
      ledger: [
        launchRow('RQ-W1', 400), launchRow('RQ-W2', 400), launchRow('RQ-W3', 400),
        launchRow('RQ-U1', 400, 'claude'), launchRow('RQ-U2', 400, 'claude'), launchRow('RQ-U3', 400, 'claude'),
      ],
    });
    const items = await worktreeReapBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(2);
    expect(items.map((i) => i.title)).toEqual([
      'The worktree reaper keeps refusing unsafe paths on claude',
      'The worktree reaper keeps failing to remove worktrees on devin',
    ]);
    expect(await worktreeReapBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW), limit: 1 })).toHaveLength(1);
  });

  it('emits nothing below the recurring bar of distinct jobs', async () => {
    // Three failed rows but only two distinct worktrees — under the bar.
    const dir = await runsDir('runs-thin', {
      reap: [failRow('RQ-W1', 60), failRow('RQ-W1', 120), failRow('RQ-W2', 180)],
    });
    expect(await worktreeReapBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) })).toEqual([]);
    expect(WORKTREE_REAP_RECURRING).toBe(3);
  });

  it('a missing jobs ledger leaves lanes unknown but never suppresses reap evidence', async () => {
    const dir = await runsDir('runs-nolanes', {
      reap: [failRow('RQ-W1', 60), failRow('RQ-W2', 120), failRow('RQ-W3', 180)],
    });
    const items = await worktreeReapBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toContain('unknown');
    expect(items[0]!.prompt).toContain('RQ-W1');
  });

  it('emits nothing for missing journals, another repository, or empty evidence', async () => {
    const empty = await runsDir('runs-empty', {});
    expect(await worktreeReapBacklogItems({ repo: 'ashlrai/phantom', runsDir: empty, now: new Date(NOW) })).toEqual([]);
    expect(await worktreeReapBacklogItems({ repo: 'ashlrai/phantom', runsDir: join(home, 'no-such'), now: new Date(NOW) })).toEqual([]);

    const dir = await runsDir('runs-repo', {
      reap: [failRow('RQ-W1', 60), failRow('RQ-W2', 120), failRow('RQ-W3', 180)],
      ledger: [launchRow('RQ-W1', 400), launchRow('RQ-W2', 400), launchRow('RQ-W3', 400)],
    });
    expect(await worktreeReapBacklogItems({ repo: 'ashlrai/other', runsDir: dir, now: new Date(NOW) })).toEqual([]);
    expect(await worktreeReapBacklogItems({ repo: 'AshlrAI/Phantom', runsDir: dir, now: new Date(NOW) })).toHaveLength(1);
  });

  it('states truncation as a lower bound in the prompt', async () => {
    const dir = await runsDir('runs-trunc', {
      reap: [failRow('RQ-W1', 60), failRow('RQ-W2', 120), failRow('RQ-W3', 180)],
      ledger: [launchRow('RQ-W1', 400), launchRow('RQ-W2', 400), launchRow('RQ-W3', 400)],
    });
    // Pad the journal past the 512 KiB tail so the read reports truncated.
    const pad = 'x'.repeat(600 * 1024);
    await writeFile(join(dir, 'queue', 'worktree-reap.jsonl'), pad + '\n' + [failRow('RQ-W1', 60), failRow('RQ-W2', 120), failRow('RQ-W3', 180)].join('\n') + '\n');
    const items = await worktreeReapBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('lower bound');
  });

  it('derives stable ids so a refresh re-adds nothing and honours the limit', async () => {
    const dir = await runsDir('runs-stable', {
      reap: [failRow('RQ-W1', 60), failRow('RQ-W2', 120), failRow('RQ-W3', 180)],
      ledger: [launchRow('RQ-W1', 400), launchRow('RQ-W2', 400), launchRow('RQ-W3', 400)],
    });
    const opts = { repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) };
    const first = await worktreeReapBacklogItems(opts);
    const second = await worktreeReapBacklogItems(opts);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    expect(first.length).toBeLessThanOrEqual(WORKTREE_REAP_MAX_ITEMS);
  });

  it('appends worktree-reap items through discovery and dedupes on refresh', async () => {
    const runs = join(home, '.ashlr-runs');
    await mkdir(join(runs, 'queue'), { recursive: true });
    await mkdir(join(runs, 'metrics'), { recursive: true });
    await writeFile(join(runs, 'queue', 'worktree-reap.jsonl'),
      [failRow('RQ-D1', 60), failRow('RQ-D2', 120), failRow('RQ-D3', 180)].join('\n') + '\n');
    await writeFile(join(runs, 'metrics', 'jobs.jsonl'),
      [launchRow('RQ-D1', 400), launchRow('RQ-D2', 400), launchRow('RQ-D3', 400)].join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const reapItems = first.items.filter((i) => i.id.startsWith('fleet-worktree-reap-'));
    expect(reapItems).toHaveLength(1);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(reapItems)).toBe(1);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('fleet-worktree-reap-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('fleet-worktree-reap-'))).toHaveLength(1);
  });
});
