import { appendFileSync, chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendBusHop, type BusHop } from '../src/core/fleet/bus-hoplog.js';
import {
  BUS_HOP_MAX_ITEMS,
  BUS_HOP_MIN_HOPS,
  BUS_HOP_MIN_PAIR_HOPS,
  BUS_HOP_MIN_PAIR_TOKENS,
  BUS_HOP_MIN_SENDER_HOPS,
  busHopBacklogItems,
  foldBusHopCells,
} from '../src/core/improve/bus-hop-backlog.js';
import { validBacklogItem } from '../src/core/cloud/backlog.js';

let root: string;
let file: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'bus-hop-backlog-'));
  file = join(root, 'bus', 'hops.jsonl');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** One hop in the writer's shape; absent token fields record as null. */
function hop(id: string, from: string, to: string, inputTokens: number | null, outputTokens: number | null): BusHop {
  return { id, from, to, inputTokens, outputTokens };
}

/** `count` hops from one sender to one recipient with the given token counts. */
function hops(from: string, to: string, count: number, input: number | null, output: number | null): BusHop[] {
  return Array.from({ length: count }, (_, i) => hop(`m-${from}-${to}-${i}`, from, to, input, output));
}

/** Append hops through the real writer so custody and modes match production. */
function writeHops(rows: readonly BusHop[], path: string = file): void {
  for (const row of rows) expect(appendBusHop(row, path)).toBe(true);
}

const REPO = 'ashlrai/phantom';

describe('foldBusHopCells', () => {
  it('returns no cells below the global hop floor', () => {
    expect(foldBusHopCells(hops('noisy', 'x', BUS_HOP_MIN_HOPS - 1, null, null))).toEqual([]);
  });

  it('emits an unmeasured cell only past the sender floors and strict-majority share', () => {
    // 45 hops: 'noisy' has 25, all unmeasured; 'chatty' has 20, all measured.
    const cells = foldBusHopCells([
      ...hops('noisy', 'a', 25, null, null),
      ...hops('chatty', 'b', 20, 100, 50),
    ]);
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({ kind: 'unmeasured', sender: 'noisy', hops: 25, unmeasured: 25 });
  });

  it('does not emit when the unmeasured share is exactly half or the sender is thin', () => {
    // Exactly half unmeasured is not a strict majority.
    const half = foldBusHopCells([
      ...hops('mix', 'a', 12, null, null),
      ...hops('mix', 'a', 13, 10, 5),
      ...hops('other', 'b', 15, 10, 5),
    ]);
    expect(half.filter((c) => c.kind === 'unmeasured')).toEqual([]);

    // A sender below the per-sender hop floor never emits, however unmeasured.
    const thin = foldBusHopCells([
      ...hops('tiny', 'a', BUS_HOP_MIN_SENDER_HOPS - 1, null, null),
      ...hops('rest', 'b', 30, 10, 5),
    ]);
    expect(thin.filter((c) => c.kind === 'unmeasured')).toEqual([]);
  });

  it('emits a concentrated cell only at the share, token and hop floors', () => {
    const perHop = 25_000;
    const cells = foldBusHopCells([
      ...hops('leader', 'worker', BUS_HOP_MIN_PAIR_HOPS, perHop, perHop),
      // Enough other measured hops to clear the reported-hops floor.
      ...hops('a', 'b', 20, 10, 5),
      ...hops('c', 'd', 12, 10, 5),
    ]);
    const concentrated = cells.filter((c) => c.kind === 'concentrated');
    expect(concentrated).toHaveLength(1);
    const cell = concentrated[0]!;
    expect(cell).toMatchObject({ kind: 'concentrated', from: 'leader', to: 'worker', hops: BUS_HOP_MIN_PAIR_HOPS });
    if (cell.kind === 'concentrated') {
      expect(cell.tokens).toBe(BUS_HOP_MIN_PAIR_HOPS * perHop * 2);
      expect(cell.tokens).toBeGreaterThanOrEqual(BUS_HOP_MIN_PAIR_TOKENS);
      expect(cell.share).toBeGreaterThan(0.6);
    }
  });

  it('suppresses concentration below the token floor or the pair hop floor', () => {
    // Same dominant share but tiny absolute tokens.
    const small = foldBusHopCells([
      ...hops('leader', 'worker', 10, 50, 50),
      ...hops('a', 'b', 30, 10, 5),
    ]);
    expect(small.filter((c) => c.kind === 'concentrated')).toEqual([]);

    // Enough tokens but the pair repeated too few times.
    const few = foldBusHopCells([
      ...hops('leader', 'worker', BUS_HOP_MIN_PAIR_HOPS - 1, 60_000, 60_000),
      ...hops('a', 'b', 30, 10, 5),
    ]);
    expect(few.filter((c) => c.kind === 'concentrated')).toEqual([]);
  });

  it('orders unmeasured cells ahead of concentrated ones and sorts deterministically', () => {
    const rows = [
      ...hops('noisy', 'a', 25, null, null),
      ...hops('chatty', 'b', 20, 10, 5),
      ...hops('leader', 'worker', 10, 30_000, 30_000),
    ];
    const cells = foldBusHopCells(rows);
    expect(cells.map((c) => c.kind)).toEqual(['unmeasured', 'concentrated']);
    // Stable across calls.
    expect(foldBusHopCells(rows).map((c) => c.kind)).toEqual(cells.map((c) => c.kind));
  });
});

