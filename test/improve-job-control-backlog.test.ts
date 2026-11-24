import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  foldJobControlJournal,
  JOB_CONTROL_BACKLOG_MAX_ITEMS,
  JOB_CONTROL_MIN_DAYS,
  JOB_CONTROL_MIN_JOBS,
  JOB_CONTROL_MIN_UNACKED,
  jobControlBacklogItems,
  jobControlCells,
} from '../src/core/improve/job-control-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';
import { JOB_CONTROL_FILE, JOB_CONTROL_SCHEMA } from '../src/core/fleet/job-control-types.js';

const MIN = 60_000;
const DAY = 24 * 60 * MIN;
const J = (o: Record<string, unknown>): string => JSON.stringify(o);
const SCHEMA = JOB_CONTROL_SCHEMA;

/** A request row the way requestJobControl writes it. */
const req = (requestId: string, action: string, job: string, at: string, extra: Record<string, unknown> = {}): string =>
  J({ schema: SCHEMA, requestId, at, action, job, lane: null, status: 'requested', by: 'test', ...extra });
/** An acknowledgement row the way the dispatcher contract expects it. */
const ack = (requestId: string, status: string, at: string, extra: Record<string, unknown> = {}): string =>
  J({ schema: SCHEMA, requestId, status, at, ...extra });

describe('foldJobControlJournal', () => {
  const NOW = Date.parse('2026-11-23T12:00:00.000Z');
  const WINDOW = 7 * DAY;

  it('folds request and acknowledgement rows per requestId, the last status winning', () => {
    const text = [
      req('jc-1', 'pause', 'RQ-A1', '2026-11-23T10:00:00.000Z'),
      req('jc-2', 'move', 'RQ-A2', '2026-11-23T10:05:00.000Z', { lane: 'claude', status: 'applied' }),
      ack('jc-1', 'applied', '2026-11-23T10:01:00.000Z'),
      req('jc-3', 'stop', 'RQ-A3', '2026-11-22T09:00:00.000Z'),
      ack('jc-3', 'refused', '2026-11-22T09:30:00.000Z', { reason: 'Job is not running.' }),
      'not json at all',
      '',
      J({ requestId: 'jc-orphan', status: 'applied', at: '2026-11-23T11:00:00.000Z' }), // ack before any request row: never forms a request
    ].join('\n');
    const fold = foldJobControlJournal(text, NOW, WINDOW);
    expect(fold.invalidRows).toBe(2); // the non-JSON line and the orphan ack
    expect(fold.undated).toBe(0);
    const byId = new Map(fold.requests.map((r) => [r.requestId, r]));
    expect(byId.get('jc-1')).toMatchObject({ action: 'pause', job: 'RQ-A1', status: 'applied', atMs: Date.parse('2026-11-23T10:00:00.000Z') });
    expect(byId.get('jc-2')).toMatchObject({ action: 'move', job: 'RQ-A2', lane: 'claude', status: 'applied' });
    expect(byId.get('jc-3')).toMatchObject({ action: 'stop', job: 'RQ-A3', status: 'refused', reason: 'Job is not running.' });
  });

  it('keeps only in-window requests and counts the rest honestly', () => {
    const text = [
      req('jc-old', 'pause', 'RQ-A1', '2026-11-01T10:00:00.000Z'), // outside the 7-day window
      req('jc-future', 'pause', 'RQ-A2', '2026-11-24T10:00:00.000Z'), // beyond the skew allowance
      req('jc-undated', 'pause', 'RQ-A3', 'not a timestamp'),
      req('jc-ok', 'resume', 'RQ-A4', '2026-11-23T10:00:00.000Z'),
      J({ schema: SCHEMA, requestId: 'jc-bad', at: '2026-11-23T10:00:00.000Z', action: 'teleport', job: 'RQ-A5', status: 'requested' }),
      J({ schema: SCHEMA, requestId: 'jc-nostatus', at: '2026-11-23T10:00:00.000Z', action: 'pause', job: 'RQ-A6' }),
    ].join('\n');
    const fold = foldJobControlJournal(text, NOW, WINDOW);
    expect(fold.requests.map((r) => r.requestId)).toEqual(['jc-ok']);
    expect(fold.undated).toBe(1);
    expect(fold.invalidRows).toBe(2);
  });

  it('a request row written already applied never counts as unacknowledged', () => {
    const text = [req('jc-1', 'stop', 'RQ-A1', '2026-11-23T10:00:00.000Z', { status: 'applied' })].join('\n');
    const fold = foldJobControlJournal(text, NOW, WINDOW);
    expect(fold.requests[0]!.status).toBe('applied');
    expect(jobControlCells(fold)).toEqual([]);
  });
});

