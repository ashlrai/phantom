import { mkdirSync, statSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DELIVERY_RECEIPTS_MAX_LINES,
  DELIVERY_RECEIPTS_MIN_DAYS,
  DELIVERY_RECEIPTS_MIN_MESSAGES,
  DELIVERY_RECEIPTS_MIN_ROWS,
  DELIVERY_RECEIPTS_TAIL_BYTES,
  deliveryFailureSignal,
  deliveryReceiptCells,
  deliveryReceiptsBacklogItems,
  foldDeliveryReceiptRows,
  parseDeliveryReceiptJournal,
  parseDeliveryReceiptJournalEntry,
} from '../src/core/improve/delivery-receipts-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const J = (o: Record<string, unknown>): string => JSON.stringify(o);

/** Fixed evaluation instant; fixture timestamps are ISO-8601 UTC like the ledger writer's `at`. */
const NOW_MS = Date.parse('2026-11-23T12:00:00.000Z');
const NOW = new Date(NOW_MS);
const iso = (ms: number): string => new Date(ms).toISOString();
const REPO = 'ashlrai/phantom';

const TRANSPORT_REFUSED = 'Channel transport refused the owner reply.';
const NO_TRANSPORT = 'No transport is attached for this channel.';
const OWNER_POLICY = 'Replies only go to the confirmed owner.';
const KILL = 'Kill switch halted this adapter.';
const PAUSED = 'Communications are paused.';
const UNCONFIGURED = 'Disabled until an owner identity is configured.';
const NO_SECRET = 'Disabled until the Phantom Secrets handle is named.';
const IMESSAGE_BRIDGE = 'iMessage is loopback-only and stays disabled until the local bridge is selected.';

