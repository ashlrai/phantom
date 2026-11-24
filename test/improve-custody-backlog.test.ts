import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CUSTODY_BACKLOG_MAX_ITEMS,
  CUSTODY_MIN_DAYS,
  CUSTODY_MIN_ROWS,
  CUSTODY_WINDOW_MS,
  custodyBacklogItems,
  foldCustodyCells,
  parseCustodySpawnLine,
  parseCustodySpawnRows,
  type CustodySpawnRow,
} from '../src/core/improve/custody-backlog.js';
import { custodyLedgerPath } from '../src/core/run/custody-ledger.js';
import type { UnwrappedReason } from '../src/core/run/phantom-custody.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const J = (o: Record<string, unknown>): string => JSON.stringify(o);

const NOW = Date.parse('2026-11-24T15:00:00.000Z');
const CUTOFF = NOW - CUSTODY_WINDOW_MS;

/** A custody row the way appendCustodyRecord writes it. */
const spawnRow = (
  engine: string,
  atMs: number,
  verdict: { wrapped: true } | { wrapped: false; reason: UnwrappedReason },
): CustodySpawnRow => ({
  atMs,
  utcDay: new Date(atMs).toISOString().slice(0, 10),
  engine,
  wrapped: verdict.wrapped,
  reason: verdict.wrapped ? null : verdict.reason,
});

const line = (
  engine: string,
  atMs: number,
  verdict: { wrapped: true } | { wrapped: false; reason: string },
  extra: Record<string, unknown> = {},
): string =>
  J({
    schema: 1,
    at: new Date(atMs).toISOString(),
    wrapped: verdict.wrapped,
    ...(verdict.wrapped ? {} : { reason: verdict.reason }),
    engine,
    preflight_exit: null,
    ...extra,
  });

describe('parseCustodySpawnLine', () => {
  it('accepts writer-contract wrapped and unwrapped rows', () => {
    const wrapped = parseCustodySpawnLine(line('aider', NOW - MIN, { wrapped: true }));
    expect(wrapped).toMatchObject({ engine: 'aider', wrapped: true, reason: null });
    expect(wrapped!.atMs).toBe(NOW - MIN);
    expect(wrapped!.utcDay).toBe('2026-11-24');

    const unwrapped = parseCustodySpawnLine(line('aider', NOW - 2 * MIN, { wrapped: false, reason: 'worktree-namespace' }));
    expect(unwrapped).toMatchObject({ engine: 'aider', wrapped: false, reason: 'worktree-namespace' });
  });

  it('rejects rows off the writer contract', () => {
    const bad = [
      'not json at all',
      J({ schema: 2, at: new Date(NOW).toISOString(), wrapped: true, engine: 'aider', preflight_exit: null }),
      J({ schema: 1, at: 'not-a-date', wrapped: true, engine: 'aider', preflight_exit: null }),
      J({ schema: 1, at: new Date(NOW).toISOString(), wrapped: 'yes', engine: 'aider', preflight_exit: null }),
      J({ schema: 1, at: new Date(NOW).toISOString(), wrapped: true, engine: 'bad engine!', preflight_exit: null }),
      J({ schema: 1, at: new Date(NOW).toISOString(), wrapped: true, engine: 'aider' }), // no preflight_exit
      J({ schema: 1, at: new Date(NOW).toISOString(), wrapped: true, engine: 'aider', preflight_exit: 1.5 }),
      J({ schema: 1, at: new Date(NOW).toISOString(), wrapped: true, engine: 'aider', preflight_exit: 300 }),
      J({ schema: 1, at: new Date(NOW).toISOString(), wrapped: false, reason: 'made-up', engine: 'aider', preflight_exit: null }),
      J({ schema: 1, at: new Date(NOW).toISOString(), wrapped: false, engine: 'aider', preflight_exit: null }), // no reason
      '[]',
      '',
    ];
    for (const text of bad) expect(parseCustodySpawnLine(text)).toBeNull();
  });

  it('ignores extra fields for forward compatibility', () => {
    const row = parseCustodySpawnLine(line('aider', NOW - MIN, { wrapped: true }, { future: 'field' }));
    expect(row).not.toBeNull();
    expect(row!.engine).toBe('aider');
  });
});

