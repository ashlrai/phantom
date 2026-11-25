import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BetAuditRow } from '../src/core/fleet/bet-audit.js';
import {
  BET_AUDIT_MAX_ITEMS,
  BET_AUDIT_RECURRING,
  betAuditBacklogItems,
  foldBetAuditCells,
} from '../src/core/improve/bet-audit-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const MIN = 60_000;
const J = (o: Record<string, unknown>): string => JSON.stringify(o);
const NOW = Date.now();

/** out.<YYYYMMDDTHHMM>.txt name stamped `mins` ago (UTC, minute precision). */
function outName(mins: number): string {
  const d = new Date(NOW - mins * MIN);
  const p = (n: number) => String(n).padStart(2, '0');
  return `out.${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}.txt`;
}

const bet = (token: string, repo = 'phantom', lane = 'codex'): string =>
  `BET ${repo} ${lane} work ${token} do the thing`;
const fixup = (token: string, repo = 'phantom'): string =>
  `FIXUP ${repo} ${token} repair the thing`;
const lostRow = (id: string, repo = 'phantom', lane: string | null = 'codex', at = '2026-11-23T10:00:00.000Z'): BetAuditRow =>
  ({ id, repo, lane, issuedAt: at, status: 'lost', url: null });

describe('foldBetAuditCells', () => {
  it('groups lost orders by target repo and tallies kinds and lanes', () => {
    const cells = foldBetAuditCells([
      lostRow('RQ-A1Q8', 'phantom', 'codex', '2026-11-23T08:00:00.000Z'),
      lostRow('RQ-A2Q8', 'phantom', 'codex', '2026-11-23T09:00:00.000Z'),
      lostRow('RQ-FIXUP-B1Q8', 'phantom', null, '2026-11-23T09:30:00.000Z'),
      lostRow('RQ-C1Q8', 'lexicon', 'claude', '2026-11-23T09:45:00.000Z'),
      { ...lostRow('RQ-D1Q8', 'phantom', 'devin'), status: 'merged' },
      { ...lostRow('RQ-E1Q8', 'phantom', 'devin'), status: 'queued' },
    ]);
    expect(cells.map((c) => [c.repo, c.count])).toEqual([
      ['phantom', 3],
      ['lexicon', 1],
    ]);
    const phantom = cells[0]!;
    expect(phantom.kinds).toEqual([{ text: 'BET', count: 2 }, { text: 'FIXUP', count: 1 }]);
    expect(phantom.lanes).toEqual([{ text: 'codex', count: 2 }, { text: 'unrecorded', count: 1 }]);
    expect(phantom.orders).toEqual(['RQ-A1Q8', 'RQ-A2Q8', 'RQ-FIXUP-B1Q8']);
    expect(phantom.firstSeen).toBe('2026-11-23T08:00:00.000Z');
    expect(phantom.lastSeen).toBe('2026-11-23T09:30:00.000Z');
  });

  it('marks unrecorded repos unknown and never quotes unsafe order ids', () => {
    const cells = foldBetAuditCells([
      lostRow('RQ-SAFE1Q8', '  ', null),
      lostRow('bad id\nforged', '', null),
      lostRow('x'.repeat(200), '', null),
    ]);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.repo).toBe('unknown');
    expect(cells[0]!.orders).toEqual(['RQ-SAFE1Q8']);
    expect(cells[0]!.count).toBe(3);
  });

  it('flattens and caps leader-recorded repo and lane text', () => {
    const cells = foldBetAuditCells([
      lostRow('RQ-F1Q8', `repo\n${'r'.repeat(200)}`, `lane\n${'l'.repeat(100)}`),
      lostRow('RQ-F2Q8', `repo\n${'r'.repeat(200)}`, `lane\n${'l'.repeat(100)}`),
      lostRow('RQ-F3Q8', `repo\n${'r'.repeat(200)}`, `lane\n${'l'.repeat(100)}`),
    ]);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.repo.length).toBeLessThanOrEqual(120);
    expect(cells[0]!.repo).not.toContain('\n');
    expect(cells[0]!.lanes[0]!.text.length).toBeLessThanOrEqual(60);
    expect(cells[0]!.lanes[0]!.text).not.toContain('\n');
  });
});