let home: string;
let savedHome: string | undefined;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'delivery-receipts-backlog-'));
  savedHome = process.env['HOME'];
});
afterEach(async () => {
  if (savedHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = savedHome;
  await rm(home, { recursive: true, force: true });
});

/** One row in the writer's ledger shape — recordDelivery emits {messageId, channel, state, at, reason?}. */
function row(spec: {
  atMs?: number | null;
  messageId?: string;
  channel?: string;
  state?: string;
  reason?: string | null;
  extra?: Record<string, unknown>;
}): string {
  const o: Record<string, unknown> = {
    messageId: spec.messageId ?? 'm1',
    channel: spec.channel ?? 'slack',
    state: spec.state ?? 'failed',
    ...(spec.atMs === null ? {} : { at: iso(spec.atMs ?? NOW_MS) }),
    ...(spec.reason === null || spec.reason === undefined ? {} : { reason: spec.reason }),
    ...spec.extra,
  };
  return J(o);
}

/** Write ledger text to <home>/<runsDirName>/leader/delivery-receipts.jsonl and return its path. */
function writeLedger(lines: string[], runsDirName = 'runs'): string {
  const dir = join(home, runsDirName, 'leader');
  const file = join(dir, 'delivery-receipts.jsonl');
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

/** Three failed rows across three UTC days and three distinct sends — the recurring cell. */
function recurringFailed(channel = 'slack', reason = TRANSPORT_REFUSED): string[] {
  return [
    row({ atMs: NOW_MS - DAY, messageId: 'm11', channel, reason }),
    row({ atMs: NOW_MS - 2 * DAY, messageId: 'm12', channel, reason }),
    row({ atMs: NOW_MS - 3 * DAY, messageId: 'm13', channel, reason }),
  ];
}

describe('parseDeliveryReceiptJournalEntry', () => {
  it('accepts the writer contract and rejects off-contract rows', () => {
    expect(parseDeliveryReceiptJournalEntry({ messageId: 'm1', channel: 'slack', state: 'failed', at: iso(NOW_MS), reason: TRANSPORT_REFUSED })).not.toBeNull();
    // Legacy rows written before the `at` stamp existed stay undated, not invalid.
    const undated = parseDeliveryReceiptJournalEntry({ messageId: 'm1', channel: 'slack', state: 'delivered' });
    expect(undated).not.toBeNull();
    expect(undated!.atMs).toBeNull();
    expect(undated!.utcDay).toBeNull();
    expect(parseDeliveryReceiptJournalEntry({ messageId: 'm1', channel: 'slack', state: 'failed', at: 'not-a-date' })).toBeNull();
    expect(parseDeliveryReceiptJournalEntry({ messageId: 'm1', channel: 'pigeon', state: 'failed', at: iso(NOW_MS) })).toBeNull();
    expect(parseDeliveryReceiptJournalEntry({ messageId: 'm1', channel: 'slack', state: 'maybe', at: iso(NOW_MS) })).toBeNull();
    expect(parseDeliveryReceiptJournalEntry({ messageId: '', channel: 'slack', state: 'failed', at: iso(NOW_MS) })).toBeNull();
    expect(parseDeliveryReceiptJournalEntry({ channel: 'slack', state: 'failed', at: iso(NOW_MS) })).toBeNull();
    expect(parseDeliveryReceiptJournalEntry({ messageId: 'm1', channel: 'slack', state: 'failed', at: iso(NOW_MS), reason: 42 })).toBeNull();
    expect(parseDeliveryReceiptJournalEntry('nope')).toBeNull();
    expect(parseDeliveryReceiptJournalEntry(null)).toBeNull();
  });

  it('counts malformed lines and off-contract rows without guessing', () => {
    const parsed = parseDeliveryReceiptJournal([
      'not json',
      row({ reason: TRANSPORT_REFUSED }),
      J({ messageId: 'm1', channel: 'pigeon', state: 'failed', at: iso(NOW_MS) }),
      '',
    ].join('\n'));
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.invalidRows).toBe(2);
    expect(parsed.droppedLines).toBe(0);
  });

  it('keeps only the writer line cap and reports the dropped older lines', () => {
    const lines = Array.from({ length: DELIVERY_RECEIPTS_MAX_LINES + 5 }, (_, i) =>
      row({ atMs: NOW_MS - i * 60_000, messageId: `m${i}`, reason: TRANSPORT_REFUSED }));
    const parsed = parseDeliveryReceiptJournal(lines.join('\n'));
    expect(parsed.rows).toHaveLength(DELIVERY_RECEIPTS_MAX_LINES);
    expect(parsed.droppedLines).toBe(5);
    // The kept window is the newest lines: the five oldest rows were dropped.
    expect(parsed.rows[0]!.messageId).toBe('m5');
    expect(parsed.rows[parsed.rows.length - 1]!.messageId).toBe(`m${DELIVERY_RECEIPTS_MAX_LINES + 4}`);
  });
});

describe('deliveryFailureSignal', () => {
  it('maps the writer reason vocabulary exactly', () => {
    expect(deliveryFailureSignal(TRANSPORT_REFUSED)).toBe('transport-refused');
    expect(deliveryFailureSignal(NO_TRANSPORT)).toBe('no-transport');
    expect(deliveryFailureSignal(OWNER_POLICY)).toBe('owner-policy');
    expect(deliveryFailureSignal('Something new the writer learned.')).toBe('unclassified');
    expect(deliveryFailureSignal(null)).toBe('unclassified');
  });

  it('never signals the designed holds', () => {
    for (const reason of [KILL, PAUSED, UNCONFIGURED, NO_SECRET, IMESSAGE_BRIDGE]) {
      expect(deliveryFailureSignal(reason)).toBeNull();
    }
  });
});

describe('foldDeliveryReceiptRows', () => {
  it('classes failed cells and keeps designed holds, undated and outside rows as context', () => {
    const text = [
      row({ atMs: NOW_MS - DAY, messageId: 'm1', channel: 'slack', reason: TRANSPORT_REFUSED }),
      row({ atMs: NOW_MS - DAY + HOUR, messageId: 'm1', channel: 'slack', state: 'delivered' }),
      row({ atMs: NOW_MS - 2 * DAY, messageId: 'm2', channel: 'telegram', reason: NO_TRANSPORT }),
      row({ atMs: NOW_MS - 3 * DAY, messageId: 'm3', channel: 'imessage', reason: KILL }),
      row({ atMs: NOW_MS - 3 * DAY, messageId: 'm4', channel: 'email', reason: PAUSED }),
      row({ atMs: NOW_MS - 4 * DAY, messageId: 'm5', channel: 'desktop', reason: UNCONFIGURED }),
      row({ atMs: NOW_MS - 4 * DAY, messageId: 'm6', channel: 'slack', reason: NO_SECRET }),
      row({ atMs: NOW_MS - 5 * DAY, messageId: 'm7', channel: 'telegram', reason: IMESSAGE_BRIDGE }),
      row({ atMs: null, messageId: 'm8', channel: 'slack', reason: TRANSPORT_REFUSED }), // undated legacy
      row({ atMs: NOW_MS - 30 * DAY, messageId: 'm9', channel: 'slack', reason: TRANSPORT_REFUSED }), // outside
      row({ atMs: NOW_MS - HOUR, messageId: 'm10', channel: 'slack', state: 'delivered' }),
      row({ atMs: NOW_MS - HOUR, messageId: 'm11', channel: 'desktop', state: 'pending' }),
    ].join('\n');
    const fold = foldDeliveryReceiptRows(text, { nowMs: NOW_MS });
    expect(fold.rows).toBe(10); // dated in-window on-contract rows
    expect(fold.deliveredRows).toBe(2);
    expect(fold.pendingRows).toBe(1);
    expect(fold.designedFailedRows).toBe(5);
    expect(fold.undatedRows).toBe(1);
    expect(fold.outsideWindow).toBe(1);
    expect(fold.cells.size).toBe(2);
    const slack = fold.cells.get('slacktransport-refused');
    expect(slack).toMatchObject({ channel: 'slack', signal: 'transport-refused', rows: 1 });
    const telegram = fold.cells.get('telegramno-transport');
    expect(telegram).toMatchObject({ channel: 'telegram', signal: 'no-transport', rows: 1 });
  });
});

describe('deliveryReceiptCells', () => {
  it('emits a cell only at the row, day and distinct-message bars', () => {
    // 3 rows, 2 days, but all one retried send (same messageId) → no cell
    const retried = [
      row({ atMs: NOW_MS - DAY, messageId: 'm1', channel: 'slack', reason: TRANSPORT_REFUSED }),
      row({ atMs: NOW_MS - DAY + HOUR, messageId: 'm1', channel: 'slack', reason: TRANSPORT_REFUSED }),
      row({ atMs: NOW_MS - 2 * DAY, messageId: 'm1', channel: 'slack', reason: TRANSPORT_REFUSED }),
    ].join('\n');
    expect(deliveryReceiptCells(foldDeliveryReceiptRows(retried, { nowMs: NOW_MS }))).toHaveLength(0);
    // 3 rows across 3 days and 3 sends → cell
    const three = recurringFailed().join('\n');
    const cells = deliveryReceiptCells(foldDeliveryReceiptRows(three, { nowMs: NOW_MS }));
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({
      channel: 'slack', signal: 'transport-refused', rows: DELIVERY_RECEIPTS_MIN_ROWS,
      messages: DELIVERY_RECEIPTS_MIN_MESSAGES + 1,
      records: DELIVERY_RECEIPTS_MIN_ROWS, deliveredContext: 0, designedContext: 0,
    });
    expect(cells[0]!.days.length).toBeGreaterThanOrEqual(DELIVERY_RECEIPTS_MIN_DAYS);
    // 3 rows all on one UTC day → below the day bar
    const sameDay = [
      row({ atMs: Date.parse('2026-11-20T01:00:00Z'), messageId: 'm1', channel: 'slack', reason: TRANSPORT_REFUSED }),
      row({ atMs: Date.parse('2026-11-20T05:00:00Z'), messageId: 'm2', channel: 'slack', reason: TRANSPORT_REFUSED }),
      row({ atMs: Date.parse('2026-11-20T09:00:00Z'), messageId: 'm3', channel: 'slack', reason: TRANSPORT_REFUSED }),
    ].join('\n');
    expect(deliveryReceiptCells(foldDeliveryReceiptRows(sameDay, { nowMs: NOW_MS }))).toHaveLength(0);
    // 2 rows across 2 days → below MIN_ROWS
    const two = [
      row({ atMs: NOW_MS - DAY, messageId: 'm1', channel: 'slack', reason: TRANSPORT_REFUSED }),
      row({ atMs: NOW_MS - 2 * DAY, messageId: 'm2', channel: 'slack', reason: TRANSPORT_REFUSED }),
    ].join('\n');
    expect(deliveryReceiptCells(foldDeliveryReceiptRows(two, { nowMs: NOW_MS }))).toHaveLength(0);
  });

  it('splits cells by channel and signal and never emits designed holds', () => {
    const text = [
      ...recurringFailed('slack', TRANSPORT_REFUSED),
      ...recurringFailed('telegram', NO_TRANSPORT),
      row({ atMs: NOW_MS - DAY, messageId: 'm21', channel: 'email', reason: OWNER_POLICY }),
      row({ atMs: NOW_MS - 2 * DAY, messageId: 'm22', channel: 'email', reason: OWNER_POLICY }),
      row({ atMs: NOW_MS - 3 * DAY, messageId: 'm23', channel: 'email', reason: OWNER_POLICY }),
      // A designed hold storm on another channel never forms a cell.
      row({ atMs: NOW_MS - DAY, messageId: 'm31', channel: 'imessage', reason: KILL }),
      row({ atMs: NOW_MS - 2 * DAY, messageId: 'm32', channel: 'imessage', reason: KILL }),
      row({ atMs: NOW_MS - 3 * DAY, messageId: 'm33', channel: 'imessage', reason: KILL }),
      row({ atMs: NOW_MS - DAY, messageId: 'm34', channel: 'imessage', reason: PAUSED }),
      row({ atMs: NOW_MS - 2 * DAY, messageId: 'm35', channel: 'imessage', reason: UNCONFIGURED }),
      row({ atMs: NOW_MS - 3 * DAY, messageId: 'm36', channel: 'imessage', reason: NO_SECRET }),
      row({ atMs: NOW_MS - 4 * DAY, messageId: 'm37', channel: 'imessage', reason: IMESSAGE_BRIDGE }),
    ].join('\n');
    const cells = deliveryReceiptCells(foldDeliveryReceiptRows(text, { nowMs: NOW_MS }));
    // Rows tie at 3, so channel name orders the cells.
    expect(cells.map((c) => `${c.channel}:${c.signal}`)).toEqual([
      'email:owner-policy',
      'slack:transport-refused',
      'telegram:no-transport',
    ]);
    const slack = cells.find((c) => c.channel === 'slack')!;
    // The designed holds on imessage count as context on every cell.
    expect(slack.designedContext).toBe(7);
    expect(slack.records).toBe(16);
  });

  it('marks cells lowerBound when told the tail truncated', () => {
    const fold = foldDeliveryReceiptRows(recurringFailed().join('\n'), { nowMs: NOW_MS });
    expect(deliveryReceiptCells(fold, true)[0]!.lowerBound).toBe(true);
    expect(deliveryReceiptCells(fold, false)[0]!.lowerBound).toBe(false);
  });
});

describe('deliveryReceiptsBacklogItems', () => {
  it('emits an item for the fleet repo only', async () => {
    const file = writeLedger(recurringFailed());
    expect(await deliveryReceiptsBacklogItems({ repo: 'someone/else', journalPath: file, now: NOW })).toEqual([]);
    const items = await deliveryReceiptsBacklogItems({ repo: 'AshlrAI/Phantom', journalPath: file, now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ repo: 'AshlrAI/Phantom', area: 'owner-delivery-transport-refused', priority: 3 });
    expect(items[0]!.id).toMatch(/^delivery-receipts-slack-transport-refused-/);
    expect(validBacklogItem(items[0]!)).not.toBeNull();
  });

  it('never emits message ids or channel-internal strings into prompts', async () => {
    const file = writeLedger(recurringFailed());
    const items = await deliveryReceiptsBacklogItems({ repo: REPO, journalPath: file, now: NOW });
    expect(items).toHaveLength(1);
    for (const id of ['m11', 'm12', 'm13']) {
      expect(items[0]!.prompt).not.toContain(id);
    }
    expect(items[0]!.prompt).toContain('3 distinct message(s)');
    expect(items[0]!.prompt).toContain('Slack');
  });

  it('quotes the recorded reason bounded on unclassified cells', async () => {
    const weird = 'Transport exploded: ' + 'x'.repeat(300);
    const file = writeLedger([
      row({ atMs: NOW_MS - DAY, messageId: 'm1', channel: 'slack', reason: weird }),
      row({ atMs: NOW_MS - 2 * DAY, messageId: 'm2', channel: 'slack', reason: weird }),
      row({ atMs: NOW_MS - 3 * DAY, messageId: 'm3', channel: 'slack', reason: weird }),
    ]);
    const items = await deliveryReceiptsBacklogItems({ repo: REPO, journalPath: file, now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]!.area).toBe('owner-delivery-unclassified');
    expect(items[0]!.prompt).toContain('outside the writer');
    expect(items[0]!.prompt).not.toContain('x'.repeat(200));
    expect(validBacklogItem(items[0]!)).not.toBeNull();
  });

  it('yields nothing for a missing or malformed journal', async () => {
    expect(await deliveryReceiptsBacklogItems({ repo: REPO, journalPath: join(home, 'nope.jsonl'), now: NOW })).toEqual([]);
    const file = writeLedger(['not json', '{"messageId":"m1"}']);
    expect(await deliveryReceiptsBacklogItems({ repo: REPO, journalPath: file, now: NOW })).toEqual([]);
  });

  it('states a lower bound when the byte tail truncated the ledger', async () => {
    // Pad the ledger past the writer's 256 KiB read bound with healthy
    // rows, then append the recurring failed cell inside the retained
    // tail — the fold must mark it a lower bound.
    const noise: string[] = [];
    for (let i = 0; i < 3200; i += 1) {
      noise.push(row({ atMs: NOW_MS - HOUR, messageId: `n${i}`, channel: 'desktop', state: 'delivered' }));
    }
    const file = writeLedger([...noise, ...recurringFailed()]);
    expect(statSync(file).size).toBeGreaterThan(DELIVERY_RECEIPTS_TAIL_BYTES);
    const items = await deliveryReceiptsBacklogItems({ repo: REPO, journalPath: file, now: NOW });
    const cell = items.find((i) => i.area === 'owner-delivery-transport-refused');
    expect(cell).toBeDefined();
    expect(cell!.prompt).toContain('lower bound');
  });

  it('derives stable ids so a refresh re-adds nothing', async () => {
    const file = writeLedger(recurringFailed());
    const first = await deliveryReceiptsBacklogItems({ repo: REPO, journalPath: file, now: NOW });
    const second = await deliveryReceiptsBacklogItems({ repo: REPO, journalPath: file, now: NOW });
    expect(first).toHaveLength(1);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
  });

  it('reads the default ledger path under the runs dir', async () => {
    writeLedger(recurringFailed(), 'custom-runs');
    const items = await deliveryReceiptsBacklogItems({ repo: REPO, runsDir: join(home, 'custom-runs'), now: NOW });
    expect(items).toHaveLength(1);
  });

  it('appends delivery-receipts items through discovery and dedupes on refresh', async () => {
    // discoverBacklog calls the feed with no path overrides, so the feed
    // resolves <realHome()>/.ashlr-runs — under vitest the process-home
    // fixture makes realHome() follow process.env.HOME, so relocate HOME
    // to this test's temp dir and place the ledger at .ashlr-runs/leader.
    process.env['HOME'] = home;
    const dir = join(home, '.ashlr-runs', 'leader');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'delivery-receipts.jsonl'), recurringFailed().join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog(REPO, { gh: greenGh });
    const landed = first.items.filter((i) => i.id.startsWith('delivery-receipts-'));
    expect(landed.length).toBeGreaterThanOrEqual(1);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(landed)).toBe(landed.length);
    const second = await discoverBacklog(REPO, { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('delivery-receipts-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('delivery-receipts-'))).toHaveLength(landed.length);
  });
});
