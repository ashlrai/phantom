import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  foldStuckJobCells,
  parseGhostRows,
  parseStuckKillRows,
  STUCK_JOB_MAX_ITEMS,
  STUCK_JOB_RECURRING,
  stuckJobBacklogItems,
  type StuckJobAction,
} from '../src/core/improve/stuck-job-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';
import type { JobTimeline } from '../src/core/metrics/loop.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const J = (o: Record<string, unknown>): string => JSON.stringify(o);
const action = (job: string, atMs: number): StuckJobAction => ({ job, atMs });
const timeline = (lane: string | null, repo: string | null = 'phantom'): Pick<JobTimeline, 'lane' | 'repo'> => ({ lane, repo });

describe('parseGhostRows', () => {
  const NOW = Date.parse('2026-11-23T12:00:00.000Z');
  const CUTOFF = NOW - 72 * HOUR;

  it('keeps only ghost-closed rows with fleet-shaped ids inside the window', () => {
    const rows = [
      J({ at: '2026-11-23T10:00:00.000Z', job: 'RQ-G1', action: 'ghost-closed' }),
      J({ at: '2026-11-22T10:00:00.000Z', job: 'RQ-G2', action: 'ghost-closed' }),
      J({ at: '2026-11-23T10:00:00.000Z', job: 'RQ-X1', action: 'other-action' }),
      J({ at: '2026-11-23T10:00:00.000Z', job: 'bad id!', action: 'ghost-closed' }),
      J({ at: '2026-11-20T10:00:00.000Z', job: 'RQ-G3', action: 'ghost-closed' }), // outside window
      J({ at: '2026-11-24T10:00:00.000Z', job: 'RQ-G4', action: 'ghost-closed' }), // future
      J({ job: 'RQ-G5', action: 'ghost-closed' }), // no timestamp
      'not json at all',
      '',
    ].join('\n');
    const parsed = parseGhostRows(rows, CUTOFF, NOW);
    expect(parsed.map((a) => a.job)).toEqual(['RQ-G1', 'RQ-G2']);
    expect(parsed[0]!.atMs).toBe(Date.parse('2026-11-23T10:00:00.000Z'));
  });
});

describe('parseStuckKillRows', () => {
  const NOW = Date.parse('2026-11-23T12:00:00.000Z');
  const CUTOFF = NOW - 72 * HOUR;

  it('keeps only by:stuck-jobs stopped rows; operator stops and no-ops never count', () => {
    const rows = [
      J({ at: '2026-11-23T10:00:00.000Z', id: 'RQ-K1', pids: [11, 12], outcome: 'stopped', by: 'stuck-jobs' }),
      J({ at: '2026-11-23T09:00:00.000Z', id: 'RQ-K2', pids: [13], outcome: 'stopped', by: 'verse-operator' }),
      J({ at: '2026-11-23T09:30:00.000Z', id: 'RQ-K3', pids: [], outcome: 'not-running', by: 'stuck-jobs' }),
      J({ at: '2026-11-23T09:45:00.000Z', id: 'bad id!', pids: [], outcome: 'refused', by: 'stuck-jobs' }),
      J({ at: '2026-11-20T10:00:00.000Z', id: 'RQ-K4', pids: [14], outcome: 'stopped', by: 'stuck-jobs' }),
      'garbage',
    ].join('\n');
    const parsed = parseStuckKillRows(rows, CUTOFF, NOW);
    expect(parsed.map((a) => a.job)).toEqual(['RQ-K1']);
  });
});

