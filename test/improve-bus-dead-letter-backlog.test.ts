import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import type { BusEnvelope } from '../src/core/fleet/bus-envelope.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import {
  busDeadLetterBacklogItems,
  foldBusDeadLetterCells,
  BUS_DEAD_LETTER_BACKLOG_MAX_ITEMS,
  BUS_DEAD_LETTER_MIN_DAYS,
  BUS_DEAD_LETTER_MIN_ROWS,
  BUS_DEAD_LETTER_WINDOW_MS,
  type BusDeadLetterEvidence,
} from '../src/core/improve/bus-dead-letter-backlog.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

let home: string;
let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };
beforeEach(() => {
  saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
  delete process.env.ASHLR_HOME;
  delete process.env.ASHLR_RUNS_DIR;
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'improve-busdl-')));
  process.env.HOME = home;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(home, { recursive: true, force: true });
});

const NOW = new Date('2026-11-23T12:00:00Z');
const NOW_MS = NOW.getTime();
/** Epoch ms `days` before NOW (fractional via `hours`, which may be negative). */
const at = (days: number, hours = 0): number => NOW_MS - days * 86400_000 + hours * 3600_000;

const REPO = 'ashlrai/phantom';
const busRoot = (): string => path.join(home, 'fleet');

// ---------------------------------------------------------------------------
// Store fixtures: the sink's wire body (bus-transport-file
// createFileDeadLetterSink) — a protocol status whose payload carries the
// deadLetter summary, the payloadDropped flag and the kept original
// transport envelope or null.
// ---------------------------------------------------------------------------

interface LetterOver {
  id?: string;
  from?: string;
  to?: string;
  kind?: string;
  reason?: string;
  priority?: string;
  attempts?: number;
  payloadDropped?: boolean;
  withPayload?: boolean;
  bare?: boolean;
  bogusReason?: boolean;
}

const deadLetterBody = (over: LetterOver = {}) => ({
  protocol: { version: 1, kind: 'status' },
  correlation_id: 'corr-dead-1',
  payload: {
    ...(over.bare === true ? {} : {
      deadLetter: {
        id: over.id ?? 'orig-env-1', from: over.from ?? 'agent:nova', to: over.to ?? 'agent:atlas',
        kind: over.kind ?? 'task', priority: over.priority ?? 'P1', correlationId: 'corr-dead-1',
        reason: over.bogusReason === true ? 'mystery' : over.reason ?? 'exhausted', deadLetteredAt: NOW_MS - 3600_000,
        attempts: Array.from({ length: over.attempts ?? 2 }, (_, i) => ({
          attempt: i + 1, transport: 'fake-transport', outcome: 'retryable', at: NOW_MS - 7200_000 + i,
        })),
      },
    }),
    payloadDropped: over.payloadDropped ?? false,
    envelope: over.withPayload === false || over.bare === true ? null : {
      id: over.id ?? 'orig-env-1', from: over.from ?? 'agent:nova', to: over.to ?? 'agent:atlas',
      kind: over.kind ?? 'task', priority: over.priority ?? 'P1',
      body: { kind: 'work', text: 'fake lost work' },
      correlationId: 'corr-dead-1', ttlMs: 3_600_000,
    },
  },
});

let letterSeq = 0;
/** Post one dead-letter letter into the fixture bus store, received `daysAgo` days and `hoursAgo` hours before NOW. `over` carries the ORIGINAL envelope's report fields (what deadLetterBody records); the letter itself always comes from 'bus-router' addressed to 'bus.dead-letter'. */
const postLetter = (over: LetterOver & { daysAgo?: number; hoursAgo?: number; ttlMs?: number;
  letterId?: string; priority?: 'P0' | 'P1' | 'P2' | 'P3' } = {}) => {
  const { daysAgo = 1, hoursAgo = 0, ttlMs = BUS_DEAD_LETTER_WINDOW_MS,
    letterId, priority = 'P1' } = over;
  const posted = appendBusInbox({
    id: letterId ?? `dl-letter-${++letterSeq}`,
    from: 'bus-router', to: 'bus.dead-letter', priority, ttl: ttlMs,
    body: deadLetterBody(over) as BusEnvelope['body'],
  }, { root: busRoot(), now: () => at(daysAgo, -hoursAgo) });
  expect(posted.status).toBe('posted');
};

// ---------------------------------------------------------------------------
// Pure fold fixtures.
// ---------------------------------------------------------------------------

const ev = (over: Partial<BusDeadLetterEvidence>): BusDeadLetterEvidence => ({
  cursor: 1, receivedAtMs: at(1), reason: 'no-route',
  to: 'agent:atlas', from: 'agent:nova', kind: 'task', attempts: 0,
  payloadDropped: false, priority: 'P1', parsed: true, ...over,
});

