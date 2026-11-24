import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  foldStrayStopCells,
  parseStrayStopRows,
  STRAY_STOP_MAX_ITEMS,
  STRAY_STOP_RECURRING,
  strayStopBacklogItems,
  type StrayStopRecord,
} from '../src/core/improve/stray-stop-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';
import type { JobTimeline } from '../src/core/metrics/loop.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const J = (o: Record<string, unknown>): string => JSON.stringify(o);
const stop = (lane: string, job: string, atMs: number, pid = 4321, result: StrayStopRecord['result'] = 'signalled'): StrayStopRecord =>
  ({ lane, job, pid, result, atMs });
const repoOf = (repo: string | null): Pick<JobTimeline, 'repo'> => ({ repo });

describe('parseStrayStopRows', () => {
  const NOW = Date.parse('2026-11-23T12:00:00.000Z');
  const CUTOFF = NOW - 72 * HOUR;

  it('keeps only writer-contract rows inside the window', () => {
    const rows = [
      J({ at: '2026-11-23T10:00:00.000Z', lane: 'devin', job: 'RQ-S1', pid: 4321, result: 'signalled' }),
      J({ at: '2026-11-22T10:00:00.000Z', lane: 'claude', job: 'RQ-S2', pid: 4322, result: 'already-gone' }),
      J({ at: '2026-11-23T10:00:00.000Z', lane: 'devin', job: 'RQ-S3', pid: 4323, result: 'refused' }),
      J({ at: '2026-11-23T10:00:00.000Z', lane: 'bad lane!', job: 'RQ-S4', pid: 4324, result: 'signalled' }),
      J({ at: '2026-11-23T10:00:00.000Z', lane: 'devin', job: 'RQ-S5', pid: 1, result: 'signalled' }),
      J({ at: '2026-11-23T10:00:00.000Z', lane: 'devin', job: 'RQ-S6', pid: 4326, result: 'signalled', extra: 'field' }),
      J({ at: '2026-11-20T10:00:00.000Z', lane: 'devin', job: 'RQ-S7', pid: 4327, result: 'signalled' }), // outside window
      J({ at: '2026-11-24T10:00:00.000Z', lane: 'devin', job: 'RQ-S8', pid: 4328, result: 'signalled' }), // future
      J({ lane: 'devin', job: 'RQ-S9', pid: 4329, result: 'signalled' }), // no timestamp
      'not json at all',
      '',
    ].join('\n');
    const parsed = parseStrayStopRows(rows, CUTOFF, NOW);
    expect(parsed.map((s) => s.job)).toEqual(['RQ-S1', 'RQ-S2', 'RQ-S6']);
    expect(parsed[0]).toMatchObject({ lane: 'devin', pid: 4321, result: 'signalled' });
    expect(parsed[0]!.atMs).toBe(Date.parse('2026-11-23T10:00:00.000Z'));
  });
});

describe('foldStrayStopCells', () => {
  const T0 = Date.parse('2026-11-23T08:00:00.000Z');
  const repos = new Map<string, Pick<JobTimeline, 'repo'>>([
    ['RQ-S1', repoOf('phantom')],
    ['RQ-S2', repoOf('phantom')],
    ['RQ-S3', repoOf('ashlrai/other')],
  ]);

  it('groups by lane, counts distinct jobs, keeps row and result tallies', () => {
    const cells = foldStrayStopCells(
      [
        stop('devin', 'RQ-S1', T0),
        stop('devin', 'RQ-S2', T0 + MIN, 4322, 'already-gone'),
        stop('devin', 'RQ-S1', T0 + 2 * MIN, 4323), // same job, second stray pid
        stop('devin', 'RQ-S3', T0 + 3 * MIN),
        stop('claude', 'RQ-S4', T0 + 4 * MIN),
      ],
      repos,
    );
    expect(cells.map((c) => [c.lane, c.count, c.stops])).toEqual([
      ['devin', 3, 4],
      ['claude', 1, 1],
    ]);
    const devin = cells[0]!;
    expect(devin.jobs).toEqual(['RQ-S1', 'RQ-S2', 'RQ-S3']);
    expect(devin.results).toEqual([{ text: 'signalled', count: 3 }, { text: 'already-gone', count: 1 }]);
    expect(devin.repos).toEqual([{ text: 'phantom', count: 2 }, { text: 'ashlrai/other', count: 1 }]);
    expect(devin.firstSeen).toBe('2026-11-23T08:00:00.000Z');
    expect(devin.lastSeen).toBe('2026-11-23T08:03:00.000Z');
    expect(devin.lowerBound).toBe(false);
  });

  it('a job absent from the jobs ledger contributes no repo tally but still counts', () => {
    const cells = foldStrayStopCells(
      [stop('devin', 'RQ-S9', T0), stop('devin', 'RQ-S9', T0 + MIN, 5000), stop('devin', 'RQ-S9', T0 + 2 * MIN, 5001)],
      new Map(),
    );
    expect(cells).toHaveLength(1);
    expect(cells[0]!.count).toBe(1); // three rows, one distinct job
    expect(cells[0]!.stops).toBe(3);
    expect(cells[0]!.repos).toEqual([]);
  });

  it('marks truncation as a lower bound and sanitizes recorded lane text', () => {
    const dirty = new Map<string, Pick<JobTimeline, 'repo'>>([['RQ-S1', repoOf(`r${'x'.repeat(200)}`)]]);
    const cells = foldStrayStopCells(
      [stop(`lane\n${'l'.repeat(100)}`, 'RQ-S1', T0), stop(`lane\n${'l'.repeat(100)}`, 'RQ-S1', T0 + MIN, 5000), stop(`lane\n${'l'.repeat(100)}`, 'RQ-S1', T0 + 2 * MIN, 5001)],
      dirty,
      true,
    );
    expect(cells).toHaveLength(1);
    expect(cells[0]!.lowerBound).toBe(true);
    expect(cells[0]!.lane.length).toBeLessThanOrEqual(80);
    expect(cells[0]!.lane).not.toContain('\n');
    expect(cells[0]!.repos[0]!.text.length).toBeLessThanOrEqual(120);
  });
});

