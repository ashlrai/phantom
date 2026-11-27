import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  foldOffloadCells,
  NODES_OFFLOAD_MAX_ITEMS,
  NODES_OFFLOAD_MIN_DAYS,
  NODES_OFFLOAD_RECURRING,
  nodesOffloadBacklogItems,
  parseOffloadRows,
  type NodesOffloadAction,
} from '../src/core/improve/nodes-offload-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const SCHEMA = 'phantom.nodes-offload-event.v1';
const NOW = Date.parse('2026-11-23T12:00:00.000Z');
const CUTOFF = NOW - 7 * 24 * 60 * 60 * 1000;
const row = (o: Record<string, unknown>): string => JSON.stringify(o);
const event = (job: string, at: string, reasons: string[] = ['load'], lane = 'devin', to = 'peer-a'): string =>
  row({ schema: SCHEMA, schemaVersion: 1, at, job, lane, from: 'self-node', to, reasons, why: 'host guard held; peer had a free slot' });
const action = (job: string, atMs: number, kind: NodesOffloadAction['kind'] = 'load', lane = 'devin', to = 'peer-a'): NodesOffloadAction =>
  ({ job, kind, lane, to, atMs });

describe('parseOffloadRows', () => {
  it('keeps only schema-valid rows with known hold reasons inside the window', () => {
    const rows = [
      event('RQ-O1', '2026-11-23T10:00:00.000Z'),
      event('RQ-O2', '2026-11-22T10:00:00.000Z', ['load', 'memory']),
      event('RQ-O3', '2026-11-23T10:00:00.000Z', ['memory']),
      // foreign schema / version
      row({ schema: 'other.v1', schemaVersion: 1, at: '2026-11-23T10:00:00.000Z', job: 'RQ-O4', reasons: ['load'] }),
      row({ schema: SCHEMA, schemaVersion: 2, at: '2026-11-23T10:00:00.000Z', job: 'RQ-O5', reasons: ['load'] }),
      // bad job id
      event('bad id!', '2026-11-23T10:00:00.000Z'),
      // empty / unknown / mixed reasons
      row({ schema: SCHEMA, schemaVersion: 1, at: '2026-11-23T10:00:00.000Z', job: 'RQ-O6', reasons: [] }),
      row({ schema: SCHEMA, schemaVersion: 1, at: '2026-11-23T10:00:00.000Z', job: 'RQ-O7', reasons: ['bogus'] }),
      row({ schema: SCHEMA, schemaVersion: 1, at: '2026-11-23T10:00:00.000Z', job: 'RQ-O8', reasons: ['load', 'bogus'] }),
      // outside window / future / no timestamp
      event('RQ-O9', '2026-11-10T10:00:00.000Z'),
      event('RQ-OA', '2026-11-24T10:00:00.000Z'),
      row({ schema: SCHEMA, schemaVersion: 1, job: 'RQ-OB', reasons: ['load'] }),
      'not json at all',
      '',
    ].join('\n');
    const parsed = parseOffloadRows(rows, CUTOFF, NOW);
    expect(parsed.map((a) => [a.job, a.kind])).toEqual([
      ['RQ-O1', 'load'],
      ['RQ-O2', 'load+memory'],
      ['RQ-O3', 'memory'],
    ]);
    expect(parsed[0]!.lane).toBe('devin');
    expect(parsed[0]!.to).toBe('peer-a');
    expect(parsed[0]!.atMs).toBe(Date.parse('2026-11-23T10:00:00.000Z'));
  });

  it('marks missing lane and destination unknown rather than guessing', () => {
    const rows = [
      row({ schema: SCHEMA, schemaVersion: 1, at: '2026-11-23T10:00:00.000Z', job: 'RQ-O1', reasons: ['load'] }),
      row({ schema: SCHEMA, schemaVersion: 1, at: '2026-11-23T10:00:00.000Z', job: 'RQ-O2', lane: '  ', to: '', reasons: ['load'] }),
    ].join('\n');
    const parsed = parseOffloadRows(rows, CUTOFF, NOW);
    expect(parsed).toHaveLength(2);
    expect(parsed.every((a) => a.lane === 'unknown' && a.to === 'unknown')).toBe(true);
  });
});

