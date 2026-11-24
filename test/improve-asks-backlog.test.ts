import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverBacklog } from '../src/core/improve/discover.js';
import {
  asksLedgerBacklogItems,
  ASKS_BACKLOG_MAX_ITEMS,
  ASKS_MIN_DAYS,
  ASKS_MIN_UNITS,
  foldAskLedgerCells,
  parseAskLedgerEntry,
  parseAskLedgerText,
  type AskLedgerRow,
} from '../src/core/improve/asks-backlog.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

let home: string;
let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };
beforeEach(() => {
  saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
  delete process.env.ASHLR_HOME;
  delete process.env.ASHLR_RUNS_DIR;
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'improve-asks-')));
  process.env.HOME = home;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(home, { recursive: true, force: true });
});

const NOW = new Date('2026-11-23T12:00:00Z');
const NOW_MS = NOW.getTime();
/** ISO timestamp `days` before NOW (fractional hours allowed via `hours`). */
const at = (days: number, hours = 0): string =>
  new Date(NOW_MS - days * 86400_000 + hours * 3600_000).toISOString();

const REPO = 'ashlrai/phantom';

interface LedgerRow {
  schema?: string;
  type?: string;
  askId?: string;
  kind?: string;
  subject?: string | null;
  channel?: string;
  source?: string;
  at?: string;
  reply?: string;
  action?: string;
  question?: string;
  pool?: string;
  pctUsed?: number;
  decision?: string;
}

/** One asks.ledger.v1 mason-answer row under the writer's contract. */
const mason = (over: Partial<LedgerRow> & { kind: string }): LedgerRow => ({
  schema: 'asks.ledger.v1',
  type: 'answer',
  askId: 'ask-1',
  subject: null,
  channel: 'cli',
  source: 'mason',
  at: at(1),
  reply: 'yes',
  ...over,
});

/** One asks.ledger.v1 fleet self-answer row under the writer's contract. */
const fleet = (over: Partial<LedgerRow> & { kind: string }): LedgerRow => ({
  schema: 'asks.ledger.v1',
  type: 'fleet-action',
  askId: 'fleet-1',
  subject: 'claude',
  channel: 'fleet',
  source: 'fleet',
  at: at(1),
  reply: '',
  action: 'read from sensor usage-history at 2026-11-22T00:00:00Z: claude is 40% used',
  question: 'what is claude usage',
  ...over,
});

const journal = (rows: Array<LedgerRow | string>): string =>
  rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';

const writeJournal = (rows: Array<LedgerRow | string> | string, name = 'asks-ledger.jsonl'): string => {
  const dir = path.join(home, '.ashlr-runs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, name);
  fs.writeFileSync(file, typeof rows === 'string' ? rows : journal(rows));
  return file;
};

const row = (kind: string, subject: string | null, type: string, daysAgo: number, hours = 0, extra: Partial<LedgerRow> = {}): LedgerRow =>
  mason({ kind, subject, type, at: at(daysAgo, hours), ...extra });

describe('parseAskLedgerEntry / parseAskLedgerText', () => {
  it('keeps contract mason and fleet-action rows and skips malformed or off-contract lines', () => {
    const { rows, invalidRows } = parseAskLedgerText(journal([
      'not json',
      '{"schema":"other.v1","kind":"usage","source":"mason","at":"2026-11-22T00:00:00Z"}',
      '{"schema":"asks.ledger.v1","kind":"usage","source":"mason","at":"not-a-date"}',
      '{"schema":"asks.ledger.v1","kind":"usage","source":"mason","at":"2026-11-22T00:00:00Z"}', // missing type/channel/reply
      mason({ kind: 'usage', type: 'usage-reading', subject: 'claude', reply: '40', pool: 'claude', pctUsed: 40, at: at(1) }),
      mason({ kind: 'approval', type: 'approval', subject: 'deploy-x', reply: 'yes', decision: 'yes', at: at(2) }),
      fleet({ kind: 'usage', subject: 'claude', at: at(1) }),
      '{"schema":"asks.ledger.v1","kind":"usage","source":"fleet","type":"fleet-action","at":"2026-11-22T00:00:00Z"}', // fleet without action
    ]));
    expect(invalidRows).toBe(5);
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ source: 'mason', kind: 'usage', subject: 'claude', type: 'usage-reading' });
    expect(rows[1]).toMatchObject({ source: 'mason', kind: 'approval', subject: 'deploy-x', type: 'approval', decision: 'yes' });
    expect(rows[2]).toMatchObject({ source: 'fleet', kind: 'usage', type: 'fleet-action' });
  });

  it('parseAskLedgerEntry returns null for non-object and off-contract values', () => {
    expect(parseAskLedgerEntry(null)).toBeNull();
    expect(parseAskLedgerEntry('x')).toBeNull();
    expect(parseAskLedgerEntry({ schema: 'asks.ledger.v1', source: 'mason', at: 'bad' })).toBeNull();
    expect(parseAskLedgerEntry({ schema: 'asks.ledger.v1', source: 'mason', type: 'answer', kind: 'x', channel: 'cli', reply: 'y', at: '2026-11-22T00:00:00Z' })).not.toBeNull();
  });
});