describe('betAuditBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'bet-audit-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  /** A runs dir: supervisor out files, router-queue.md and jobs.jsonl. */
  async function runsDir(name: string, files: {
    orders?: Record<string, string[]>;
    queue?: string | null;
    ledger?: string[] | null;
    degradedSupervisor?: number[];
    degradedQueue?: boolean;
  }): Promise<string> {
    const dir = join(home, name);
    await mkdir(join(dir, 'supervisor'), { recursive: true });
    await mkdir(join(dir, 'queue'), { recursive: true });
    await mkdir(join(dir, 'metrics'), { recursive: true });
    for (const [file, lines] of Object.entries(files.orders ?? {})) {
      await writeFile(join(dir, 'supervisor', outName(Number(file))), lines.join('\n') + '\n');
    }
    for (const mins of files.degradedSupervisor ?? []) {
      await mkdir(join(dir, 'supervisor', outName(mins)), { recursive: true });
    }
    if (files.degradedQueue) {
      await mkdir(join(dir, 'queue', 'router-queue.md'), { recursive: true });
    } else if (files.queue !== undefined && files.queue !== null) {
      await writeFile(join(dir, 'queue', 'router-queue.md'), files.queue);
    }
    if (files.ledger !== undefined && files.ledger !== null) {
      await writeFile(join(dir, 'metrics', 'jobs.jsonl'), files.ledger.join('\n') + '\n');
    }
    return dir;
  }

  const launchRow = (id: string): string => J({ event: 'launch', job: id, ts: new Date(NOW - 30 * MIN).toISOString() });

  it('emits a lost-orders item for a recurring repo cell and validates it', async () => {
    const dir = await runsDir('runs-lost', {
      orders: {
        '60': [bet('ALPHA'), bet('BETA', 'phantom', 'claude')],
        '120': [fixup('GAMMA'), bet('DELTA', 'phantom', 'devin')],
      },
      queue: '# router queue\n- READY RQ-OTHERQ8 (pool=codex): unrelated\n',
      ledger: [launchRow('RQ-OTHERQ8'), 'not json'],
    });
    const items = await betAuditBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom', area: 'lost-orders' });
    expect(item!.id).toMatch(/^fleet-bet-audit-[0-9a-f]{16}$/);
    expect(item!.title).toContain('vanishing');
    expect(item!.title).toContain('phantom');
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item!.prompt).toContain('RQ-ALPHAQ8');
    expect(item!.prompt).toContain("'BET' ×3");
    expect(item!.prompt).toContain("'FIXUP' ×1");
    expect(item!.prompt).toContain('fleet.bet-audit.v1');
    expect(item!.prompt).toContain('no-change');
    expect(item!.prompt).toContain('router-queue.md');
  });

  it('never counts an order the queue or metrics show becoming work', async () => {
    const dir = await runsDir('runs-served', {
      orders: {
        '60': [bet('QUEUEDONE'), bet('LAUNCHEDONE'), bet('MERGEDONE'), bet('LOSTONE')],
      },
      queue: '- READY RQ-QUEUEDONEQ8 (pool=codex): do work\n- CLAIMED RQ-OTHERQ8 (pool=codex): worker=w1\n',
      ledger: [
        launchRow('RQ-LAUNCHEDONEQ8'),
        J({ event: 'outcome', job: 'RQ-MERGEDONEQ8', state: 'MERGED' }),
      ],
    });
    // Only RQ-LOSTONEQ8 is lost — one order stays under the recurring bar.
    expect(await betAuditBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) })).toEqual([]);
  });

  it('emits nothing below the recurring bar, for missing sources, or another repository', async () => {
    const quiet = await runsDir('runs-quiet', {
      orders: { '60': [bet('Q1'), bet('Q2')] },
      queue: '',
      ledger: [],
    });
    expect(await betAuditBacklogItems({ repo: 'ashlrai/phantom', runsDir: quiet, now: new Date(NOW) })).toEqual([]);
    expect(BET_AUDIT_RECURRING).toBe(3);

    const empty = await runsDir('runs-empty', {});
    expect(await betAuditBacklogItems({ repo: 'ashlrai/phantom', runsDir: empty, now: new Date(NOW) })).toEqual([]);
    expect(await betAuditBacklogItems({ repo: 'ashlrai/phantom', runsDir: join(home, 'no-such'), now: new Date(NOW) })).toEqual([]);

    const dir = await runsDir('runs-repo', {
      orders: { '60': [bet('P1'), bet('P2'), bet('P3')] },
      queue: '',
      ledger: [],
    });
    expect(await betAuditBacklogItems({ repo: 'ashlrai/other', runsDir: dir, now: new Date(NOW) })).toEqual([]);
    expect(await betAuditBacklogItems({ repo: 'AshlrAI/Phantom', runsDir: dir, now: new Date(NOW) })).toHaveLength(1);
  });

  it('stays quiet when the jobs ledger is missing or the queue read is degraded', async () => {
    // No metrics/jobs.jsonl: launched orders would read lost — unknown stays unknown.
    const noMetrics = await runsDir('runs-nometrics', {
      orders: { '60': [bet('M1'), bet('M2'), bet('M3')] },
      queue: '',
      ledger: null,
    });
    expect(await betAuditBacklogItems({ repo: 'ashlrai/phantom', runsDir: noMetrics, now: new Date(NOW) })).toEqual([]);

    // router-queue.md that cannot be read can hide READY lines — same fabrication risk.
    const badQueue = await runsDir('runs-badqueue', {
      orders: { '60': [bet('D1'), bet('D2'), bet('D3')] },
      degradedQueue: true,
      ledger: [],
    });
    expect(await betAuditBacklogItems({ repo: 'ashlrai/phantom', runsDir: badQueue, now: new Date(NOW) })).toEqual([]);
  });

  it('a missing queue file is an empty queue, and a degraded supervisor stream only undercounts', async () => {
    const dir = await runsDir('runs-partial', {
      orders: { '60': [bet('S1'), bet('S2'), bet('S3')] },
      degradedSupervisor: [45],
      ledger: [],
    });
    const items = await betAuditBacklogItems({ repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('at least 3 recorded lost order');
    expect(items[0]!.prompt).toContain('fleet.bet-audit.v1');
  });

  it('derives stable ids per repo cell so a refresh re-adds nothing and honours the limit', async () => {
    const dir = await runsDir('runs-stable', {
      orders: {
        '60': [bet('S1'), bet('S2'), bet('S3', 'phantom', 'codex'), bet('S4', 'lexicon'), bet('S5', 'lexicon'), bet('S6', 'lexicon')],
      },
      queue: '',
      ledger: [],
    });
    const opts = { repo: 'ashlrai/phantom', runsDir: dir, now: new Date(NOW) };
    const first = await betAuditBacklogItems(opts);
    const second = await betAuditBacklogItems(opts);
    // lexicon's three losses sort ahead of phantom's on count… equal counts sort by repo name.
    expect(first.map((i) => i.id)).toEqual(second.map((i) => i.id));
    expect(first).toHaveLength(2);
    expect(first.length).toBeLessThanOrEqual(BET_AUDIT_MAX_ITEMS);
    expect(await betAuditBacklogItems({ ...opts, limit: 1 })).toHaveLength(1);
  });

  it('appends bet-audit items through discovery and dedupes on refresh', async () => {
    const runs = join(home, '.ashlr-runs');
    await mkdir(join(runs, 'supervisor'), { recursive: true });
    await mkdir(join(runs, 'queue'), { recursive: true });
    await mkdir(join(runs, 'metrics'), { recursive: true });
    await writeFile(join(runs, 'supervisor', outName(60)), [bet('D1'), bet('D2'), bet('D3')].join('\n') + '\n');
    await writeFile(join(runs, 'metrics', 'jobs.jsonl'), launchRow('RQ-OTHERQ8') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const betItems = first.items.filter((i) => i.id.startsWith('fleet-bet-audit-'));
    expect(betItems).toHaveLength(1);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(betItems)).toBe(1);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('fleet-bet-audit-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('fleet-bet-audit-'))).toHaveLength(1);
  });
});
