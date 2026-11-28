import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import type { BusEnvelope } from '../src/core/fleet/bus-envelope.js';
import { busDeadLetterBacklogItems, foldBusDeadLetterCells, BUS_DEAD_LETTER_WINDOW_MS } from '../src/core/improve/bus-dead-letter-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { validBacklogItem } from '../src/core/cloud/backlog.js';

const DAY = 86_400_000;
const NOW = new Date('2026-11-23T12:00:00Z');
const NOW_MS = NOW.getTime();
const REPO = 'ashlrai/phantom';
const WORK_REPO = 'ashlrai/lexicon';

let home: string;
let saved: { HOME?: string; ASHLR_HOME?: string };
beforeEach(() => {
  saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME };
  delete process.env.ASHLR_HOME;
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'improve-busdl-')));
  process.env.HOME = home;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(home, { recursive: true, force: true });
});

const cleanups: string[] = [];
afterEach(() => { for (const dir of cleanups.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });

/** A fleet root under a temp dir; the clock is mutable so receipts land on chosen days. */
function setup(at = NOW_MS) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'busdl-fleet-'));
  cleanups.push(base);
  const clock = { now: at };
  return { base, root: path.join(base, 'fleet'), now: () => clock.now, clock };
}

/** The sink's wire body (bus-transport-file `createFileDeadLetterSink`): a
 * protocol status whose payload carries the deadLetter summary, the
 * payloadDropped flag and the kept original transport envelope or null. */