describe('foldBusDeadLetterCells', () => {
  it('cells recurring (reason, recipient) pairs across distinct UTC days with context tallies', () => {
    const { cells, context } = foldBusDeadLetterCells([
      ev({ cursor: 1, receivedAtMs: at(1), priority: 'P2' }),
      ev({ cursor: 2, receivedAtMs: at(2), priority: 'P3' }),
      ev({ cursor: 3, receivedAtMs: at(3), kind: 'note', payloadDropped: true, priority: 'P0' }),
      ev({ cursor: 4, receivedAtMs: at(1), reason: 'expired' }),   // different reason — own cell, under bars
      ev({ cursor: 5, receivedAtMs: at(1), to: 'agent:ghost' }),   // different recipient — own cell, under bars
    ], NOW_MS);
    expect(context).toEqual({ letters: 5, unparsed: 0, payloadDropped: 1 });
    expect(cells).toHaveLength(1);
    const cell = cells[0]!;
    expect(cell.reason).toBe('no-route');
    expect(cell.to).toBe('agent:atlas');
    expect(cell.rows).toBe(3);
    expect(cell.days.size).toBe(3);
    expect(cell.unparsed).toBe(0);
    expect(cell.payloadDropped).toBe(1);
    expect(cell.urgent).toBe(1);
    expect(cell.senders.size).toBe(1);
    expect(cell.kinds.get('task')).toBe(2);
    expect(cell.kinds.get('note')).toBe(1);
  });

  it('emits nothing below the recurring bars of rows and distinct days', () => {
    // Three rows, one UTC day — under the days bar.
    const oneDay = foldBusDeadLetterCells([
      ev({ cursor: 1, receivedAtMs: at(1) }),
      ev({ cursor: 2, receivedAtMs: at(1, -2) }),
      ev({ cursor: 3, receivedAtMs: at(1, -5) }),
    ], NOW_MS);
    expect(oneDay.cells).toEqual([]);
    expect(oneDay.context.letters).toBe(3);
    // Two rows across two days — under the rows bar.
    const twoRows = foldBusDeadLetterCells([
      ev({ cursor: 1, receivedAtMs: at(1) }),
      ev({ cursor: 2, receivedAtMs: at(3) }),
    ], NOW_MS);
    expect(twoRows.cells).toEqual([]);
    expect(BUS_DEAD_LETTER_MIN_ROWS).toBe(3);
    expect(BUS_DEAD_LETTER_MIN_DAYS).toBe(2);
    expect(BUS_DEAD_LETTER_WINDOW_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('windows on receipt time and tolerates only the sibling future skew', () => {
    const { cells, context } = foldBusDeadLetterCells([
      ev({ cursor: 1, receivedAtMs: at(8) }),                    // outside the 7-day window
      ev({ cursor: 2, receivedAtMs: NOW_MS + 120_000 }),         // beyond the 60s skew
      ev({ cursor: 3, receivedAtMs: NOW_MS + 30_000 }),          // inside the skew
      ev({ cursor: 4, receivedAtMs: at(1) }),
      ev({ cursor: 5, receivedAtMs: at(2) }),
      ev({ cursor: 6, receivedAtMs: at(3) }),
    ], NOW_MS);
    // Rows 3,4,5,6 are in-window: cursor 3 lands on NOW's UTC day.
    expect(context.letters).toBe(4);
    expect(cells.map((c) => [c.rows, c.days.size])).toEqual([[4, 4]]);
  });

  it('folds duplicate cursors once and unparsed letters as other/(unrecorded)', () => {
    const { cells, context } = foldBusDeadLetterCells([
      ev({ cursor: 7, receivedAtMs: at(1) }),
      ev({ cursor: 7, receivedAtMs: at(2) }),  // duplicate cursor — first wins
      ev({ cursor: 8, receivedAtMs: at(1), reason: 'other', parsed: false,
        to: null, from: null, kind: null, attempts: null }),
      ev({ cursor: 9, receivedAtMs: at(2), reason: 'other', parsed: false,
        to: null, from: null, kind: null, attempts: null }),
      ev({ cursor: 10, receivedAtMs: at(3), reason: 'other', parsed: false,
        to: null, from: null, kind: null, attempts: null }),
    ], NOW_MS);
    expect(context).toEqual({ letters: 4, unparsed: 3, payloadDropped: 0 });
    expect(cells.map((c) => [c.reason, c.to, c.rows, c.unparsed])).toEqual([
      ['other', '(unrecorded)', 3, 3],
    ]);
  });
});

describe('busDeadLetterBacklogItems', () => {
  it('turns recurring no-route letters into a valid item', async () => {
    postLetter({ id: 'orig-1', to: 'agent:atlas', reason: 'no-route', daysAgo: 1 });
    postLetter({ id: 'orig-2', to: 'agent:atlas', reason: 'no-route', daysAgo: 3 });
    postLetter({ id: 'orig-3', to: 'agent:atlas', reason: 'no-route', daysAgo: 5, priority: 'P0' });
    const items = await busDeadLetterBacklogItems({ repo: REPO, busRoot: busRoot(), now: NOW });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item).toMatchObject({ priority: 3, repo: REPO, area: 'bus-dead-letter' });
    expect(item.id).toMatch(/^busdl-[0-9a-f]{16}$/);
    expect(item.title).toContain("'agent:atlas'");
    expect(item.title).toContain('no route');
    expect(item.prompt).toContain('agent:atlas');
    expect(item.prompt).toContain("'no-route'");
    expect(item.prompt).toContain('3 live dead letter(s)');
    expect(item.prompt).toContain('distinct UTC day(s)');
    expect(item.prompt).toContain('P0/P1');
    expect(item.prompt).toContain('bus.dead-letter');
    expect(item.prompt).toContain('no-change');
    expect(item.prompt).toContain('agents bus dead-letters');
  });

  it('emits per-(reason, recipient) items for recurring cells only', async () => {
    // no-route → agent:atlas (3 days) and expired → group:eng:alerts (3 days).
    for (const [i, d] of [1, 3, 5].entries()) {
      postLetter({ id: `nr-${i}`, to: 'agent:atlas', reason: 'no-route', daysAgo: d });
      postLetter({ id: `ex-${i}`, to: 'group:eng:alerts', reason: 'expired', kind: 'note', daysAgo: d });
    }
    // exhausted → agent:atlas once — under the bars, never emits.
    postLetter({ id: 'exh-1', to: 'agent:atlas', reason: 'exhausted', daysAgo: 2 });
    // Ordinary mail to the same recipient is never a dead letter.
    appendBusInbox({ id: 'plain', from: 'agent:nova', to: 'agent:atlas', priority: 'P1', ttl: 60_000,
      body: { kind: 'note', text: 'hi' } }, { root: busRoot(), now: () => NOW_MS });
    const items = await busDeadLetterBacklogItems({ repo: REPO, busRoot: busRoot(), now: NOW });
    expect(items).toHaveLength(2);
    const prompts = items.map((i) => i.prompt).join('\n');
    expect(prompts).toContain("'agent:atlas'");
    expect(prompts).toContain("'group:eng:alerts'");
    expect(prompts).toContain("'no-route'");
    expect(prompts).toContain("'expired'");
    expect(items.every((i) => validBacklogItem(i) !== null)).toBe(true);
  });

  it('folds unparseable dead-letter bodies as other/(unrecorded) cells', async () => {
    for (const [i, d] of [1, 2, 4].entries()) {
      postLetter({ id: `bare-${i}`, bare: true, daysAgo: d });
    }
    const items = await busDeadLetterBacklogItems({ repo: REPO, busRoot: busRoot(), now: NOW });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item.title).toContain('without a parseable report');
    expect(item.prompt).toContain("'other'");
    expect(item.prompt).toContain('no parseable deadLetter report');
  });

  it('emits nothing below the recurring bars', async () => {
    postLetter({ id: 'one', to: 'agent:atlas', reason: 'no-route', daysAgo: 1 });
    postLetter({ id: 'two', to: 'agent:atlas', reason: 'no-route', daysAgo: 3 });
    expect(await busDeadLetterBacklogItems({ repo: REPO, busRoot: busRoot(), now: NOW })).toEqual([]);
    // Three letters but all on one UTC day.
    fs.rmSync(busRoot(), { recursive: true, force: true });
    postLetter({ id: 'a', to: 'agent:atlas', reason: 'no-route', daysAgo: 1 });
    postLetter({ id: 'b', to: 'agent:atlas', reason: 'no-route', daysAgo: 1, hoursAgo: 3 });
    postLetter({ id: 'c', to: 'agent:atlas', reason: 'no-route', daysAgo: 1, hoursAgo: 8 });
    expect(await busDeadLetterBacklogItems({ repo: REPO, busRoot: busRoot(), now: NOW })).toEqual([]);
  });

  it('yields nothing for a missing, unreadable or empty-letter store', async () => {
    // Verified-missing store — no bus traffic ever recorded.
    expect(await busDeadLetterBacklogItems({ repo: REPO, busRoot: path.join(home, 'no-such'), now: NOW })).toEqual([]);
    // Ordinary mail only — no dead letters.
    appendBusInbox({ id: 'plain', from: 'agent:nova', to: 'agent:atlas', priority: 'P1', ttl: 60_000,
      body: { kind: 'note', text: 'hi' } }, { root: busRoot(), now: () => NOW_MS });
    expect(await busDeadLetterBacklogItems({ repo: REPO, busRoot: busRoot(), now: NOW })).toEqual([]);
    // Corrupt snapshot — unavailable, never an empty page pretending health.
    fs.mkdirSync(path.join(busRoot(), 'bus-inbox'), { recursive: true });
    fs.writeFileSync(path.join(busRoot(), 'bus-inbox', 'messages.json'), '{invalid', { mode: 0o600 });
    expect(await busDeadLetterBacklogItems({ repo: REPO, busRoot: busRoot(), now: NOW })).toEqual([]);
  });

  it('skips expired letters — only live retained evidence counts', async () => {
    // Letters whose own TTL already lapsed at NOW never reach the fold.
    for (const [i, d] of [1, 2, 3].entries()) {
      postLetter({ id: `old-${i}`, to: 'agent:atlas', reason: 'no-route', daysAgo: d, ttlMs: 3600_000 });
    }
    expect(await busDeadLetterBacklogItems({ repo: REPO, busRoot: busRoot(), now: NOW })).toEqual([]);
  });

  it('emits nothing for another repository or an empty repo', async () => {
    for (const [i, d] of [1, 3, 5].entries()) {
      postLetter({ id: `nr-${i}`, to: 'agent:atlas', reason: 'no-route', daysAgo: d });
    }
    expect(await busDeadLetterBacklogItems({ repo: 'ashlrai/other', busRoot: busRoot(), now: NOW })).toEqual([]);
    expect(await busDeadLetterBacklogItems({ repo: '', busRoot: busRoot(), now: NOW })).toEqual([]);
    expect(await busDeadLetterBacklogItems({ repo: 'AshlrAI/Phantom', busRoot: busRoot(), now: NOW })).toHaveLength(1);
  });

  it('derives stable ids so a refresh re-adds nothing', async () => {
    for (const [i, d] of [1, 3, 5].entries()) {
      postLetter({ id: `nr-${i}`, to: 'agent:atlas', reason: 'no-route', daysAgo: d });
    }
    const first = await busDeadLetterBacklogItems({ repo: REPO, busRoot: busRoot(), now: NOW });
    const second = await busDeadLetterBacklogItems({ repo: REPO, busRoot: busRoot(), now: NOW });
    expect(first.length).toBeGreaterThan(0);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    expect(first.length).toBeLessThanOrEqual(BUS_DEAD_LETTER_BACKLOG_MAX_ITEMS);
  });

  it('honors the item limit', async () => {
    for (const [i, d] of [1, 3, 5].entries()) {
      postLetter({ id: `nr-${i}`, to: 'agent:atlas', reason: 'no-route', daysAgo: d });
      postLetter({ id: `ex-${i}`, to: 'group:eng:alerts', reason: 'expired', daysAgo: d });
      postLetter({ id: `exh-${i}`, to: 'agent:ghost', reason: 'exhausted', daysAgo: d });
    }
    const items = await busDeadLetterBacklogItems({ repo: REPO, busRoot: busRoot(), now: NOW, limit: 2 });
    expect(items).toHaveLength(2);
  });

  it('appends dead-letter items through discovery and dedupes on refresh', async () => {
    const fleet = path.join(home, '.ashlr', 'fleet');
    for (const [i, d] of [1, 3, 5].entries()) {
      const posted = appendBusInbox({
        id: `dl-disc-${i}`, from: 'bus-router', to: 'bus.dead-letter', priority: 'P1',
        ttl: BUS_DEAD_LETTER_WINDOW_MS, body: deadLetterBody({ id: `orig-${i}`, to: 'agent:atlas', reason: 'no-route' }) as BusEnvelope['body'],
      }, { root: fleet, now: () => Date.now() - d * 86400_000 });
      expect(posted.status).toBe('posted');
    }
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog(REPO, { gh: greenGh });
    const dlItems = first.items.filter((i) => i.id.startsWith('busdl-'));
    expect(dlItems).toHaveLength(1);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(dlItems)).toBe(dlItems.length);
    const second = await discoverBacklog(REPO, { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('busdl-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('busdl-'))).toHaveLength(dlItems.length);
  });
});