describe('jobControlCells', () => {
  const NOW = Date.parse('2026-11-23T12:00:00.000Z');
  const WINDOW = 7 * DAY;
  const d = (dayOffset: number, hour = 10): string => new Date(Date.UTC(2026, 10, 23 - dayOffset, hour)).toISOString();

  const unacked = (id: string, job: string, at: string, action = 'pause', by = 'cli'): string => req(id, action, job, at, { by });

  it('emits the unacked cell only at the recurring bars', () => {
    // Below the request bar.
    expect(jobControlCells(foldJobControlJournal([
      unacked('jc-1', 'RQ-A1', d(0)), unacked('jc-2', 'RQ-A2', d(1)),
    ].join('\n'), NOW, WINDOW))).toEqual([]);
    // Below the distinct-jobs bar: three requests, one job, two days.
    expect(jobControlCells(foldJobControlJournal([
      unacked('jc-1', 'RQ-A1', d(0)), unacked('jc-2', 'RQ-A1', d(1)), unacked('jc-3', 'RQ-A1', d(2)),
    ].join('\n'), NOW, WINDOW))).toEqual([]);
    // Below the distinct-days bar: three requests, two jobs, one day.
    expect(jobControlCells(foldJobControlJournal([
      unacked('jc-1', 'RQ-A1', d(0, 8)), unacked('jc-2', 'RQ-A2', d(0, 9)), unacked('jc-3', 'RQ-A1', d(0, 10)),
    ].join('\n'), NOW, WINDOW))).toEqual([]);
    expect(JOB_CONTROL_MIN_UNACKED).toBe(3);
    expect(JOB_CONTROL_MIN_JOBS).toBe(2);
    expect(JOB_CONTROL_MIN_DAYS).toBe(2);
  });

  it('emits one cell with tallies, examples and terminal-status context', () => {
    const text = [
      unacked('jc-1', 'RQ-A1', d(0), 'pause', 'cli'),
      unacked('jc-2', 'RQ-A2', d(1), 'move', 'desktop'),
      unacked('jc-3', 'RQ-A3', d(2), 'pause', 'mobile'),
      unacked('jc-4', 'RQ-A1', d(3), 'resume', 'cli'),
      req('jc-5', 'stop', 'RQ-A9', d(0), { status: 'applied' }),
      req('jc-6', 'stop', 'RQ-A8', d(1), { status: 'applied' }),
      ack('jc-7', 'refused', d(1)), // orphan ack: no request row, ignored
    ].join('\n');
    const cells = jobControlCells(foldJobControlJournal(text, NOW, WINDOW));
    expect(cells).toHaveLength(1);
    const cell = cells[0]!;
    expect(cell.kind).toBe('unacked');
    expect(cell.requests).toBe(4);
    expect(cell.jobs).toBe(3);
    expect(cell.days).toEqual(['2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23']);
    expect(cell.actions).toEqual([['pause', 2], ['move', 1], ['resume', 1]]);
    expect(cell.surfaces).toEqual([['cli', 2], ['desktop', 1], ['mobile', 1]]);
    expect(cell.examples).toEqual(['RQ-A1', 'RQ-A2', 'RQ-A3']);
    expect(cell.applied).toBe(2);
    expect(cell.refused).toBe(0);
    expect(cell.firstSeen).toBe('2026-11-20T10:00:00.000Z');
    expect(cell.lastSeen).toBe('2026-11-23T10:00:00.000Z');
    expect(cell.lowerBound).toBe(false);
  });

  it('never quotes job ids outside the fleet id shape', () => {
    const text = [
      unacked('jc-1', 'bad id!', d(0)),
      unacked('jc-2', 'RQ-A2', d(1)),
      unacked('jc-3', 'also bad', d(2)),
    ].join('\n');
    const cells = jobControlCells(foldJobControlJournal(text, NOW, WINDOW));
    expect(cells).toHaveLength(1);
    expect(cells[0]!.examples).toEqual(['RQ-A2']);
    expect(cells[0]!.jobs).toBe(3); // the count is honest even when examples are not
  });
});

