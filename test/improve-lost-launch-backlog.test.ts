import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  foldLostLaunchCells,
  LOST_LAUNCH_MAX_ITEMS,
  LOST_LAUNCH_RECURRING,
  lostLaunchBacklogItems,
} from '../src/core/improve/lost-launch-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';
import type { LostLaunch } from '../src/core/fleet/lost-launches.js';

const MIN = 60_000;
const J = (o: Record<string, unknown>): string => JSON.stringify(o);
const lost = (job: string, reason: string, lane: string | null = 'devin', repo: string | null = 'phantom', at = '2026-11-23T10:00:00.000Z'): LostLaunch =>
  ({ job, lane, repo, launched_at: at, reason });

describe('foldLostLaunchCells', () => {
  it('groups corroborated losses by lane and class, excluding jobs still running', () => {
    const cells = foldLostLaunchCells([
      lost('A', 'launched, never finished', 'devin', 'phantom', '2026-11-23T08:00:00.000Z'),
      lost('B', 'launched, never finished', 'devin', 'phantom', '2026-11-23T09:00:00.000Z'),
      lost('C', 'launch failed: git ref lock race', 'devin', 'phantom', '2026-11-23T09:30:00.000Z'),
      lost('D', 'launched, never finished', 'claude', 'phantom', '2026-11-23T09:45:00.000Z'),
      lost('E', 'launched, never finished', 'devin', 'phantom', '2026-11-23T10:00:00.000Z'),
    ], new Set(['E']));
    expect(cells.map((c) => [c.kind, c.lane, c.count])).toEqual([
      ['vanished', 'devin', 2],
      ['vanished', 'claude', 1],
      ['launch-error', 'devin', 1],
    ]);
    const devin = cells[0]!;
    expect(devin.reasons).toEqual([{ text: 'launched, never finished', count: 2 }]);
    expect(devin.repos).toEqual([{ text: 'phantom', count: 2 }]);
    expect(devin.jobs).toEqual(['A', 'B']);
    expect(devin.firstSeen).toBe('2026-11-23T08:00:00.000Z');
    expect(devin.lastSeen).toBe('2026-11-23T09:00:00.000Z');
  });

  it('marks unrecorded lanes unknown and never quotes unsafe job ids', () => {
    const cells = foldLostLaunchCells([
      lost('safe-id_1.2', 'launched, never finished', null, null),
      lost('bad id\nforged', 'launched, never finished', null, null),
      lost('x'.repeat(200), 'launched, never finished', null, null),
    ], new Set());
    expect(cells).toHaveLength(1);
    expect(cells[0]!.lane).toBe('unknown');
    expect(cells[0]!.jobs).toEqual(['safe-id_1.2']);
    expect(cells[0]!.repos).toEqual([]);
  });

  it('flattens and caps ledger-recorded lane, repo and reason text', () => {
    const cells = foldLostLaunchCells([
      lost('A', `launch failed: ${'x'.repeat(300)}`, `lane\n${'l'.repeat(100)}`, 'r'.repeat(200)),
      lost('B', `launch failed: ${'x'.repeat(300)}`, `lane\n${'l'.repeat(100)}`, 'r'.repeat(200)),
      lost('C', `launch failed: ${'x'.repeat(300)}`, `lane\n${'l'.repeat(100)}`, 'r'.repeat(200)),
    ], new Set());
    expect(cells).toHaveLength(1);
    expect(cells[0]!.lane.length).toBeLessThanOrEqual(60);
    expect(cells[0]!.reasons[0]!.text.length).toBeLessThanOrEqual(160);
    expect(cells[0]!.repos[0]!.text.length).toBeLessThanOrEqual(120);
    expect(cells[0]!.reasons[0]!.text).not.toContain('\n');
  });
});