describe('parseCustodySpawnRows', () => {
  it('keeps in-window contract rows and counts the rest', () => {
    const text = [
      line('aider', NOW - MIN, { wrapped: false, reason: 'not-initialized' }),
      line('aider', NOW - 2 * MIN, { wrapped: true }),
      line('aider', NOW - CUSTODY_WINDOW_MS - MIN, { wrapped: false, reason: 'not-initialized' }), // outside window
      line('aider', NOW + MIN, { wrapped: false, reason: 'not-initialized' }), // future
      'garbage',
      J({ schema: 9, at: new Date(NOW).toISOString(), wrapped: true, engine: 'aider', preflight_exit: null }),
      '',
    ].join('\n');
    const parsed = parseCustodySpawnRows(text, CUTOFF, NOW);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.invalid).toBe(2);
  });
});

describe('foldCustodyCells', () => {
  const T_OLD = NOW - 2 * DAY - 2 * HOUR; // 2026-11-22
  const T_NEW = NOW - DAY - 3 * HOUR; // 2026-11-23

  it('groups adverse rows by (engine, reason) and tracks day spread', () => {
    const cells = foldCustodyCells([
      spawnRow('aider', T_OLD, { wrapped: false, reason: 'not-initialized' }),
      spawnRow('aider', T_OLD + HOUR, { wrapped: false, reason: 'not-initialized' }),
      spawnRow('aider', T_NEW, { wrapped: false, reason: 'not-initialized' }),
      spawnRow('aider', T_NEW, { wrapped: false, reason: 'worktree-namespace' }),
      spawnRow('claude', T_NEW, { wrapped: false, reason: 'not-initialized' }),
      spawnRow('aider', T_NEW, { wrapped: true }),
    ]);
    expect(cells.map((c) => [c.engine, c.reason, c.rows, c.days])).toEqual([
      ['aider', 'not-initialized', 3, 2],
      ['aider', 'worktree-namespace', 1, 1],
      ['claude', 'not-initialized', 1, 1],
    ]);
    const aider = cells[0]!;
    // engineSpawns counts every validated row for the engine: 3 adverse
    // not-initialized + 1 adverse worktree + 1 wrapped = 5; wrapped = 1.
    expect(aider.engineSpawns).toBe(5);
    expect(aider.engineWrapped).toBe(1);
    expect(aider.firstSeen).toBe(new Date(T_OLD).toISOString());
    expect(aider.lastSeen).toBe(new Date(T_NEW).toISOString());
  });

  it('never forms cells for by-design verdicts but counts them in engine totals', () => {
    const cells = foldCustodyCells([
      spawnRow('claude', T_OLD, { wrapped: false, reason: 'self-authenticating-engine' }),
      spawnRow('claude', T_NEW, { wrapped: false, reason: 'self-authenticating-engine' }),
      spawnRow('aider', T_OLD, { wrapped: false, reason: 'phantom-disabled' }),
      spawnRow('aider', T_NEW, { wrapped: false, reason: 'phantom-disabled' }),
      spawnRow('aider', T_NEW, { wrapped: false, reason: 'phantom-disabled' }),
      spawnRow('aider', T_NEW, { wrapped: true }),
    ]);
    expect(cells).toEqual([]);
    // Totals are only observable through a cell's engineSpawns; fold a
    // second adverse row set to prove the by-design rows counted there.
    const withAdverse = foldCustodyCells([
      spawnRow('aider', T_OLD, { wrapped: false, reason: 'phantom-disabled' }),
      spawnRow('aider', T_OLD + HOUR, { wrapped: false, reason: 'not-initialized' }),
      spawnRow('aider', T_NEW, { wrapped: false, reason: 'not-initialized' }),
      spawnRow('aider', T_NEW + HOUR, { wrapped: false, reason: 'not-initialized' }),
      spawnRow('aider', T_NEW + 2 * HOUR, { wrapped: true }),
    ]);
    expect(withAdverse).toHaveLength(1);
    expect(withAdverse[0]!.engineSpawns).toBe(5);
    expect(withAdverse[0]!.engineWrapped).toBe(1);
  });

  it('marks truncation as a lower bound', () => {
    const cells = foldCustodyCells(
      [spawnRow('aider', T_OLD, { wrapped: false, reason: 'unknown' })],
      true,
    );
    expect(cells[0]!.lowerBound).toBe(true);
  });
});