describe('strayStopBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };
  const NOW = Date.now();
  const iso = (minAgo: number): string => new Date(NOW - minAgo * MIN).toISOString();

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'stray-stop-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  /** A runs dir: the stray-stop ledger at its root plus an optional jobs.jsonl. */
  async function runsDir(name: string, files: {
    stops?: string[];
    ledger?: string[];
  }): Promise<string> {
    const dir = join(home, name);
    await mkdir(join(dir, 'metrics'), { recursive: true });
    if (files.stops !== undefined) await writeFile(join(dir, 'stray-stops.jsonl'), files.stops.join('\n') + '\n');
    if (files.ledger !== undefined) await writeFile(join(dir, 'metrics', 'jobs.jsonl'), files.ledger.join('\n') + '\n');
    return dir;
  }
  const stopRow = (lane: string, job: string, min: number, pid = 4321, result = 'signalled'): string =>
    J({ at: iso(min), lane, job, pid, result });
  const launchRow = (job: string, min: number, lane = 'devin', repo = 'phantom'): string =>
    J({ event: 'launch', job, lane, repo, ts: iso(min) });

  it('emits a stray-stop item for a recurring lane cell and validates it', async () => {
    const dir = await runsDir('runs-stray', {
      stops: [
        stopRow('devin', 'RQ-S1', 60), stopRow('devin', 'RQ-S2', 120, 4322, 'already-gone'),
        stopRow('devin', 'RQ-S3', 180), stopRow('devin', 'RQ-S1', 90, 4323),
      ],
      ledger: [launchRow('RQ-S1', 400), launchRow('RQ-S2', 400), launchRow('RQ-S3', 400)],
    });
    const items = await strayStopBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom', area: 'stray-stops' });
    expect(item!.id).toMatch(/^fleet-stray-stop-[0-9a-f]{16}$/);
    expect(item!.title).toContain('stray processes');
    expect(item!.title).toContain('devin');
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item!.prompt).toContain('RQ-S1');
    expect(item!.prompt).toContain('stray-stops.jsonl');
    expect(item!.prompt).toContain('already-gone');
    expect(item!.prompt).toContain('no-change');
    expect(item!.prompt).toContain('worktree');
  });

  it('emits nothing below the recurring bar of distinct jobs', async () => {
    // Four stop rows but only two distinct jobs — under the bar.
    const dir = await runsDir('runs-thin', {
      stops: [
        stopRow('devin', 'RQ-S1', 60), stopRow('devin', 'RQ-S1', 120, 5000),
        stopRow('devin', 'RQ-S2', 180), stopRow('devin', 'RQ-S2', 240, 5001),
      ],
    });
    expect(await strayStopBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) })).toEqual([]);
    expect(STRAY_STOP_RECURRING).toBe(3);
  });

  it('keeps lanes in separate cells and honours the limit', async () => {
    const dir = await runsDir('runs-lanes', {
      stops: [
        stopRow('devin', 'RQ-S1', 60), stopRow('devin', 'RQ-S2', 120), stopRow('devin', 'RQ-S3', 180),
        stopRow('claude', 'RQ-S4', 60), stopRow('claude', 'RQ-S5', 120), stopRow('claude', 'RQ-S6', 180),
      ],
      ledger: [
        launchRow('RQ-S1', 400), launchRow('RQ-S2', 400), launchRow('RQ-S3', 400),
        launchRow('RQ-S4', 400, 'claude'), launchRow('RQ-S5', 400, 'claude'), launchRow('RQ-S6', 400, 'claude'),
      ],
    });
    const items = await strayStopBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) });
    expect(items.map((i) => i.title)).toEqual([
      'Finished fleet jobs keep leaving stray processes on claude',
      'Finished fleet jobs keep leaving stray processes on devin',
    ]);
    expect(items.map((i) => i.id)).not.toEqual([items[0]!.id, items[0]!.id]);
    expect(await strayStopBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW), limit: 1 })).toHaveLength(1);
    expect(STRAY_STOP_MAX_ITEMS).toBe(8);
  });

  it('a missing jobs ledger still emits — repo tallies are enrichment, never a gate', async () => {
    const dir = await runsDir('runs-norepos', {
      stops: [stopRow('devin', 'RQ-S1', 60), stopRow('devin', 'RQ-S2', 120), stopRow('devin', 'RQ-S3', 180)],
    });
    const items = await strayStopBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).not.toContain('Recorded repositories');
    expect(items[0]!.prompt).toContain('RQ-S1');
  });

  it('emits nothing for missing ledgers, another repository, or empty evidence', async () => {
    const empty = await runsDir('runs-empty', {});
    expect(await strayStopBacklogItems({ repo: 'ashlrai/phantom', runsDir: empty, now: new Date(NOW) })).toEqual([]);
    expect(await strayStopBacklogItems({ repo: 'ashlrai/phantom', runsDir: join(home, 'no-such'), now: new Date(NOW) })).toEqual([]);

    const dir = await runsDir('runs-repo', {
      stops: [stopRow('devin', 'RQ-S1', 60), stopRow('devin', 'RQ-S2', 120), stopRow('devin', 'RQ-S3', 180)],
      ledger: [launchRow('RQ-S1', 400), launchRow('RQ-S2', 400), launchRow('RQ-S3', 400)],
    });
    expect(await strayStopBacklogItems({ repo: 'ashlrai/other', runsDir: dir, now: new Date(NOW) })).toEqual([]);
    expect(await strayStopBacklogItems({ repo: 'AshlrAI/Phantom', runsDir: dir, now: new Date(NOW) })).toHaveLength(1);
  });

  it('states truncation as a lower bound in the prompt', async () => {
    const dir = await runsDir('runs-trunc', {
      stops: [stopRow('devin', 'RQ-S1', 60), stopRow('devin', 'RQ-S2', 120), stopRow('devin', 'RQ-S3', 180)],
    });
    // Pad the ledger past the 512 KiB tail so the read reports truncated.
    const pad = 'x'.repeat(600 * 1024);
    await writeFile(join(dir, 'stray-stops.jsonl'), pad + '\n' + [stopRow('devin', 'RQ-S1', 60), stopRow('devin', 'RQ-S2', 120), stopRow('devin', 'RQ-S3', 180)].join('\n') + '\n');
    const items = await strayStopBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('lower bound');
  });

  it('derives stable ids so a refresh re-adds nothing', async () => {
    const dir = await runsDir('runs-stable', {
      stops: [stopRow('devin', 'RQ-S1', 60), stopRow('devin', 'RQ-S2', 120), stopRow('devin', 'RQ-S3', 180)],
      ledger: [launchRow('RQ-S1', 400), launchRow('RQ-S2', 400), launchRow('RQ-S3', 400)],
    });
    const opts = { repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) };
    const first = await strayStopBacklogItems(opts);
    const second = await strayStopBacklogItems(opts);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    expect(first.length).toBeLessThanOrEqual(STRAY_STOP_MAX_ITEMS);
  });

  it('appends stray-stop items through discovery and dedupes on refresh', async () => {
    const runs = join(home, '.ashlr-runs');
    await mkdir(join(runs, 'metrics'), { recursive: true });
    await writeFile(join(runs, 'stray-stops.jsonl'),
      [stopRow('devin', 'RQ-D1', 60), stopRow('devin', 'RQ-D2', 120), stopRow('devin', 'RQ-D3', 180)].join('\n') + '\n');
    await writeFile(join(runs, 'metrics', 'jobs.jsonl'),
      [launchRow('RQ-D1', 400), launchRow('RQ-D2', 400), launchRow('RQ-D3', 400)].join('\n') + '\n');
    const savedRuns = process.env.ASHLR_RUNS_DIR;
    process.env.ASHLR_RUNS_DIR = runs;
    try {
      const greenGh = async (args: string[]) => {
        const p = args[4] ?? '';
        if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
        return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
      };
      const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
      const strayItems = first.items.filter((i) => i.id.startsWith('fleet-stray-stop-'));
      expect(strayItems).toHaveLength(1);
      expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
      expect(appendUserBacklogItems(strayItems)).toBe(1);
      const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
      expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('fleet-stray-stop-')))).toBe(0);
      expect(readUserBacklogItems().filter((i) => i.id.startsWith('fleet-stray-stop-'))).toHaveLength(1);
    } finally {
      if (savedRuns === undefined) delete process.env.ASHLR_RUNS_DIR;
      else process.env.ASHLR_RUNS_DIR = savedRuns;
    }
  });
});