describe('lostLaunchBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };
  const NOW = Date.now();
  const ago = (min: number): string => new Date(NOW - min * MIN).toISOString();

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'lost-launch-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  /** A runs dir: jobs ledger rows, optional .launch heads and queue/run markers. */
  async function runsDir(name: string, files: {
    ledger?: string[];
    launches?: Record<string, string>;
    running?: string[];
  }): Promise<string> {
    const dir = join(home, name);
    await mkdir(join(dir, 'metrics'), { recursive: true });
    await mkdir(join(dir, 'queue', 'run'), { recursive: true });
    if (files.ledger !== undefined) await writeFile(join(dir, 'metrics', 'jobs.jsonl'), files.ledger.join('\n') + '\n');
    for (const [job, head] of Object.entries(files.launches ?? {})) {
      const p = join(dir, `${job}.launch`);
      await writeFile(p, `${head}\n`);
      const t = new Date(NOW - 60 * MIN);
      await utimes(p, t, t);
    }
    for (const job of files.running ?? []) {
      await writeFile(join(dir, 'queue', 'run', `${job}.line`), `${job}\tphantom\tdevin\twork\tprompt`);
    }
    return dir;
  }
  const launchRow = (job: string, min: number, lane = 'devin', repo = 'phantom'): string =>
    J({ event: 'launch', job, lane, repo, ts: ago(min) });

  it('emits a vanished-launch item for a recurring lane cell and validates it', async () => {
    const dir = await runsDir('runs-vanished', {
      ledger: [launchRow('RQ-V1', 120), launchRow('RQ-V2', 180), launchRow('RQ-V3', 240), launchRow('RQ-V4', 90, 'claude')],
      launches: { 'RQ-V1': 'started pid 11', 'RQ-V2': 'started pid 12', 'RQ-V3': 'started pid 13', 'RQ-V4': 'started pid 14' },
    });
    const items = await lostLaunchBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom', area: 'lost-launches' });
    expect(item!.id).toMatch(/^fleet-lost-launch-[0-9a-f]{16}$/);
    expect(item!.title).toContain('vanishing');
    expect(item!.title).toContain('devin');
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item!.prompt).toContain('RQ-V1');
    expect(item!.prompt).toContain('launched, never finished');
    expect(item!.prompt).toContain('jobs.lost.v1');
    expect(item!.prompt).toContain('no-change');
    expect(item!.prompt).toContain('queue/run');
  });

  it('emits a launch-error item for recurring .launch error heads', async () => {
    const dir = await runsDir('runs-errors', {
      ledger: [launchRow('RQ-E1', 50), launchRow('RQ-E2', 70), launchRow('RQ-E3', 100)],
      launches: {
        'RQ-E1': "error: cannot lock ref 'refs/remotes/origin/master'",
        'RQ-E2': "error: cannot lock ref 'refs/remotes/origin/master'",
        'RQ-E3': 'error: cannot lock ref \'refs/remotes/origin/master\'',
      },
    });
    const items = await lostLaunchBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toContain('dying at launch');
    expect(items[0]!.prompt).toContain('git ref lock race');
    expect(items[0]!.prompt).toContain('error:');
  });

  it('keeps the two classes in separate cells and honours the limit', async () => {
    const dir = await runsDir('runs-both', {
      ledger: [
        launchRow('RQ-M1', 100), launchRow('RQ-M2', 110), launchRow('RQ-M3', 120),
        launchRow('RQ-X1', 130, 'claude'), launchRow('RQ-X2', 140, 'claude'), launchRow('RQ-X3', 150, 'claude'),
      ],
      launches: {
        'RQ-M1': 'started', 'RQ-M2': 'started', 'RQ-M3': 'started',
        'RQ-X1': 'error: disk full', 'RQ-X2': 'error: disk full', 'RQ-X3': 'error: disk full',
      },
    });
    const items = await lostLaunchBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) });
    // Equal counts sort by lane: claude's launch-error cell precedes devin's vanished cell.
    expect(items.map((i) => i.title)).toEqual([
      'Fleet launches keep dying at launch on claude',
      'Fleet jobs keep launching then vanishing on devin',
    ]);
    expect(items.map((i) => i.id)).not.toEqual([items[0]!.id, items[0]!.id]);
    expect(await lostLaunchBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW), limit: 1 })).toHaveLength(1);
  });

  it('never counts a job the dispatcher still runs, and emits nothing below the recurring bar', async () => {
    // Three vanished launches on devin — but one still holds an open run marker.
    const dir = await runsDir('runs-running', {
      ledger: [launchRow('RQ-R1', 120), launchRow('RQ-R2', 130), launchRow('RQ-R3', 140)],
      launches: { 'RQ-R1': 'started', 'RQ-R2': 'started', 'RQ-R3': 'started' },
      running: ['RQ-R1'],
    });
    expect(await lostLaunchBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) })).toEqual([]);

    // Two corroborated losses stay under the bar.
    const quiet = await runsDir('runs-quiet', {
      ledger: [launchRow('RQ-Q1', 120), launchRow('RQ-Q2', 130)],
      launches: { 'RQ-Q1': 'started', 'RQ-Q2': 'started' },
    });
    expect(await lostLaunchBacklogItems({ repo: 'ashlrai/phantom', runsDir: quiet, now: new Date(NOW) })).toEqual([]);
    expect(LOST_LAUNCH_RECURRING).toBe(3);
  });

  it('a long-running job inside the grace or still holding a run marker is never lost evidence', async () => {
    const dir = await runsDir('runs-long', {
      ledger: [
        launchRow('RQ-L1', 20),   // inside the 30-minute launch grace
        launchRow('RQ-L2', 45),   // past grace but still running (marker open)
        launchRow('RQ-L3', 50), J({ event: 'finish', job: 'RQ-L3', lane: 'devin', ts: ago(40) }),
      ],
      launches: { 'RQ-L1': 'started', 'RQ-L2': 'started', 'RQ-L3': 'started' },
      running: ['RQ-L2'],
    });
    expect(await lostLaunchBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) })).toEqual([]);
  });

  it('emits nothing for a missing ledger, an unreadable runs dir, or another repository', async () => {
    const empty = await runsDir('runs-empty', {});
    expect(await lostLaunchBacklogItems({ repo: 'ashlrai/phantom', runsDir: empty, now: new Date(NOW) })).toEqual([]);
    expect(await lostLaunchBacklogItems({ repo: 'ashlrai/phantom', runsDir: join(home, 'no-such'), now: new Date(NOW) })).toEqual([]);

    const dir = await runsDir('runs-repo', {
      ledger: [launchRow('RQ-P1', 100), launchRow('RQ-P2', 110), launchRow('RQ-P3', 120)],
      launches: { 'RQ-P1': 'started', 'RQ-P2': 'started', 'RQ-P3': 'started' },
    });
    expect(await lostLaunchBacklogItems({ repo: 'ashlrai/other', runsDir: dir, now: new Date(NOW) })).toEqual([]);
    expect(await lostLaunchBacklogItems({ repo: 'AshlrAI/Phantom', runsDir: dir, now: new Date(NOW) })).toHaveLength(1);
  });

  it('queue/run that is not a directory is unknown, not an empty running set', async () => {
    const dir = await runsDir('runs-badmarkers', {
      ledger: [launchRow('RQ-B1', 100), launchRow('RQ-B2', 110), launchRow('RQ-B3', 120)],
      launches: { 'RQ-B1': 'started', 'RQ-B2': 'started', 'RQ-B3': 'started' },
    });
    await rm(join(dir, 'queue', 'run'), { recursive: true });
    await writeFile(join(dir, 'queue', 'run'), 'not a dir');
    expect(await lostLaunchBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) })).toEqual([]);
  });

  it('derives stable ids so a refresh re-adds nothing and honours the limit', async () => {
    const dir = await runsDir('runs-stable', {
      ledger: [launchRow('RQ-S1', 100), launchRow('RQ-S2', 110), launchRow('RQ-S3', 120)],
      launches: { 'RQ-S1': 'started', 'RQ-S2': 'started', 'RQ-S3': 'started' },
    });
    const opts = { repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) };
    const first = await lostLaunchBacklogItems(opts);
    const second = await lostLaunchBacklogItems(opts);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    expect(first.length).toBeLessThanOrEqual(LOST_LAUNCH_MAX_ITEMS);
  });

  it('appends lost-launch items through discovery and dedupes on refresh', async () => {
    const runs = join(home, '.ashlr-runs');
    await mkdir(join(runs, 'metrics'), { recursive: true });
    await mkdir(join(runs, 'queue', 'run'), { recursive: true });
    await writeFile(join(runs, 'metrics', 'jobs.jsonl'), [
      launchRow('RQ-D1', 100), launchRow('RQ-D2', 110), launchRow('RQ-D3', 120),
    ].join('\n') + '\n');
    for (const job of ['RQ-D1', 'RQ-D2', 'RQ-D3']) await writeFile(join(runs, `${job}.launch`), 'started\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const lostItems = first.items.filter((i) => i.id.startsWith('fleet-lost-launch-'));
    expect(lostItems).toHaveLength(1);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(lostItems)).toBe(1);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('fleet-lost-launch-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('fleet-lost-launch-'))).toHaveLength(1);
  });
});
