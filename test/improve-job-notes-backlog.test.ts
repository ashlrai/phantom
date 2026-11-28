import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  foldJobNotesCells,
  JOB_NOTES_MAX_ITEMS,
  JOB_NOTES_RECURRING,
  JOB_NOTES_WINDOW_HOURS,
  jobNotesBacklogItems,
} from '../src/core/improve/job-notes-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const HOUR = 3_600_000;
const NOW = Date.now();
const at = (hoursAgo: number): string => new Date(NOW - hoursAgo * HOUR).toISOString();

/** One row exactly as sayToJob appends it: {schema, job, id, at, text, by}. */
const note = (job: string, n: number, hoursAgo: number, by = 'cli', text = `note ${n}`): string =>
  JSON.stringify({ schema: 'fleet.job.say.v1', job, id: `n-${n}`, at: at(hoursAgo), text, by });

describe('foldJobNotesCells', () => {
  it('folds notes per job with sender counts and seen bounds', () => {
    const cells = foldJobNotesCells([
      note('RQ-J1', 1, 5, 'cli'),
      note('RQ-J1', 2, 3, 'desktop'),
      note('RQ-J1', 3, 1, 'cli'),
      note('RQ-J2', 1, 2, 'mobile'),
      note('RQ-J2', 2, 1, 'mobile'),
    ].join('\n'), NOW, JOB_NOTES_WINDOW_HOURS * HOUR);
    expect(cells).toHaveLength(2);
    const j1 = cells.find((c) => c.job === 'RQ-J1')!;
    expect(j1.count).toBe(3);
    expect(j1.senders).toBe(2);
    expect(j1.firstSeen).toBe(at(5));
    expect(j1.lastSeen).toBe(at(1));
    expect(cells[0]!.job).toBe('RQ-J1');
    expect(cells[0]!.count).toBe(3);
  });

  it('excludes rows outside the window, in the future, and with unusable timestamps', () => {
    const cells = foldJobNotesCells([
      note('RQ-OLD', 1, JOB_NOTES_WINDOW_HOURS + 1),
      note('RQ-OLD', 2, JOB_NOTES_WINDOW_HOURS + 2),
      note('RQ-OLD', 3, JOB_NOTES_WINDOW_HOURS + 3),
      note('RQ-FUT', 1, -2),
      note('RQ-FUT', 2, -3),
      note('RQ-FUT', 3, -4),
      JSON.stringify({ schema: 'fleet.job.say.v1', job: 'RQ-BAD1', id: 'n-1', at: 'not a date', text: 'x', by: 'cli' }),
      JSON.stringify({ schema: 'fleet.job.say.v1', job: 'RQ-BAD2', id: 'n-1', at: at(1) }),
      note('RQ-NEW', 1, 3),
      note('RQ-NEW', 2, 2),
      note('RQ-NEW', 3, 1),
    ].join('\n'), NOW, JOB_NOTES_WINDOW_HOURS * HOUR);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.job).toBe('RQ-NEW');
    expect(cells[0]!.count).toBe(3);
  });

  it('drops malformed, foreign-schema and unsafe-job rows instead of folding them', () => {
    const cells = foldJobNotesCells([
      'not json',
      '[]',
      JSON.stringify({ schema: 'other.v1', job: 'RQ-X1', id: 'n-1', at: at(1), text: 'x', by: 'cli' }),
      JSON.stringify({ schema: 'fleet.job.say.v1', job: 'bad id', id: 'n-1', at: at(1), text: 'x', by: 'cli' }),
      JSON.stringify({ schema: 'fleet.job.say.v1', job: 'RQ-X2', id: 'n-1', at: at(1), text: '', by: 'cli' }),
      note('RQ-OK', 1, 3),
      note('RQ-OK', 2, 2),
      note('RQ-OK', 3, 1),
    ].join('\n'), NOW, JOB_NOTES_WINDOW_HOURS * HOUR);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.job).toBe('RQ-OK');
  });

  it('counts unsafe sender tokens only as unrecorded, never as named surfaces', () => {
    const cells = foldJobNotesCells([
      note('RQ-S1', 1, 3, 'cli'),
      note('RQ-S1', 2, 2, 'person@example.com'),
      note('RQ-S1', 3, 1, 'has space'),
    ].join('\n'), NOW, JOB_NOTES_WINDOW_HOURS * HOUR);
    expect(cells[0]!.senders).toBe(2);
  });
});