describe('busHopBacklogItems', () => {
  it('emits a grounded unmeasured item for a sender that drops token counts', async () => {
    writeHops([
      ...hops('noisy', 'a', 25, null, null),
      ...hops('chatty', 'b', 20, 100, 50),
    ]);
    appendFileSync(file, 'not json at all\n', 'utf8');
    const items = await busHopBacklogItems({ repo: REPO, hoplogFile: file });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.id).toMatch(/^bus-hop-unmeasured-[0-9a-f]{16}$/);
    expect(item).toMatchObject({ area: 'agent-bus', priority: 3, repo: REPO });
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item.title).toContain('noisy');
    expect(item.prompt).toContain('noisy');
    expect(item.prompt).toContain('hops.jsonl');
    expect(item.prompt).toContain('inputTokens');
    expect(item.prompt).toContain('retained tail');
    expect(item.prompt).toContain('malformed row');
    expect(item.prompt).toContain('no-change');
    // Ids are stable across refreshes: same evidence derives the same id.
    const again = await busHopBacklogItems({ repo: REPO, hoplogFile: file });
    expect(again.map((i) => i.id)).toEqual(items.map((i) => i.id));
  });

  it('emits a grounded concentrated item for a dominant sender→recipient pair', async () => {
    writeHops([
      ...hops('leader', 'worker', 10, 30_000, 30_000),
      ...hops('a', 'b', 20, 10, 5),
      ...hops('c', 'd', 12, 10, 5),
    ]);
    const items = await busHopBacklogItems({ repo: REPO, hoplogFile: file });
    const concentrated = items.filter((i) => i.id.startsWith('bus-hop-concentrated-'));
    expect(concentrated).toHaveLength(1);
    const item = concentrated[0]!;
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item.title).toContain('leader');
    expect(item.title).toContain('worker');
    expect(item.prompt).toContain('recorded hop token');
    expect(item.prompt).toContain('lower bound');
    expect(item.prompt).toContain('no-change');
  });

  it('emits nothing for a missing log, thin evidence, or a foreign repository', async () => {
    expect(await busHopBacklogItems({ repo: REPO, hoplogFile: join(root, 'nope', 'hops.jsonl') })).toEqual([]);

    // Below the global hop floor even though one sender is fully unmeasured.
    writeHops(hops('noisy', 'a', BUS_HOP_MIN_HOPS - 1, null, null));
    expect(await busHopBacklogItems({ repo: REPO, hoplogFile: file })).toEqual([]);

    // Another repository never inherits this install's bus evidence.
    writeHops([
      ...hops('noisy', 'a', 25, null, null),
      ...hops('chatty', 'b', 20, 100, 50),
    ]);
    expect(await busHopBacklogItems({ repo: 'ashlrai/lexicon', hoplogFile: file })).toEqual([]);
    expect(await busHopBacklogItems({ repo: '', hoplogFile: file })).toEqual([]);
  });

  it('emits one degraded item when the log fails custody checks', async () => {
    mkdirSync(join(root, 'bus'), { recursive: true, mode: 0o700 });
    writeFileSync(file, '{}\n', { mode: 0o600 });
    if (process.platform !== 'win32') chmodSync(file, 0o644);
    const items = await busHopBacklogItems({ repo: REPO, hoplogFile: file });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: 'bus-hoplog-unreadable', area: 'agent-bus', priority: 3, repo: REPO });
    expect(items[0]!.prompt).toContain('unreadable');
    expect(validBacklogItem(items[0]!)).not.toBeNull();
  });

  it('labels byte-truncated reads as retained-tail evidence', async () => {
    // Enough unmeasured hops that the tail still clears the floors after a byte cut.
    writeHops(hops('noisy', 'a', BUS_HOP_MIN_HOPS + 60, null, null));
    const items = await busHopBacklogItems({ repo: REPO, hoplogFile: file, maxBytes: 8192 });
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]!.prompt).toContain('older bytes outside the read window');
    expect(items[0]!.prompt).toContain('retained tail');
  });

  it('honours the item limit and stays total on bad options', async () => {
    writeHops([
      ...hops('noisy', 'a', 25, null, null),
      ...hops('noisy2', 'a', 25, null, null),
      ...hops('chatty', 'b', 20, 100, 50),
    ]);
    const limited = await busHopBacklogItems({ repo: REPO, hoplogFile: file, limit: 1 });
    expect(limited).toHaveLength(1);
    // Out-of-contract read limits fall back to defaults instead of throwing.
    const items = await busHopBacklogItems({ repo: REPO, hoplogFile: file, maxBytes: 1, maxRows: 0 });
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThanOrEqual(BUS_HOP_MAX_ITEMS);
  });

  it('reads the default hoplog path under ASHLR_HOME', async () => {
    const home = mkdtempSync(join(tmpdir(), 'bus-hop-home-'));
    const saved = process.env['ASHLR_HOME'];
    try {
      process.env['ASHLR_HOME'] = home;
      writeHops([
        ...hops('noisy', 'a', 25, null, null),
        ...hops('chatty', 'b', 20, 100, 50),
      ], join(home, 'fleet', 'bus', 'hops.jsonl'));
      const items = await busHopBacklogItems({ repo: REPO });
      expect(items).toHaveLength(1);
      expect(items[0]!.id.startsWith('bus-hop-unmeasured-')).toBe(true);
    } finally {
      if (saved === undefined) delete process.env['ASHLR_HOME']; else process.env['ASHLR_HOME'] = saved;
      rmSync(home, { recursive: true, force: true });
    }
  });
});