describe('custodyBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string };
  const iso = (minAgo: number): string => new Date(NOW - minAgo * MIN).toISOString();

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME };
    home = await mkdtemp(join(tmpdir(), 'custody-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  /** A custody ledger: the live file plus an optional rotated .1 generation. */
  async function ledger(name: string, files: { live?: string[]; rotated?: string[] }): Promise<string> {
    const path = join(home, name, 'spawns.jsonl');
    await mkdir(dirname(path), { recursive: true });
    if (files.live !== undefined) await writeFile(path, files.live.join('\n') + '\n');
    if (files.rotated !== undefined) await writeFile(`${path}.1`, files.rotated.join('\n') + '\n');
    return path;
  }
  /** ms-ago convenience: adverse()/wrapped() take a duration before NOW. */
  const adverse = (engine: string, msAgo: number, reason: string): string =>
    line(engine, NOW - msAgo, { wrapped: false, reason });
  const wrapped = (engine: string, msAgo: number): string =>
    line(engine, NOW - msAgo, { wrapped: true });

  it('emits a custody item for a recurring (engine, reason) cell and validates it', async () => {
    // Two adverse rows on 2026-11-22, one on 2026-11-23 — across two UTC days.
    const path = await ledger('custody-a', {
      live: [
        adverse('aider', 2 * DAY + 2 * HOUR, 'not-initialized'),
        adverse('aider', 2 * DAY + HOUR, 'not-initialized'),
        adverse('aider', DAY + 3 * HOUR, 'not-initialized'),
        wrapped('aider', DAY),
      ],
    });
    const items = await custodyBacklogItems({ repo: 'ashlrai/phantom', ledgerPath: path, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    const [item] = items;
    expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom', area: 'custody' });
    expect(item!.id).toMatch(/^fleet-custody-[0-9a-f]{16}$/);
    expect(item!.title).toContain('aider');
    expect(item!.title).toContain('not-initialized');
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item!.prompt).toContain('spawns.jsonl');
    expect(item!.prompt).toContain('not-initialized');
    expect(item!.prompt).toContain('3 of 4 recorded in-window spawns');
    expect(item!.prompt).toContain('no-change');
    expect(item!.prompt).toContain('.phantom.toml');
  });

  it('emits nothing below the recurring bars of rows and days', async () => {
    // Three rows but all on one UTC day — under the day bar.
    const oneDay = await ledger('custody-b', {
      live: [
        adverse('aider', 2 * HOUR, 'unknown'),
        adverse('aider', HOUR, 'unknown'),
        adverse('aider', 30 * MIN, 'unknown'),
      ],
    });
    expect(await custodyBacklogItems({ repo: 'ashlrai/phantom', ledgerPath: oneDay, now: new Date(NOW) })).toEqual([]);

    // Two rows across two days — under the row bar.
    const twoRows = await ledger('custody-c', {
      live: [
        adverse('aider', 2 * DAY, 'unknown'),
        adverse('aider', DAY, 'unknown'),
      ],
    });
    expect(await custodyBacklogItems({ repo: 'ashlrai/phantom', ledgerPath: twoRows, now: new Date(NOW) })).toEqual([]);
    expect(CUSTODY_MIN_ROWS).toBe(3);
    expect(CUSTODY_MIN_DAYS).toBe(2);
  });

  it('never emits for by-design verdicts even when recurring', async () => {
    const path = await ledger('custody-d', {
      live: [
        line('claude', NOW - 2 * DAY, { wrapped: false, reason: 'self-authenticating-engine' }),
        line('claude', NOW - 2 * DAY + HOUR, { wrapped: false, reason: 'self-authenticating-engine' }),
        line('claude', NOW - DAY, { wrapped: false, reason: 'self-authenticating-engine' }),
        line('aider', NOW - 2 * DAY, { wrapped: false, reason: 'phantom-disabled' }),
        line('aider', NOW - DAY, { wrapped: false, reason: 'phantom-disabled' }),
        line('aider', NOW - DAY + HOUR, { wrapped: false, reason: 'phantom-disabled' }),
      ],
    });
    expect(await custodyBacklogItems({ repo: 'ashlrai/phantom', ledgerPath: path, now: new Date(NOW) })).toEqual([]);
  });

  it('keeps engines and reasons in separate cells and honours the limit', async () => {
    const path = await ledger('custody-e', {
      live: [
        adverse('aider', 2 * DAY + 2 * HOUR, 'not-initialized'),
        adverse('aider', 2 * DAY + HOUR, 'not-initialized'),
        adverse('aider', DAY + 3 * HOUR, 'not-initialized'),
        adverse('aider', 2 * DAY + 3 * HOUR, 'worktree-namespace'),
        adverse('aider', DAY + 4 * HOUR, 'worktree-namespace'),
        adverse('aider', DAY + 5 * HOUR, 'worktree-namespace'),
        adverse('claude', 2 * DAY + 4 * HOUR, 'preflight-blocked'),
        adverse('claude', DAY + 6 * HOUR, 'preflight-blocked'),
        adverse('claude', DAY + 7 * HOUR, 'preflight-blocked'),
      ],
    });
    const items = await custodyBacklogItems({ repo: 'ashlrai/phantom', ledgerPath: path, now: new Date(NOW) });
    expect(items).toHaveLength(3);
    expect(new Set(items.map((i) => i.id)).size).toBe(3);
    expect(items.map((i) => i.title)).toContain("Engine 'aider' keeps spawning without Phantom custody (not-initialized)");
    expect(items.map((i) => i.title)).toContain("Engine 'aider' keeps spawning without Phantom custody (worktree-namespace)");
    expect(await custodyBacklogItems({ repo: 'ashlrai/phantom', ledgerPath: path, now: new Date(NOW), limit: 1 })).toHaveLength(1);
    expect(CUSTODY_BACKLOG_MAX_ITEMS).toBe(8);
    expect(CUSTODY_WINDOW_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('reads both ledger generations — the rotated .1 file counts', async () => {
    const path = await ledger('custody-f', {
      rotated: [
        adverse('aider', 2 * DAY + 2 * HOUR, 'phantom-not-installed'),
        adverse('aider', 2 * DAY + HOUR, 'phantom-not-installed'),
      ],
      live: [adverse('aider', DAY + 3 * HOUR, 'phantom-not-installed')],
    });
    const items = await custodyBacklogItems({ repo: 'ashlrai/phantom', ledgerPath: path, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toContain('phantom-not-installed');
    expect(items[0]!.prompt).toContain('3 recorded');
  });

  it('emits nothing for missing ledgers, another repository, or empty evidence', async () => {
    expect(await custodyBacklogItems({ repo: 'ashlrai/phantom', ledgerPath: join(home, 'no-such', 'spawns.jsonl'), now: new Date(NOW) })).toEqual([]);

    const path = await ledger('custody-g', {
      live: [
        adverse('aider', 2 * DAY + 2 * HOUR, 'unknown'),
        adverse('aider', 2 * DAY + HOUR, 'unknown'),
        adverse('aider', DAY + 3 * HOUR, 'unknown'),
      ],
    });
    expect(await custodyBacklogItems({ repo: 'ashlrai/other', ledgerPath: path, now: new Date(NOW) })).toEqual([]);
    expect(await custodyBacklogItems({ repo: 'AshlrAI/Phantom', ledgerPath: path, now: new Date(NOW) })).toHaveLength(1);
    expect(await custodyBacklogItems({ repo: '', ledgerPath: path, now: new Date(NOW) })).toEqual([]);
  });

  it('states truncation as a lower bound in the prompt', async () => {
    const path = await ledger('custody-h', {
      live: [
        adverse('aider', 2 * DAY + 2 * HOUR, 'preflight-unavailable'),
        adverse('aider', 2 * DAY + HOUR, 'preflight-unavailable'),
        adverse('aider', DAY + 3 * HOUR, 'preflight-unavailable'),
      ],
    });
    // Pad the ledger past the 8 MiB read bound so the tail reports truncated.
    const pad = 'x'.repeat(9 * 1024 * 1024);
    await writeFile(path, pad + '\n' + [
      adverse('aider', 2 * DAY + 2 * HOUR, 'preflight-unavailable'),
      adverse('aider', 2 * DAY + HOUR, 'preflight-unavailable'),
      adverse('aider', DAY + 3 * HOUR, 'preflight-unavailable'),
    ].join('\n') + '\n');
    const items = await custodyBacklogItems({ repo: 'ashlrai/phantom', ledgerPath: path, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('lower bound');
  });

  it('counts malformed lines in the coverage note', async () => {
    const path = await ledger('custody-i', {
      live: [
        'garbage line',
        adverse('aider', 2 * DAY + 2 * HOUR, 'connection-string-blocked'),
        J({ schema: 9, at: iso(60), wrapped: true, engine: 'aider', preflight_exit: null }),
        adverse('aider', 2 * DAY + HOUR, 'connection-string-blocked'),
        adverse('aider', DAY + 3 * HOUR, 'connection-string-blocked'),
      ],
    });
    const items = await custodyBacklogItems({ repo: 'ashlrai/phantom', ledgerPath: path, now: new Date(NOW) });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('2 malformed or off-contract lines dropped');
    expect(items[0]!.prompt).toContain('connection-string-blocked');
  });

  it('derives stable ids so a refresh re-adds nothing', async () => {
    const path = await ledger('custody-j', {
      live: [
        adverse('aider', 2 * DAY + 2 * HOUR, 'unknown'),
        adverse('aider', 2 * DAY + HOUR, 'unknown'),
        adverse('aider', DAY + 3 * HOUR, 'unknown'),
      ],
    });
    const opts = { repo: 'ashlrai/phantom', ledgerPath: path, now: new Date(NOW) };
    const first = await custodyBacklogItems(opts);
    const second = await custodyBacklogItems(opts);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    expect(first.length).toBeLessThanOrEqual(CUSTODY_BACKLOG_MAX_ITEMS);
  });

  it('appends custody items through discovery and dedupes on refresh', async () => {
    // The default ledger path resolves under the relocated HOME:
    // ~/.ashlr/custody/spawns.jsonl (homedir-rooted; ASHLR_HOME is not consulted).
    // discoverBacklog anchors its window at the real clock, so these rows
    // are stamped relative to Date.now(), not the fixed NOW the unit tests
    // use. UTC noons two and one days back guarantee distinct UTC days at
    // any wall-clock time the suite runs.
    const d = new Date();
    const day2 = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - 2, 12);
    const day1 = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - 1, 12);
    const dir = dirname(custodyLedgerPath());
    await mkdir(dir, { recursive: true });
    await writeFile(custodyLedgerPath(), [
      line('aider', day2, { wrapped: false, reason: 'not-initialized' }),
      line('aider', day2 + HOUR, { wrapped: false, reason: 'not-initialized' }),
      line('aider', day1, { wrapped: false, reason: 'not-initialized' }),
    ].join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const custodyItems = first.items.filter((i) => i.id.startsWith('fleet-custody-'));
    expect(custodyItems).toHaveLength(1);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(custodyItems)).toBe(1);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('fleet-custody-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('fleet-custody-'))).toHaveLength(1);
  });
});