describe('foldAskLedgerCells', () => {
  const askRow = (kind: string, subject: string | null, source: 'mason' | 'fleet', daysAgo: number, hours = 0): AskLedgerRow => ({
    atMs: NOW_MS - daysAgo * 86400_000 + hours * 3600_000,
    utcDay: new Date(NOW_MS - daysAgo * 86400_000 + hours * 3600_000).toISOString().slice(0, 10),
    source, kind, subject: subject ?? '', channel: source === 'fleet' ? 'fleet' : 'cli',
    type: source === 'fleet' ? 'fleet-action' : 'answer', reply: '', decision: '',
  });

  it('keys mason cells on kind+subject and counts fleet self-answers per kind as context', () => {
    const { cells, fleetActions, masonRows, fleetRows } = foldAskLedgerCells([
      askRow('usage', 'claude', 'mason', 1),
      askRow('usage', 'claude', 'mason', 2),
      askRow('usage', 'claude', 'mason', 3),
      askRow('usage', 'codex', 'mason', 1),
      askRow('approval', 'deploy-x', 'mason', 1),
      askRow('usage', 'claude', 'fleet', 1),
      askRow('usage', 'claude', 'fleet', 2),
    ], NOW_MS);
    expect(masonRows).toBe(5);
    expect(fleetRows).toBe(2);
    expect(fleetActions.get('usage')).toBe(2);
    // usage@claude has 3 mason rows; usage@codex and approval@deploy-x have 1 each — under the bars.
    expect(cells.map((c) => [c.kind, c.subject, c.rows])).toEqual([['usage', 'claude', 3]]);
  });

  it('drops rows outside the window and beyond the future-skew allowance', () => {
    const { cells, masonRows } = foldAskLedgerCells([
      askRow('usage', 'claude', 'mason', 8),
      askRow('usage', 'claude', 'mason', 9),
      askRow('usage', 'claude', 'mason', 10),
      askRow('usage', 'claude', 'mason', -1),
      askRow('usage', 'claude', 'mason', -1, 2),
      askRow('usage', 'claude', 'mason', 1),
      askRow('usage', 'claude', 'mason', 2),
    ], NOW_MS);
    expect(masonRows).toBe(2);
    expect(cells).toEqual([]);
  });
});

