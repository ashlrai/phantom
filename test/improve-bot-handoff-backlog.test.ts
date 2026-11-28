import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverBacklog } from '../src/core/improve/discover.js';
import {
  botHandoffBacklogItems,
  foldBotHandoffRows,
  parseBotHandoffJournal,
} from '../src/core/improve/bot-handoff-backlog.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

let home: string;
let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };
beforeEach(() => {
  saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
  delete process.env.ASHLR_HOME;
  delete process.env.ASHLR_RUNS_DIR;
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'improve-bothandoff-')));
  process.env.HOME = home;
});
afterEach(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
  fs.rmSync(home, { recursive: true, force: true });
});

const NOW = new Date('2026-11-23T12:00:00Z');
/** ISO timestamp `days` before NOW (each integral value is a distinct UTC day). */
const at = (days: number): string => new Date(NOW.getTime() - days * 86400_000).toISOString();

const REPO = 'ashlrai/phantom';

/** Deterministic 64-hex handoffId inside the writer's sha256 vocabulary. */
const hid = (n: number): string => n.toString(16).padStart(64, '0');

interface Handoff {
  schema?: string;
  handoffId?: string;
  seatId?: string;
  work?: { kind?: string; ref?: unknown };
  done?: unknown;
  left?: unknown;
  branch?: unknown;
  pr?: unknown;
  createdAt?: string;
}

const handoff = (seatId: string, days: number, ref: string, id: number, kind: 'node-job' | 'bus-claim' = 'bus-claim'): Handoff => ({
  schema: 'phantom-bot-handoff.v1',
  handoffId: hid(id),
  seatId,
  work: { kind, ref },
  done: 'unknown',
  left: 'unknown',
  branch: null,
  pr: null,
  createdAt: at(days),
});

const journal = (rows: Array<Handoff | string>): string =>
  rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';

const writeJournal = (rows: Array<Handoff | string> | string): string => {
  const dir = path.join(home, '.phantom', 'bots');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'handoffs.jsonl');
  fs.writeFileSync(file, typeof rows === 'string' ? rows : journal(rows));
  return file;
};

/** devin-bot hands off three distinct claims across three days — seat churn. */
const churnRows = (): Handoff[] => [
  handoff('devin-bot', 3, 'queue:aaa', 1),
  handoff('devin-bot', 2, 'queue:bbb', 2),
  handoff('devin-bot', 1, 'pr:123', 3, 'node-job'),
];

/** queue:ccc bounces across three seats on three days — work re-homing. */
const rehomedRows = (): Handoff[] => [
  handoff('devin-bot', 3, 'queue:ccc', 11),
  handoff('grok-bot', 2, 'queue:ccc', 12),
  handoff('openai-bot', 1, 'queue:ccc', 13),
];

describe('parseBotHandoffJournal', () => {
  it('validates rows against the writer contract and counts contract failures', () => {
    const parsed = parseBotHandoffJournal(journal([
      'not json',
      '{"schema":"other.v1"}',
      JSON.stringify({ ...handoff('devin-bot', 1, 'queue:x', 20), handoffId: 'not-hex' }),
      JSON.stringify({ ...handoff('devin-bot', 1, 'queue:x', 21), seatId: 'Bad Seat!' }),
      JSON.stringify({ ...handoff('devin-bot', 1, 'queue:x', 22), work: { kind: 'cron', ref: 'x' } }),
      JSON.stringify({ ...handoff('devin-bot', 1, 'queue:x', 23), work: { kind: 'bus-claim', ref: 'bad\nref' } }),
      JSON.stringify({ ...handoff('devin-bot', 1, 'queue:x', 24), done: 42 }),
      JSON.stringify({ ...handoff('devin-bot', 1, 'queue:x', 25), createdAt: 'soon' }),
      handoff('devin-bot', 1, 'queue:ok', 26),
      handoff('grok-bot', 1, 'queue:ok2', 27, 'node-job'),
    ]), NOW.getTime());
    expect(parsed.corrupt).toBe(8);
    expect(parsed.rows).toHaveLength(2);
    expect(parsed.rows[0]).toMatchObject({ seatId: 'devin-bot', workKind: 'bus-claim', workRef: 'queue:ok' });
    expect(parsed.rows[1]).toMatchObject({ seatId: 'grok-bot', workKind: 'node-job', workRef: 'queue:ok2' });
  });

  it('dedupes replayed handoffIds keeping the first row', () => {
    const parsed = parseBotHandoffJournal(journal([
      handoff('devin-bot', 1, 'queue:x', 30),
      handoff('devin-bot', 1, 'queue:x', 30),
    ]), NOW.getTime());
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.corrupt).toBe(0);
  });

  it('drops rows outside the window and past the future skew without counting them corrupt', () => {
    const parsed = parseBotHandoffJournal(journal([
      handoff('devin-bot', 9, 'queue:old', 40),
      { ...handoff('devin-bot', 0, 'queue:future', 41), createdAt: new Date(NOW.getTime() + 30 * 60_000).toISOString() },
      handoff('devin-bot', 1, 'queue:in', 42),
    ]), NOW.getTime());
    expect(parsed.corrupt).toBe(0);
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0]!.workRef).toBe('queue:in');
  });
});