describe('jobNotesBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'job-notes-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  /** A runs dir holding queue/job-notes.jsonl and optionally metrics/jobs.jsonl. */
  async function runsDir(name: string, notes: string[], jobs: string[] = []): Promise<string> {
    const dir = join(home, name);
    await mkdir(join(dir, 'queue'), { recursive: true });
    await mkdir(join(dir, 'metrics'), { recursive: true });
    await writeFile(join(dir, 'queue', 'job-notes.jsonl'), notes.join('\n') + '\n');
    if (jobs.length > 0) await writeFile(join(dir, 'metrics', 'jobs.jsonl'), jobs.join('\n') + '\n');
    return dir;
  }

  const steeredRows = (job: string, n = 3): string[] =>
    Array.from({ length: n }, (_, i) => note(job, i + 1, i + 1));

  it('emits an item for a job at the recurring bar, with the jobs-ledger outcome attached', async () => {
    const jobs = [
      JSON.stringify({ job: 'RQ-J1', event: 'launch', lane: 'claude', ts: at(6) }),
      JSON.stringify({ job: 'RQ-J1', event: 'finish', state: 'DONE', ts: at(2) }),
      JSON.stringify({ job: 'RQ-J1', event: 'merged', ts: at(1), url: 'https://github.com/ashlrai/phantom/pull/42' }),
    ];
    const dir = await runsDir('runs-merged', steeredRows('RQ-J1'), jobs);
    const items = await jobNotesBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom', area: 'job-notes' });
    expect(item!.id).toMatch(/^fleet-job-notes-[0-9a-f]{16}$/);
    expect(item!.title).toContain('RQ-J1');
    expect(item!.title).toContain('3 steering notes');
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item!.prompt).toContain('merged');
    expect(item!.prompt).toContain('pull/42');
    expect(item!.prompt).toContain('job-notes.jsonl');
    expect(item!.prompt).toContain('phm job notes');
    expect(item!.prompt).toContain('no-change');
    // Note text is free prose and is never quoted into the prompt.
    expect(item!.prompt).not.toContain('note 1');
  });

  it('reports unknown outcome when the jobs ledger has no row for the job', async () => {
    const dir = await runsDir('runs-unknown', steeredRows('RQ-J9'));
    const items = await jobNotesBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('unknown — no jobs-ledger row');
  });

  it('emits only for jobs at the recurring bar', async () => {
    const dir = await runsDir('runs-quiet', [
      note('RQ-Q1', 1, 3),
      note('RQ-Q1', 2, 2),
      note('RQ-Q2', 1, 2),
      note('RQ-Q2', 2, 1),
      note('RQ-Q2', 3, 1),
      note('RQ-Q2', 4, 1),
    ]);
    // RQ-Q1 stays under the bar; RQ-Q2's four recorded notes emit one item.
    const items = await jobNotesBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toContain('RQ-Q2');
    expect(items[0]!.prompt).toContain('4 recorded steering note(s)');
    expect(JOB_NOTES_RECURRING).toBe(3);
    expect(items.length).toBeLessThanOrEqual(JOB_NOTES_MAX_ITEMS);
  });

  it('emits nothing for a missing ledger, an unreadable ledger, or another repository', async () => {
    expect(await jobNotesBacklogItems({ repo: 'ashlrai/phantom', runsDir: join(home, 'no-such'), now: new Date(NOW) })).toEqual([]);

    // A directory where the ledger should be is an unreadable source, never an empty one.
    const bad = join(home, 'runs-bad');
    await mkdir(join(bad, 'queue', 'job-notes.jsonl'), { recursive: true });
    expect(await jobNotesBacklogItems({ repo: 'ashlrai/phantom', runsDir: bad, now: new Date(NOW) })).toEqual([]);

    const dir = await runsDir('runs-repo', steeredRows('RQ-J1'));
    expect(await jobNotesBacklogItems({ repo: 'ashlrai/other', runsDir: dir, now: new Date(NOW) })).toEqual([]);
    expect(await jobNotesBacklogItems({ repo: '', runsDir: dir, now: new Date(NOW) })).toEqual([]);
    expect(await jobNotesBacklogItems({ repo: 'AshlrAI/Phantom', runsDir: dir, now: new Date(NOW) })).toHaveLength(1);
  });

  it('derives stable ids so a refresh re-adds nothing', async () => {
    const dir = await runsDir('runs-stable', steeredRows('RQ-J1'));
    const opts = { repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) };
    const first = await jobNotesBacklogItems(opts);
    const second = await jobNotesBacklogItems(opts);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
  });

  it('appends job-notes items through discovery and dedupes on refresh', async () => {
    const runs = join(home, '.ashlr-runs');
    await mkdir(join(runs, 'queue'), { recursive: true });
    await mkdir(join(runs, 'metrics'), { recursive: true });
    await writeFile(join(runs, 'queue', 'job-notes.jsonl'), [...steeredRows('RQ-J1'), ...steeredRows('RQ-J2')].join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const noteItems = first.items.filter((i) => i.id.startsWith('fleet-job-notes-'));
    expect(noteItems).toHaveLength(2);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(noteItems)).toBe(2);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('fleet-job-notes-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('fleet-job-notes-'))).toHaveLength(2);
  });
});