describe('asksLedgerBacklogItems', () => {
  it('turns a recurring mason-answered ask kind into a valid item', async () => {
    const items = await asksLedgerBacklogItems({
      repo: REPO, now: NOW, journalPath: writeJournal([
        row('usage', 'claude', 'usage-reading', 1, 0, { reply: '40', pool: 'claude', pctUsed: 40 }),
        row('usage', 'claude', 'usage-reading', 2, 0, { reply: '55', pool: 'claude', pctUsed: 55 }),
        row('usage', 'claude', 'usage-reading', 4, 0, { reply: '61', pool: 'claude', pctUsed: 61 }),
        row('usage', 'claude', 'usage-reading', 5, 0, { reply: '70', pool: 'claude', pctUsed: 70 }),
        fleet({ kind: 'usage', subject: 'claude', at: at(3) }),
        fleet({ kind: 'usage', subject: 'claude', at: at(6) }),
      ]),
    });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item).toMatchObject({ priority: 3, repo: REPO, area: 'asks-mason' });
    expect(item.id).toMatch(/^asks-[0-9a-f]{16}$/);
    expect(item.title).toContain("'usage' on 'claude'");
    expect(item.prompt).toContain('asks-ledger.jsonl');
    expect(item.prompt).toContain('4 mason-sourced');
    expect(item.prompt).toContain('distinct UTC day(s)');
    expect(item.prompt).toContain('self-answered 2');
    expect(item.prompt).toContain('no-change');
  });

  it('emits nothing below the recurring bars of rows and distinct days', async () => {
    // Three rows but a single UTC day — under the days bar.
    const oneDay = writeJournal([
      row('usage', 'claude', 'usage-reading', 1),
      row('usage', 'claude', 'usage-reading', 1, 3),
      row('usage', 'claude', 'usage-reading', 1, 6),
    ]);
    expect(await asksLedgerBacklogItems({ repo: REPO, journalPath: oneDay, now: NOW })).toEqual([]);
    // Two rows across two days — under the units bar.
    const twoRows = writeJournal([
      row('usage', 'claude', 'usage-reading', 1),
      row('usage', 'claude', 'usage-reading', 3),
    ]);
    expect(await asksLedgerBacklogItems({ repo: REPO, journalPath: twoRows, now: NOW })).toEqual([]);
    expect(ASKS_MIN_UNITS).toBe(3);
    expect(ASKS_MIN_DAYS).toBe(2);
  });

  it('yields nothing for a missing or malformed journal', async () => {
    expect(await asksLedgerBacklogItems({ repo: REPO, journalPath: path.join(home, 'no-such.jsonl'), now: NOW })).toEqual([]);
    const file = writeJournal([
      'not json',
      '{"schema":"other.v1","kind":"usage","source":"mason","at":"2026-11-22T00:00:00Z"}',
      '{"schema":"asks.ledger.v1","kind":"usage","source":"mason","at":"2026-11-22T00:00:00Z"}',
    ]);
    expect(await asksLedgerBacklogItems({ repo: REPO, journalPath: file, now: NOW })).toEqual([]);
    expect(await asksLedgerBacklogItems({ repo: '', journalPath: file, now: NOW })).toEqual([]);
    expect(await asksLedgerBacklogItems({ repo: 'not-a-repo', journalPath: file, now: NOW })).toEqual([]);
  });

  it('emits nothing for another repository or an empty repo', async () => {
    const file = writeJournal([
      row('usage', 'claude', 'usage-reading', 1),
      row('usage', 'claude', 'usage-reading', 3),
      row('usage', 'claude', 'usage-reading', 5),
    ]);
    expect(await asksLedgerBacklogItems({ repo: 'ashlrai/other', journalPath: file, now: NOW })).toEqual([]);
    expect(await asksLedgerBacklogItems({ repo: 'AshlrAI/Phantom', journalPath: file, now: NOW })).toHaveLength(1);
  });

  it('drops rows outside the 7-day window and beyond the future-skew allowance', async () => {
    const stale = writeJournal([
      row('usage', 'claude', 'usage-reading', 8),
      row('usage', 'claude', 'usage-reading', 9),
      row('usage', 'claude', 'usage-reading', 10),
    ]);
    expect(await asksLedgerBacklogItems({ repo: REPO, journalPath: stale, now: NOW })).toEqual([]);
    const future = writeJournal([
      row('usage', 'claude', 'usage-reading', -1),
      row('usage', 'claude', 'usage-reading', -1, 2),
      row('usage', 'claude', 'usage-reading', -1, 3),
    ]);
    expect(await asksLedgerBacklogItems({ repo: REPO, journalPath: future, now: NOW })).toEqual([]);
  });

  it('states truncation as a lower bound in the prompt', async () => {
    const file = writeJournal([
      row('usage', 'claude', 'usage-reading', 1),
      row('usage', 'claude', 'usage-reading', 3),
      row('usage', 'claude', 'usage-reading', 5),
    ]);
    // Pad the journal past the 512 KiB tail so the read reports truncated.
    fs.writeFileSync(file, 'x'.repeat(600 * 1024) + '\n' + fs.readFileSync(file, 'utf8'));
    const items = await asksLedgerBacklogItems({ repo: REPO, journalPath: file, now: NOW });
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) expect(item.prompt).toContain('lower bound');
  });

  it('derives stable ids so a refresh re-adds nothing', async () => {
    const rows = [
      row('usage', 'claude', 'usage-reading', 1),
      row('usage', 'claude', 'usage-reading', 3),
      row('usage', 'claude', 'usage-reading', 5),
    ];
    const file = writeJournal(rows);
    const first = await asksLedgerBacklogItems({ repo: REPO, journalPath: file, now: NOW });
    const second = await asksLedgerBacklogItems({ repo: REPO, journalPath: file, now: NOW });
    expect(first.length).toBeGreaterThan(0);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    // Shifted tallies on the same cells re-derive the same ids.
    const grown = writeJournal([...rows, row('usage', 'claude', 'usage-reading', 6)]);
    const third = await asksLedgerBacklogItems({ repo: REPO, journalPath: grown, now: NOW });
    expect(third.map((i) => i.id)).toEqual(first.map((i) => i.id));
    expect(first.length).toBeLessThanOrEqual(ASKS_BACKLOG_MAX_ITEMS);
  });

  it('reads the default journal path under the runs dir', async () => {
    // The writer's own layout: <runs dir>/asks-ledger.jsonl.
    writeJournal([
      row('usage', 'claude', 'usage-reading', 1),
      row('usage', 'claude', 'usage-reading', 3),
      row('usage', 'claude', 'usage-reading', 5),
    ]);
    const items = await asksLedgerBacklogItems({ repo: REPO, now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]!.id.startsWith('asks-')).toBe(true);
  });

  it('appends ask items through discovery and dedupes on refresh', async () => {
    writeJournal([
      row('usage', 'claude', 'usage-reading', 1),
      row('usage', 'claude', 'usage-reading', 3),
      row('usage', 'claude', 'usage-reading', 5),
    ]);
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog(REPO, { gh: greenGh });
    const askItems = first.items.filter((i) => i.id.startsWith('asks-'));
    expect(askItems).toHaveLength(1);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(askItems)).toBe(askItems.length);
    const second = await discoverBacklog(REPO, { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('asks-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('asks-'))).toHaveLength(askItems.length);
  });
});