describe('foldBotHandoffRows', () => {
  it('builds per-seat and per-work-ref cells with day and seat sets', () => {
    const parsed = parseBotHandoffJournal(journal([...churnRows(), ...rehomedRows()]), NOW.getTime());
    const fold = foldBotHandoffRows(parsed.rows, parsed.corrupt);
    const devin = fold.seats.get('devin-bot');
    expect(devin!.rows).toBe(4);
    expect(devin!.days.size).toBe(3);
    const ccc = fold.workRefs.get('bus-claim:queue:ccc');
    expect(ccc!.rows).toBe(3);
    expect(ccc!.seats).toEqual(new Set(['devin-bot', 'grok-bot', 'openai-bot']));
    // A bus-claim and a node-job sharing ref text stay distinct cells.
    const mixed = foldBotHandoffRows(parseBotHandoffJournal(journal([
      handoff('devin-bot', 1, 'job-1', 50, 'node-job'),
      handoff('devin-bot', 1, 'job-1', 51, 'bus-claim'),
    ]), NOW.getTime()).rows, 0);
    expect(mixed.workRefs.size).toBe(2);
  });
});

describe('botHandoffBacklogItems', () => {
  it('emits seat-churn at three rows across two days and stays quiet below the bars', async () => {
    const items = await botHandoffBacklogItems({ repo: REPO, journalPath: writeJournal(churnRows()), now: NOW });
    const churn = items.filter((i) => i.id.includes('seat-churn'));
    expect(churn).toHaveLength(1);
    expect(churn[0]!.id).toMatch(/^bot-handoff-seat-churn-/);
    expect(churn[0]!.title).toContain('devin-bot');
    expect(churn[0]!.area).toBe('bot-handoff');
    expect(churn[0]!.prompt).toContain('3 recorded releases across 3 distinct UTC day(s)');

    // Three rows on one day only → days bar unmet.
    const sameDay = await botHandoffBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([
        handoff('devin-bot', 1, 'queue:a', 60),
        handoff('devin-bot', 1, 'queue:b', 61),
        handoff('devin-bot', 1, 'queue:c', 62),
      ]),
    });
    expect(sameDay.filter((i) => i.id.includes('seat-churn'))).toEqual([]);

    // Two rows across two days → rows bar unmet.
    const twoRows = await botHandoffBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([handoff('devin-bot', 2, 'queue:a', 63), handoff('devin-bot', 1, 'queue:b', 64)]),
    });
    expect(twoRows.filter((i) => i.id.includes('seat-churn'))).toEqual([]);
  });

  it('emits work-rehomed at three recorded releases of the same ref', async () => {
    const items = await botHandoffBacklogItems({ repo: REPO, journalPath: writeJournal(rehomedRows()), now: NOW });
    const rehomed = items.filter((i) => i.id.includes('work-rehomed'));
    expect(rehomed).toHaveLength(1);
    expect(rehomed[0]!.title).toContain('queue:ccc');
    expect(rehomed[0]!.prompt).toContain('devin-bot, grok-bot, openai-bot');
    expect(items.filter((i) => i.id.includes('seat-churn'))).toEqual([]);

    const two = await botHandoffBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([handoff('devin-bot', 2, 'queue:ccc', 70), handoff('grok-bot', 1, 'queue:ccc', 71)]),
    });
    expect(two.filter((i) => i.id.includes('work-rehomed'))).toEqual([]);
  });

  it('emits corrupt-lines at three contract failures and stays quiet below', async () => {
    const twoBad = await botHandoffBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([handoff('devin-bot', 1, 'queue:x', 80), 'not json', '{"schema":"other"}']),
    });
    expect(twoBad.filter((i) => i.id.includes('corrupt-lines'))).toEqual([]);

    const items = await botHandoffBacklogItems({
      repo: REPO, now: NOW,
      journalPath: writeJournal([
        handoff('devin-bot', 1, 'queue:x', 81),
        'not json',
        '{"schema":"other"}',
        '   ',
        JSON.stringify({ ...handoff('devin-bot', 1, 'queue:y', 82), work: { kind: 'cron', ref: 'y' } }),
      ]),
    });
    const corrupt = items.filter((i) => i.id.includes('corrupt-lines'));
    expect(corrupt).toHaveLength(1);
    expect(corrupt[0]!.prompt).toContain('3 line(s)');
  });

  it('stays quiet on healthy, missing and empty journals', async () => {
    // One handoff per seat per ref: recorded but below every recurring bar.
    const healthy = await botHandoffBacklogItems({ repo: REPO, journalPath: writeJournal(churnRows().slice(0, 1)), now: NOW });
    expect(healthy).toEqual([]);
    expect(await botHandoffBacklogItems({ repo: REPO, journalPath: path.join(home, 'no-such.jsonl'), now: NOW })).toEqual([]);
    expect(await botHandoffBacklogItems({ repo: REPO, journalPath: writeJournal(''), now: NOW })).toEqual([]);
  });

  it('emits only for the fleet repository', async () => {
    const file = writeJournal(churnRows());
    expect(await botHandoffBacklogItems({ repo: 'ashlrai/lexicon', journalPath: file, now: NOW })).toEqual([]);
    expect(await botHandoffBacklogItems({ repo: '', journalPath: file, now: NOW })).toEqual([]);
    expect(await botHandoffBacklogItems({ repo: 'not-a-repo', journalPath: file, now: NOW })).toEqual([]);
    const items = await botHandoffBacklogItems({ repo: 'AshlrAI/Phantom', journalPath: file, now: NOW });
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]).toMatchObject({ repo: 'AshlrAI/Phantom' });
  });

  it('derives stable ids so a refresh re-adds nothing', async () => {
    const file = writeJournal(churnRows());
    const first = await botHandoffBacklogItems({ repo: REPO, journalPath: file, now: NOW });
    const second = await botHandoffBacklogItems({ repo: REPO, journalPath: file, now: NOW });
    expect(first).toHaveLength(1);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    // A later `now` that ages the rows out of the window drops the item.
    const later = await botHandoffBacklogItems({ repo: REPO, journalPath: file, now: new Date(NOW.getTime() + 8 * 86400_000) });
    expect(later).toEqual([]);
  });

  it('honours the item limit and sorts strongest evidence first', async () => {
    const rows: Handoff[] = [
      ...churnRows(),
      // A second churning seat with more rows outranks devin-bot's three.
      handoff('grok-bot', 3, 'queue:d', 90),
      handoff('grok-bot', 2, 'queue:e', 91),
      handoff('grok-bot', 1, 'queue:f', 92),
      handoff('grok-bot', 1, 'queue:g', 93),
    ];
    const items = await botHandoffBacklogItems({ repo: REPO, journalPath: writeJournal(rows), now: NOW, limit: 1 });
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toContain('grok-bot');
  });

  it('reads the default journal path under the Phantom home', async () => {
    writeJournal(churnRows());
    const items = await botHandoffBacklogItems({ repo: REPO, now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toMatch(/^bot-handoff-seat-churn-/);
  });

  it('appends bot-handoff items through discovery and dedupes on refresh', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    try {
      writeJournal(churnRows());
      const greenGh = async (args: string[]) => {
        const p = args[4] ?? '';
        if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
        return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
      };
      const first = await discoverBacklog(REPO, { gh: greenGh });
      const folded = first.items.filter((i) => i.id.startsWith('bot-handoff-'));
      expect(folded).toHaveLength(1);
      expect(folded[0]!.id).toMatch(/^bot-handoff-seat-churn-/);
      expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
      expect(appendUserBacklogItems(folded)).toBe(folded.length);
      const second = await discoverBacklog(REPO, { gh: greenGh });
      expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('bot-handoff-')))).toBe(0);
      expect(readUserBacklogItems().filter((i) => i.id.startsWith('bot-handoff-'))).toHaveLength(folded.length);
    } finally {
      vi.useRealTimers();
    }
  });
});