describe('foldStuckJobCells', () => {
  const T0 = Date.parse('2026-11-23T08:00:00.000Z');
  const jobs = new Map<string, Pick<JobTimeline, 'lane' | 'repo'>>([
    ['RQ-G1', timeline('devin', 'phantom')],
    ['RQ-G2', timeline('devin', 'phantom')],
    ['RQ-G3', timeline('claude', 'phantom')],
    ['RQ-K1', timeline('devin', 'phantom')],
  ]);

  it('groups by kind and lane, counts distinct jobs and keeps recorded tallies', () => {
    const cells = foldStuckJobCells(
      [action('RQ-G1', T0), action('RQ-G2', T0 + MIN), action('RQ-G1', T0 + 2 * MIN), action('RQ-G3', T0 + 3 * MIN)],
      [action('RQ-K1', T0 + 4 * MIN)],
      jobs,
    );
    expect(cells.map((c) => [c.kind, c.lane, c.count])).toEqual([
      ['ghost', 'devin', 2],
      ['ghost', 'claude', 1],
      ['stuck-kill', 'devin', 1],
    ]);
    const devin = cells[0]!;
    expect(devin.jobs).toEqual(['RQ-G1', 'RQ-G2']);
    expect(devin.repos).toEqual([{ text: 'phantom', count: 2 }]);
    expect(devin.firstSeen).toBe('2026-11-23T08:00:00.000Z');
    expect(devin.lastSeen).toBe('2026-11-23T08:02:00.000Z');
    expect(devin.lowerBound).toBe(false);
  });

  it('marks unattributed jobs unknown and never quotes unsafe ids', () => {
    const cells = foldStuckJobCells(
      [action('RQ-G9', T0), action('RQ-G9', T0 + MIN), action('RQ-G9', T0 + 2 * MIN)],
      [],
      new Map(),
    );
    expect(cells).toHaveLength(1);
    expect(cells[0]!.lane).toBe('unknown');
    expect(cells[0]!.count).toBe(1); // three actions, one distinct job
    expect(cells[0]!.repos).toEqual([]);
  });

  it('flattens and caps ledger-recorded lane and repo text', () => {
    const dirty = new Map<string, Pick<JobTimeline, 'lane' | 'repo'>>([
      ['RQ-G1', timeline(`lane\n${'l'.repeat(100)}`, `r${'x'.repeat(200)}`)],
    ]);
    const cells = foldStuckJobCells(
      [action('RQ-G1', T0), action('RQ-G1', T0 + MIN), action('RQ-G1', T0 + 2 * MIN)],
      [],
      dirty,
    );
    expect(cells).toHaveLength(1);
    expect(cells[0]!.lane.length).toBeLessThanOrEqual(60);
    expect(cells[0]!.repos[0]!.text.length).toBeLessThanOrEqual(120);
    expect(cells[0]!.lane).not.toContain('\n');
  });
});