describe('jobControlBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };
  const NOW = Date.now();
  const isoDaysAgo = (days: number, minAgo = 0): string => new Date(NOW - days * DAY - minAgo * MIN).toISOString();

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'job-control-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  /** A runs dir holding the steering ledger. */
  async function runsDir(name: string, lines?: string[]): Promise<string> {
    const dir = join(home, name);
    await mkdir(join(dir, 'queue'), { recursive: true });
    if (lines !== undefined) await writeFile(join(dir, JOB_CONTROL_FILE), lines.join('\n') + '\n');
    return dir;
  }

  const unackedRow = (id: string, job: string, daysAgo: number, action = 'pause'): string =>
    req(id, action, job, isoDaysAgo(daysAgo), { by: 'cli' });

  it('emits one validated item for recurring unacknowledged requests', async () => {
    const dir = await runsDir('runs-hit', [
      unackedRow('jc-1', 'RQ-A1', 0), unackedRow('jc-2', 'RQ-A2', 1, 'move'),
      unackedRow('jc-3', 'RQ-A3', 2, 'resume'), unackedRow('jc-4', 'RQ-A1', 3, 'stop'),
      req('jc-5', 'stop', 'RQ-A9', isoDaysAgo(0), { status: 'applied' }),
    ]);
    const items = await jobControlBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: NOW });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom', area: 'job-control' });
    expect(item!.id).toMatch(/^fleet-job-control-[0-9a-f]{16}$/);
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item!.title).toContain('never acknowledged');
    expect(item!.prompt).toContain('RQ-A1');
    expect(item!.prompt).toContain('job-control.jsonl');
    expect(item!.prompt).toContain("'requested'");
    expect(item!.prompt).toContain('no-change');
    expect(item!.prompt).toContain(JOB_CONTROL_FILE);
  });

  it('emits nothing for missing ledgers, empty evidence, another repository, or sub-bar evidence', async () => {
    expect(await jobControlBacklogItems({ repo: 'ashlrai/phantom', runsDir: join(home, 'no-such'), now: NOW })).toEqual([]);
    expect(await jobControlBacklogItems({ repo: 'ashlrai/phantom', runsDir: await runsDir('runs-empty'), now: NOW })).toEqual([]);

    const thin = await runsDir('runs-thin', [unackedRow('jc-1', 'RQ-A1', 0), unackedRow('jc-2', 'RQ-A2', 1)]);
    expect(await jobControlBacklogItems({ repo: 'ashlrai/phantom', runsDir: thin, now: NOW })).toEqual([]);

    const dir = await runsDir('runs-repo', [
      unackedRow('jc-1', 'RQ-A1', 0), unackedRow('jc-2', 'RQ-A2', 1), unackedRow('jc-3', 'RQ-A3', 2),
    ]);
    expect(await jobControlBacklogItems({ repo: 'ashlrai/other', runsDir: dir, now: NOW })).toEqual([]);
    expect(await jobControlBacklogItems({ repo: 'AshlrAI/Phantom', runsDir: dir, now: NOW })).toHaveLength(1);
  });

  it('acknowledged requests never count — only standing requested rows emit', async () => {
    const dir = await runsDir('runs-acked', [
      req('jc-1', 'pause', 'RQ-A1', isoDaysAgo(0)), ack('jc-1', 'applied', isoDaysAgo(0)),
      req('jc-2', 'pause', 'RQ-A2', isoDaysAgo(1)), ack('jc-2', 'refused', isoDaysAgo(1), { reason: 'Job is not running.' }),
      req('jc-3', 'pause', 'RQ-A3', isoDaysAgo(2)), ack('jc-3', 'applied', isoDaysAgo(2)),
    ]);
    expect(await jobControlBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: NOW })).toEqual([]);
  });

  it('states truncation as a lower bound in the prompt', async () => {
    const dir = await runsDir('runs-trunc', [
      unackedRow('jc-1', 'RQ-A1', 0), unackedRow('jc-2', 'RQ-A2', 1), unackedRow('jc-3', 'RQ-A3', 2),
    ]);
    const pad = 'x'.repeat(600 * 1024);
    await writeFile(join(dir, JOB_CONTROL_FILE), pad + '\n' + [
      unackedRow('jc-1', 'RQ-A1', 0), unackedRow('jc-2', 'RQ-A2', 1), unackedRow('jc-3', 'RQ-A3', 2),
    ].join('\n') + '\n');
    const items = await jobControlBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('lower bound');
  });

  it('derives stable ids so a refresh re-adds nothing and honours the limit', async () => {
    const dir = await runsDir('runs-stable', [
      unackedRow('jc-1', 'RQ-A1', 0), unackedRow('jc-2', 'RQ-A2', 1), unackedRow('jc-3', 'RQ-A3', 2),
    ]);
    const opts = { repo: 'ashlrai/phantom', runsDir: dir, now: NOW };
    const first = await jobControlBacklogItems(opts);
    const second = await jobControlBacklogItems(opts);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    expect(first.length).toBeLessThanOrEqual(JOB_CONTROL_BACKLOG_MAX_ITEMS);
  });

  it('appends job-control items through discovery and dedupes on refresh', async () => {
    const runs = join(home, '.ashlr-runs');
    await mkdir(join(runs, 'queue'), { recursive: true });
    await writeFile(join(runs, JOB_CONTROL_FILE), [
      unackedRow('jc-1', 'RQ-D1', 0), unackedRow('jc-2', 'RQ-D2', 1), unackedRow('jc-3', 'RQ-D3', 2),
    ].join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const controlItems = first.items.filter((i) => i.id.startsWith('fleet-job-control-'));
    expect(controlItems).toHaveLength(1);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(controlItems)).toBe(1);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('fleet-job-control-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('fleet-job-control-'))).toHaveLength(1);
  });
});