const deadLetterBody = (over: { id?: string; from?: string; to?: string; kind?: string;
    reason?: string; priority?: string; attempts?: number; payloadDropped?: boolean;
    withPayload?: boolean; bare?: boolean; bogusReason?: boolean } = {}) => ({
  protocol: { version: 1, kind: 'status' },
  correlation_id: 'corr-dead-1',
  payload: {
    ...(over.bare === true ? {} : {
      deadLetter: {
        id: over.id ?? 'orig-env-1', from: over.from ?? 'agent:nova', to: over.to ?? 'agent:atlas',
        kind: over.kind ?? 'task', priority: over.priority ?? 'P1', correlationId: 'corr-dead-1',
        reason: over.bogusReason === true ? 'mystery' : over.reason ?? 'exhausted', deadLetteredAt: 1_000,
        attempts: Array.from({ length: over.attempts ?? 2 }, (_, i) => ({
          attempt: i + 1, transport: 'fake-transport', outcome: 'retryable', at: 900 - i,
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

const postLetter = (options: ReturnType<typeof setup>, id: string, body: unknown,
  extra: Partial<BusEnvelope> = {}) => {
  const posted = appendBusInbox({ id, from: 'bus-router', to: 'bus.dead-letter',
    priority: 'P1', ttl: 8 * DAY, body: body as BusEnvelope['body'], ...extra },
    { root: options.root, now: options.now });
  expect(posted.status).toBe('posted');
};

/** Post one dead letter `daysAgo` days before NOW on the given route. */
const letter = (options: ReturnType<typeof setup>, id: string, daysAgo: number,
  over: Parameters<typeof deadLetterBody>[0] = {}, extra: Partial<BusEnvelope> = {}) => {
  options.clock.now = NOW_MS - daysAgo * DAY;
  postLetter(options, id, deadLetterBody(over), extra);
};

const feed = (options: ReturnType<typeof setup>, repo = REPO) =>
  busDeadLetterBacklogItems({ repo, root: options.root, now: NOW });

describe('busDeadLetterBacklogItems', () => {
  it('turns a recurring per-recipient dead-letter pattern into a valid priority-3 item', async () => {
    const options = setup();
    letter(options, 'dl-1', 3, { to: 'agent:atlas', reason: 'exhausted' });
    letter(options, 'dl-2', 2, { to: 'agent:atlas', reason: 'exhausted', from: 'agent:ghost' });
    letter(options, 'dl-3', 1, { to: 'agent:atlas', reason: 'expired', payloadDropped: true, withPayload: false });
    // Ordinary mail is never a dead letter.
    options.clock.now = NOW_MS - DAY;
    appendBusInbox({ id: 'plain', from: 'agent:nova', to: 'agent:atlas', priority: 'P1', ttl: DAY,
      body: { kind: 'note', text: 'hi' } }, { root: options.root, now: options.now });

    const items = await feed(options);
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.id).toMatch(/^busdl-addr-[0-9a-f]{16}$/);
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item).toMatchObject({ priority: 3, repo: REPO, area: 'agent-bus' });
    expect(item.title).toContain('agent:atlas');
    expect(item.prompt).toContain('3 dead letter(s) to this recipient across 3 distinct UTC day(s)');
    expect(item.prompt).toContain('exhausted 2, expired 1, no-route 0, other 0');
    expect(item.prompt).toContain('1 letter(s) kept only routing metadata');
    expect(item.prompt).toContain('agent:nova');
    expect(item.prompt).toContain('agent:ghost');
    expect(item.prompt).toContain('bus.dead-letter');
    expect(item.prompt).toContain('createFileDeadLetterSink');
    expect(item.prompt).toContain('no-change');
  });

  it('emits a per-reason item only when the failure spreads across recipient buckets', async () => {
    const options = setup();
    // 'no-route' reaches two named recipients across three days: a fleet-wide
    // routing gap, not one dead route — the reason cell emits, and neither
    // recipient alone reaches the per-address bar.
    letter(options, 'nr-1', 3, { to: 'agent:atlas', reason: 'no-route', from: 'agent:nova' });
    letter(options, 'nr-2', 2, { to: 'agent:ghost', reason: 'no-route', from: 'agent:nova' });
    letter(options, 'nr-3', 1, { to: 'agent:atlas', reason: 'no-route', from: 'agent:nova' });

    const items = await feed(options);
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.id).toMatch(/^busdl-reason-no-route-[0-9a-f]{16}$/);
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item.prompt).toContain('3 \'no-route\' dead letter(s) across 3 distinct UTC day(s)');
    expect(item.prompt).toContain('2 distinct recipient bucket(s)');
    expect(item.prompt).toContain("'agent:atlas'");
    expect(item.prompt).toContain("'agent:ghost'");
  });

  it('keeps a concentrated reason on its per-recipient cell only', async () => {
    const options = setup();
    // Three 'expired' letters, all to one route: the address cell emits but
    // the reason never spreads, so no fleet-wide 'expired' item appears.
    letter(options, 'ex-1', 3, { to: 'agent:atlas', reason: 'expired' });
    letter(options, 'ex-2', 2, { to: 'agent:atlas', reason: 'expired' });
    letter(options, 'ex-3', 1, { to: 'agent:atlas', reason: 'expired' });

    const items = await feed(options);
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toMatch(/^busdl-addr-/);
    expect(items[0]!.prompt).toContain('expired 3');
  });

  it('lets unparseable letters form an \'other\' reason cell without naming a route', async () => {
    const options = setup();
    // Bodies the defensive report read cannot classify: no `to` survives, so
    // no address cell can form — but three unattributable letters across two
    // days are themselves evidence the sink's wire contract drifted.
    letter(options, 'bare-1', 3, { bare: true });
    letter(options, 'bare-2', 2, { bare: true });
    letter(options, 'bare-3', 1, { bare: true });

    const items = await feed(options);
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.id).toMatch(/^busdl-reason-other-[0-9a-f]{16}$/);
    expect(item.prompt).toContain('3 \'other\' dead letter(s)');
    expect(item.prompt).toContain('3 letter(s) carried no parseable report');
    expect(item.prompt).toContain('no parseable recipient recorded');
  });

  it('stays quiet below the bars: too few letters, one day, or outside the window', async () => {
    // Two letters never reach the bar.
    const two = setup();
    letter(two, 'a-1', 2, { to: 'agent:atlas' });
    letter(two, 'a-2', 1, { to: 'agent:atlas' });
    expect(await feed(two)).toEqual([]);

    // Three letters but all receipts share one UTC day.
    const oneDay = setup();
    for (const [i, id] of ['b-1', 'b-2', 'b-3'].entries()) {
      oneDay.clock.now = NOW_MS - i * 3_600_000;
      postLetter(oneDay, id, deadLetterBody({ to: 'agent:atlas' }));
    }
    expect(await feed(oneDay)).toEqual([]);

    // Live letters older than the window: an 8-day-old receipt under a
    // ten-day TTL is still listed by the store but outside the evidence
    // window — the bound applies even though the letter has not expired.
    const old = setup();
    old.clock.now = NOW_MS - 8 * DAY;
    postLetter(old, 'old-1', deadLetterBody({ to: 'agent:atlas' }), { ttl: 10 * DAY });
    old.clock.now = NOW_MS - 7 * DAY - 3_600_000;
    postLetter(old, 'old-2', deadLetterBody({ to: 'agent:atlas' }), { ttl: 10 * DAY });
    old.clock.now = NOW_MS - 6 * DAY;
    postLetter(old, 'old-3', deadLetterBody({ to: 'agent:atlas' }), { ttl: 10 * DAY });
    expect(await feed(old)).toEqual([]);
  });

  it('ignores letters stamped beyond the future-skew allowance', async () => {
    const options = setup();
    // Receipts days ahead of the feed clock: the store still lists them
    // (elapsed clamps to zero) but the fold refuses future evidence —
    // without the guard these three would span three days and emit.
    for (const [i, id] of ['f-1', 'f-2', 'f-3'].entries()) {
      options.clock.now = NOW_MS + (i + 2) * DAY;
      postLetter(options, id, deadLetterBody({ to: 'agent:atlas' }));
    }
    expect(await feed(options)).toEqual([]);
  });

  it('lets expired letters age out — the live store is the only evidence', async () => {
    const options = setup();
    options.clock.now = NOW_MS - 8 * DAY;
    postLetter(options, 'gone-1', deadLetterBody({ to: 'agent:atlas' }), { ttl: DAY });
    postLetter(options, 'gone-2', deadLetterBody({ to: 'agent:atlas' }), { ttl: DAY });
    postLetter(options, 'gone-3', deadLetterBody({ to: 'agent:atlas' }), { ttl: DAY });
    // At NOW every receipt is past its TTL: listBusInboxAfter never returns
    // them, so the fold sees an empty store — unknown stays unknown.
    expect(await feed(options)).toEqual([]);
  });

  it('emits only for the fleet repository and derives stable dedup ids', async () => {
    const options = setup();
    letter(options, 's-1', 2, { to: 'agent:atlas' });
    letter(options, 's-2', 1, { to: 'agent:atlas' });
    letter(options, 's-3', 1, { to: 'agent:atlas', reason: 'no-route' });

    expect(await busDeadLetterBacklogItems({ repo: WORK_REPO, root: options.root, now: NOW })).toEqual([]);
    expect(await busDeadLetterBacklogItems({ repo: '', root: options.root, now: NOW })).toEqual([]);

    const first = await feed(options);
    const second = await feed(options);
    expect(first.map((i) => i.id)).toEqual(second.map((i) => i.id));
    // The address cell reaches the bars; neither reason does (each spread
    // is a single recipient and each tallies under three letters at most).
    expect(first).toHaveLength(1);
    expect(first[0]!.id).toMatch(/^busdl-addr-/);
  });

  it('honours the item limit and degrades honestly on missing or corrupt stores', async () => {
    const options = setup();
    // Two routes each recur across three days → two address cells; distinct
    // reasons per route keep either reason cell below the spread bar.
    for (const daysAgo of [3, 2, 1]) {
      letter(options, `la-${daysAgo}`, daysAgo, { to: 'agent:atlas', reason: 'exhausted' });
      letter(options, `lg-${daysAgo}`, daysAgo, { to: 'agent:ghost', reason: 'expired' });
    }
    const all = await feed(options);
    expect(all).toHaveLength(2);
    expect(await busDeadLetterBacklogItems({ repo: REPO, root: options.root, now: NOW, limit: 1 })).toHaveLength(1);
    // The sibling clamp: a non-positive limit still emits the strongest item.
    expect(await busDeadLetterBacklogItems({ repo: REPO, root: options.root, now: NOW, limit: 0 })).toHaveLength(1);

    // A verified-missing store yields nothing rather than throwing.
    const missing = setup();
    expect(await feed(missing)).toEqual([]);

    // A corrupt snapshot reads unavailable — degraded reads yield no items.
    const corrupt = setup();
    postLetter(corrupt, 'c-1', deadLetterBody({ to: 'agent:atlas' }));
    fs.writeFileSync(path.join(corrupt.root, 'bus-inbox', 'messages.json'), '{invalid', { mode: 0o600 });
    expect(await feed(corrupt)).toEqual([]);
  });

  it('resolves the default bus root under ASHLR home for discoverBacklog', async () => {
    // No `root` override: the feed reads <ashlrHome>/fleet — here the temp
    // HOME's .ashlr — exactly like the bus transports do. discoverBacklog
    // anchors on the real clock, so the receipts are stamped relative to it.
    const fleet = path.join(home, '.ashlr', 'fleet');
    const realNow = Date.now();
    const post = (id: string, daysAgo: number, to: string) => {
      const posted = appendBusInbox({ id, from: 'bus-router', to: 'bus.dead-letter',
        priority: 'P1', ttl: 8 * DAY, body: deadLetterBody({ to }) as BusEnvelope['body'] },
        { root: fleet, now: () => realNow - daysAgo * DAY });
      expect(posted.status).toBe('posted');
    };
    post('d-1', 3, 'agent:atlas');
    post('d-2', 2, 'agent:atlas');
    post('d-3', 1, 'agent:atlas');

    const { items, errors } = await discoverBacklog(REPO, {
      gh: async () => ({ ok: false, stdout: '', stderr: 'HTTP 403' }),
    });
    const mine = items.filter((i) => i.id.startsWith('busdl-'));
    expect(mine).toHaveLength(1);
    expect(mine[0]!.id).toMatch(/^busdl-addr-[0-9a-f]{16}$/);
    expect(mine[0]!.prompt).toContain('3 dead letter(s)');
    expect(errors.every((e) => !e.startsWith('busDeadLetterBacklogItems:'))).toBe(true);
  });
});

describe('foldBusDeadLetterCells', () => {
  const row = (receivedAt: number, to: string | null): import('../src/core/improve/bus-dead-letter-backlog.js').DeadLetterRow => ({
    cursor: 0, receivedAt, priority: 'P1',
    report: {
      id: null, from: 'agent:nova', to, kind: 'task', reason: 'exhausted', attempts: 2, payloadDropped: false,
    },
    reasonKind: 'exhausted',
  });

  it('applies the window and day bars to synthetic rows', () => {
    const inside = NOW_MS - 2 * DAY;
    const rows = [
      row(inside, 'agent:atlas'),
      row(inside + DAY, 'agent:atlas'),
      row(inside + 2 * DAY, 'agent:atlas'),
      // Outside the window: never counted.
      row(NOW_MS - BUS_DEAD_LETTER_WINDOW_MS - DAY, 'agent:atlas'),
      // Beyond the future skew: never counted.
      row(NOW_MS + 120_000, 'agent:atlas'),
    ];
    const folded = foldBusDeadLetterCells(rows, NOW_MS);
    expect(folded.addressCells.get('agent:atlas')?.letters).toBe(3);
    expect(folded.addressCells.get('agent:atlas')?.days.size).toBe(3);
    // 'exhausted' spread is one recipient → no reason cell.
    expect(folded.reasonCells.size).toBe(0);
  });
});