describe('foldOffloadCells', () => {
  const T0 = Date.parse('2026-11-23T08:00:00.000Z');
  const DAY = 24 * 60 * 60 * 1000;

  it('groups by hold kind, counts distinct jobs and keeps recorded tallies', () => {
    const cells = foldOffloadCells([
      action('RQ-O1', T0),
      action('RQ-O2', T0 + 60_000, 'load', 'claude', 'peer-b'),
      action('RQ-O1', T0 + 120_000, 'load', 'claude', 'peer-b'), // same job twice: first record wins
      action('RQ-O3', T0 - DAY, 'memory', 'devin', 'peer-a'),
      action('RQ-O4', T0 - DAY + 60_000, 'load+memory', 'local-model', 'peer-c'),
    ]);
    expect(cells.map((c) => [c.kind, c.count, c.days])).toEqual([
      ['load', 2, 1],
      ['load+memory', 1, 1],
      ['memory', 1, 1],
    ]);
    const load = cells[0]!;
    expect(load.jobs).toEqual(['RQ-O1', 'RQ-O2']);
    expect(load.lanes).toEqual([{ text: 'claude', count: 1 }, { text: 'devin', count: 1 }]);
    expect(load.nodes).toEqual([{ text: 'peer-a', count: 1 }, { text: 'peer-b', count: 1 }]);
    expect(load.firstSeen).toBe(new Date(T0).toISOString());
    expect(load.lastSeen).toBe(new Date(T0 + 60_000).toISOString());
    expect(load.lowerBound).toBe(false);
  });

  it('spans days across a kind when its jobs land on different UTC dates', () => {
    const cells = foldOffloadCells([
      action('RQ-O1', T0),
      action('RQ-O2', T0 + DAY),
      action('RQ-O3', T0 + 2 * DAY),
    ]);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.count).toBe(3);
    expect(cells[0]!.days).toBe(3);
  });
});