describe('stuckJobBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };
  const NOW = Date.now();
  const iso = (minAgo: number): string => new Date(NOW - minAgo * MIN).toISOString();

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'stuck-job-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  /** A runs dir: the two reaper ledgers plus an optional jobs.jsonl. */
  async function runsDir(name: string, files: {
    ghosts?: string[];
    stops?: string[];
    ledger?: string[];
  }): Promise<string> {
    const dir = join(home, name);
    await mkdir(join(dir, 'queue'), { recursive: true });
    await mkdir(join(dir, 'metrics'), { recursive: true });
    if (files.ghosts !== undefined) await writeFile(join(dir, 'queue', 'stuck-jobs.jsonl'), files.ghosts.join('\n') + '\n');
    if (files.stops !== undefined) await writeFile(join(dir, 'queue', 'job-stops.jsonl'), files.stops.join('\n') + '\n');
    if (files.ledger !== undefined) await writeFile(join(dir, 'metrics', 'jobs.jsonl'), files.ledger.join('\n') + '\n');
    return dir;
  }
  const ghostRow = (job: string, min: number): string => J({ at: iso(min), job, action: 'ghost-closed' });
  const stopRow = (job: string, min: number, by = 'stuck-jobs', outcome = 'stopped'): string =>
    J({ at: iso(min), id: job, pids: [4321], outcome, by });
  const launchRow = (job: string, min: number, lane = 'devin', repo = 'phantom'): string =>
    J({ event: 'launch', job, lane, repo, ts: iso(min) });

  it('emits a ghost item for a recurring lane cell and validates it', async () => {
    const dir = await runsDir('runs-ghost', {
      ghosts: [ghostRow('RQ-G1', 60), ghostRow('RQ-G2', 120), ghostRow('RQ-G3', 180), ghostRow('RQ-G4', 90)],
      ledger: [launchRow('RQ-G1', 200), launchRow('RQ-G2', 200), launchRow('RQ-G3', 200), launchRow('RQ-G4', 200, 'claude')],
    });
    const items = await stuckJobBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom', area: 'stuck-jobs' });
    expect(item!.id).toMatch(/^fleet-stuck-job-[0-9a-f]{16}$/);
    expect(item!.title).toContain('ghost run markers');
    expect(item!.title).toContain('devin');
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item!.prompt).toContain('RQ-G1');
    expect(item!.prompt).toContain('ghost-closed');
    expect(item!.prompt).toContain('stuck-jobs.jsonl');
    expect(item!.prompt).toContain('no-change');
    expect(item!.prompt).toContain('queue/run');
  });

  it('emits a stuck-kill item only for by:stuck-jobs stopped rows', async () => {
    const dir = await runsDir('runs-kill', {
      stops: [
        stopRow('RQ-K1', 60), stopRow('RQ-K2', 120), stopRow('RQ-K3', 180),
        stopRow('RQ-K4', 60, 'verse-operator'),          // deliberate stop, not reaper evidence
        stopRow('RQ-K5', 60, 'stuck-jobs', 'not-running'), // no processes found, no kill
      ],
      ledger: [launchRow('RQ-K1', 400), launchRow('RQ-K2', 400), launchRow('RQ-K3', 400)],
    });
    const items = await stuckJobBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toContain('hanging until the reaper kills');
    expect(items[0]!.prompt).toContain('RQ-K1');
    expect(items[0]!.prompt).toContain('job-stops.jsonl');
    expect(items[0]!.prompt).not.toContain('RQ-K4');
    expect(items[0]!.prompt).not.toContain('RQ-K5');
  });

  it('keeps the two classes in separate cells and honours the limit', async () => {
    const dir = await runsDir('runs-both', {
      ghosts: [ghostRow('RQ-G1', 60), ghostRow('RQ-G2', 120), ghostRow('RQ-G3', 180)],
      stops: [stopRow('RQ-K1', 60), stopRow('RQ-K2', 120), stopRow('RQ-K3', 180)],
      ledger: [
        launchRow('RQ-G1', 400), launchRow('RQ-G2', 400), launchRow('RQ-G3', 400),
        launchRow('RQ-K1', 400, 'claude'), launchRow('RQ-K2', 400, 'claude'), launchRow('RQ-K3', 400, 'claude'),
      ],
    });
    const items = await stuckJobBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) });
    expect(items.map((i) => i.title)).toEqual([
      'Fleet jobs keep hanging until the reaper kills them on claude',
      'Fleet jobs keep leaving ghost run markers on devin',
    ]);
    expect(items.map((i) => i.id)).not.toEqual([items[0]!.id, items[0]!.id]);
    expect(await stuckJobBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW), limit: 1 })).toHaveLength(1);
  });

  it('emits nothing below the recurring bar of distinct jobs', async () => {
    // Three ghost rows but only two distinct jobs — under the bar.
    const dir = await runsDir('runs-thin', {
      ghosts: [ghostRow('RQ-G1', 60), ghostRow('RQ-G1', 120), ghostRow('RQ-G2', 180)],
    });
    expect(await stuckJobBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) })).toEqual([]);
    expect(STUCK_JOB_RECURRING).toBe(3);
  });

  it('a missing jobs ledger leaves lanes unknown but never suppresses reaper evidence', async () => {
    const dir = await runsDir('runs-nolanes', {
      ghosts: [ghostRow('RQ-G1', 60), ghostRow('RQ-G2', 120), ghostRow('RQ-G3', 180)],
    });
    const items = await stuckJobBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toContain('unknown');
    expect(items[0]!.prompt).toContain('RQ-G1');
  });

  it('emits nothing for missing ledgers, another repository, or empty evidence', async () => {
    const empty = await runsDir('runs-empty', {});
    expect(await stuckJobBacklogItems({ repo: 'ashlrai/phantom', runsDir: empty, now: new Date(NOW) })).toEqual([]);
    expect(await stuckJobBacklogItems({ repo: 'ashlrai/phantom', runsDir: join(home, 'no-such'), now: new Date(NOW) })).toEqual([]);

    const dir = await runsDir('runs-repo', {
      ghosts: [ghostRow('RQ-G1', 60), ghostRow('RQ-G2', 120), ghostRow('RQ-G3', 180)],
      ledger: [launchRow('RQ-G1', 400), launchRow('RQ-G2', 400), launchRow('RQ-G3', 400)],
    });
    expect(await stuckJobBacklogItems({ repo: 'ashlrai/other', runsDir: dir, now: new Date(NOW) })).toEqual([]);
    expect(await stuckJobBacklogItems({ repo: 'AshlrAI/Phantom', runsDir: dir, now: new Date(NOW) })).toHaveLength(1);
  });

  it('one missing ledger silences only its own class', async () => {
    const dir = await runsDir('runs-half', {
      stops: [stopRow('RQ-K1', 60), stopRow('RQ-K2', 120), stopRow('RQ-K3', 180)],
      ledger: [launchRow('RQ-K1', 400), launchRow('RQ-K2', 400), launchRow('RQ-K3', 400)],
    });
    const items = await stuckJobBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toContain('hanging until the reaper kills');
  });

  it('states truncation as a lower bound in the prompt', async () => {
    const dir = await runsDir('runs-trunc', {
      ghosts: [ghostRow('RQ-G1', 60), ghostRow('RQ-G2', 120), ghostRow('RQ-G3', 180)],
      ledger: [launchRow('RQ-G1', 400), launchRow('RQ-G2', 400), launchRow('RQ-G3', 400)],
    });
    // Pad the ghost ledger past the 512 KiB tail so the read reports truncated.
    const pad = 'x'.repeat(600 * 1024);
    await writeFile(join(dir, 'queue', 'stuck-jobs.jsonl'), pad + '\n' + [ghostRow('RQ-G1', 60), ghostRow('RQ-G2', 120), ghostRow('RQ-G3', 180)].join('\n') + '\n');
    const items = await stuckJobBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('lower bound');
  });

  it('derives stable ids so a refresh re-adds nothing and honours the limit', async () => {
    const dir = await runsDir('runs-stable', {
      ghosts: [ghostRow('RQ-G1', 60), ghostRow('RQ-G2', 120), ghostRow('RQ-G3', 180)],
      ledger: [launchRow('RQ-G1', 400), launchRow('RQ-G2', 400), launchRow('RQ-G3', 400)],
    });
    const opts = { repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) };
    const first = await stuckJobBacklogItems(opts);
    const second = await stuckJobBacklogItems(opts);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    expect(first.length).toBeLessThanOrEqual(STUCK_JOB_MAX_ITEMS);
  });

  it('appends stuck-job items through discovery and dedupes on refresh', async () => {
    const runs = join(home, '.ashlr-runs');
    await mkdir(join(runs, 'queue'), { recursive: true });
    await mkdir(join(runs, 'metrics'), { recursive: true });
    await writeFile(join(runs, 'queue', 'stuck-jobs.jsonl'),
      [ghostRow('RQ-D1', 60), ghostRow('RQ-D2', 120), ghostRow('RQ-D3', 180)].join('\n') + '\n');
    await writeFile(join(runs, 'metrics', 'jobs.jsonl'),
      [launchRow('RQ-D1', 400), launchRow('RQ-D2', 400), launchRow('RQ-D3', 400)].join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const stuckItems = first.items.filter((i) => i.id.startsWith('fleet-stuck-job-'));
    expect(stuckItems).toHaveLength(1);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(stuckItems)).toBe(1);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('fleet-stuck-job-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('fleet-stuck-job-'))).toHaveLength(1);
  });
});