describe('nodesOffloadBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };
  const NOW_MS = Date.now();
  const iso = (minAgo: number): string => new Date(NOW_MS - minAgo * 60_000).toISOString();

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'nodes-offload-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  /** A scratch journal: rows at explicit paths or the default ~/.ashlr location. */
  async function journal(name: string, rows: string[], opts: { ashlr?: boolean } = {}): Promise<string> {
    const dir = opts.ashlr === true ? join(home, '.ashlr') : join(home, name);
    await mkdir(dir, { recursive: true });
    const path = join(dir, 'nodes-offload-events.jsonl');
    await writeFile(path, rows.join('\n') + '\n');
    return path;
  }
  const move = (job: string, min: number, reasons: string[] = ['load'], lane = 'devin', to = 'peer-a'): string =>
    event(job, iso(min), reasons, lane, to);

  it('emits a load-hold item for a recurring cell spanning two UTC days', async () => {
    // 60 and 120 min ago share a day with high probability; 2000 min ago is >24h from both, guaranteeing a second UTC day.
    const path = await journal('j1', [
      move('RQ-O1', 60), move('RQ-O2', 120, ['load'], 'claude', 'peer-b'), move('RQ-O3', 2000, ['load'], 'devin', 'peer-a'),
      move('RQ-O9', 30, ['memory'], 'devin', 'peer-a'), // lone memory row: under the bar
    ]);
    const items = await nodesOffloadBacklogItems({ repo: 'ashlrai/phantom', eventsPath: path, now: new Date(NOW_MS) });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom', area: 'nodes-offload' });
    expect(item!.id).toMatch(/^fleet-nodes-offload-[0-9a-f]{16}$/);
    expect(item!.title).toContain('load holds');
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item!.prompt).toContain('RQ-O1');
    expect(item!.prompt).toContain('peer-b');
    expect(item!.prompt).toContain('nodes-offload-events.jsonl');
    expect(item!.prompt).toContain('no-change');
    expect(item!.prompt).not.toContain('RQ-O9');
  });

  it('keeps the hold kinds in separate cells', async () => {
    const path = await journal('j2', [
      move('RQ-L1', 60), move('RQ-L2', 120), move('RQ-L3', 2000),
      move('RQ-M1', 60, ['memory']), move('RQ-M2', 120, ['memory']), move('RQ-M3', 2000, ['memory']),
      move('RQ-B1', 60, ['load', 'memory']), move('RQ-B2', 120, ['load', 'memory']), move('RQ-B3', 2000, ['load', 'memory']),
    ]);
    const items = await nodesOffloadBacklogItems({ repo: 'ashlrai/phantom', eventsPath: path, now: new Date(NOW_MS) });
    expect(items.map((i) => i.title)).toEqual([
      'Offloaded jobs keep leaving this host on load holds',
      'Offloaded jobs keep leaving this host on load and memory holds',
      'Offloaded jobs keep leaving this host on memory-gate holds',
    ]);
    expect(new Set(items.map((i) => i.id)).size).toBe(3);
    const both = items.find((i) => i.title.includes('load and memory'))!;
    const load = items.find((i) => i.title === 'Offloaded jobs keep leaving this host on load holds')!;
    const memory = items.find((i) => i.title.includes('memory-gate'))!;
    expect(both.prompt).toContain('both the load verdict and the memory gate');
    expect(load.prompt).toContain('launch guard');
    expect(memory.prompt).toContain('engine-admission memory gate');
  });

  it('emits nothing below the recurring bars of distinct jobs and days', async () => {
    // Three load rows but only two distinct jobs — under the job bar.
    const thinJobs = await journal('j3a', [move('RQ-O1', 60), move('RQ-O1', 120), move('RQ-O2', 2000)]);
    expect(await nodesOffloadBacklogItems({ repo: 'ashlrai/phantom', eventsPath: thinJobs, now: new Date(NOW_MS) })).toEqual([]);
    // Three distinct jobs all inside one UTC day — under the day bar. Fixed timestamps guarantee one day.
    const sameDay = await journal('j3b', [
      event('RQ-D1', '2026-11-23T01:00:00.000Z'), event('RQ-D2', '2026-11-23T05:00:00.000Z'), event('RQ-D3', '2026-11-23T09:00:00.000Z'),
    ]);
    expect(await nodesOffloadBacklogItems({ repo: 'ashlrai/phantom', eventsPath: sameDay, now: new Date('2026-11-23T12:00:00.000Z') })).toEqual([]);
    expect(NODES_OFFLOAD_RECURRING).toBe(3);
    expect(NODES_OFFLOAD_MIN_DAYS).toBe(2);
  });

  it('emits nothing for a missing journal, another repository, or empty evidence', async () => {
    expect(await nodesOffloadBacklogItems({ repo: 'ashlrai/phantom', eventsPath: join(home, 'no-such.jsonl'), now: new Date(NOW_MS) })).toEqual([]);
    const path = await journal('j4', [move('RQ-O1', 60), move('RQ-O2', 120), move('RQ-O3', 2000)]);
    expect(await nodesOffloadBacklogItems({ repo: 'ashlrai/other', eventsPath: path, now: new Date(NOW_MS) })).toEqual([]);
    expect(await nodesOffloadBacklogItems({ repo: 'AshlrAI/Phantom', eventsPath: path, now: new Date(NOW_MS) })).toHaveLength(1);
  });

  it('reads the default journal under ~/.ashlr when no override is given', async () => {
    await journal('ignored', [], { ashlr: true });
    const ashlrDir = join(home, '.ashlr');
    await writeFile(join(ashlrDir, 'nodes-offload-events.jsonl'),
      [move('RQ-A1', 60), move('RQ-A2', 120), move('RQ-A3', 2000)].join('\n') + '\n');
    const items = await nodesOffloadBacklogItems({ repo: 'ashlrai/phantom', now: new Date(NOW_MS) });
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toContain('load holds');
  });

  it('states truncation as a lower bound in the prompt', async () => {
    const path = await journal('j5', [move('RQ-O1', 60), move('RQ-O2', 120), move('RQ-O3', 2000)]);
    const pad = 'x'.repeat(600 * 1024);
    await writeFile(path, pad + '\n' + [move('RQ-O1', 60), move('RQ-O2', 120), move('RQ-O3', 2000)].join('\n') + '\n');
    const items = await nodesOffloadBacklogItems({ repo: 'ashlrai/phantom', eventsPath: path, now: new Date(NOW_MS) });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('lower bound');
  });

  it('derives stable ids so a refresh re-adds nothing and honours the limit', async () => {
    const path = await journal('j6', [move('RQ-O1', 60), move('RQ-O2', 120), move('RQ-O3', 2000)]);
    const opts = { repo: 'ashlrai/phantom', eventsPath: path, now: new Date(NOW_MS) };
    const first = await nodesOffloadBacklogItems(opts);
    const second = await nodesOffloadBacklogItems(opts);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    expect(first.length).toBeLessThanOrEqual(NODES_OFFLOAD_MAX_ITEMS);
  });

  it('appends offload items through discovery and dedupes on refresh', async () => {
    const ashlrDir = join(home, '.ashlr');
    await mkdir(ashlrDir, { recursive: true });
    await writeFile(join(ashlrDir, 'nodes-offload-events.jsonl'),
      [move('RQ-D1', 60), move('RQ-D2', 120), move('RQ-D3', 2000)].join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const offloadItems = first.items.filter((i) => i.id.startsWith('fleet-nodes-offload-'));
    expect(offloadItems).toHaveLength(1);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(offloadItems)).toBe(1);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('fleet-nodes-offload-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('fleet-nodes-offload-'))).toHaveLength(1);
  });
});
