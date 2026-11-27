import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { discoverBacklog } from '../src/core/improve/discover.js';
import {
  classifyExpiredRequest,
  commsRequestsBacklogItems,
  COMMS_REQUESTS_BACKLOG_MAX_ITEMS,
  COMMS_REQUESTS_MIN_DAYS,
  COMMS_REQUESTS_MIN_ROWS,
  foldCommsRequestCells,
  parseCommsRequestEntry,
  parseCommsRequestText,
  type CommsRequestRow,
} from '../src/core/improve/comms-requests-backlog.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

let home: string;
let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };
beforeEach(() => {
  saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
  delete process.env.ASHLR_HOME;
  delete process.env.ASHLR_RUNS_DIR;
  home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'improve-comms-req-')));
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

interface StoreRow {
  id?: string;
  kind?: string;
  type?: string;
  text?: string;
  options?: string[];
  status?: string;
  createdAt?: string;
  sentAt?: string;
  answeredAt?: string;
  expiredAt?: string;
  expiredReason?: string;
  sendFailures?: number;
}

let seq = 0;
/** One CommsRequest row under the writer's contract. */
const req = (over: Partial<StoreRow> & { status: string }): StoreRow => ({
  id: `req-${++seq}`,
  kind: 'manager-approval',
  type: 'approval',
  text: 'Approve the deploy?',
  options: ['Yes', 'No'],
  createdAt: at(10),
  ...over,
});

/** A sent-then-TTL-expired question/approval: the 'unanswered' class. */
const unanswered = (kind: string, daysAgo: number, hours = 0): StoreRow =>
  req({ kind, type: 'question', status: 'expired', sentAt: at(daysAgo + 3), expiredAt: at(daysAgo, hours) });

/** A pending request that TTL-expired before dispatch ever sent it. */
const neverSent = (kind: string, daysAgo: number, type: string = 'report'): StoreRow =>
  req({ kind, type, status: 'expired', expiredAt: at(daysAgo) });

/** A pending report retired after repeated transport rejections. */
const sendFailed = (kind: string, daysAgo: number): StoreRow =>
  req({ kind, type: 'report', status: 'expired', sendFailures: 3, expiredAt: at(daysAgo), expiredReason: 'send failed 3 times' });

const journal = (rows: Array<StoreRow | string>): string =>
  rows.map((r) => (typeof r === 'string' ? r : JSON.stringify(r))).join('\n') + '\n';

const writeStore = (rows: Array<StoreRow | string> | string): string => {
  const dir = path.join(home, '.ashlr', 'comms');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'requests.jsonl');
  fs.writeFileSync(file, typeof rows === 'string' ? rows : journal(rows));
  return file;
};

const parsedRow = (over: Partial<CommsRequestRow>): CommsRequestRow => ({
  id: 'r1', kind: 'manager-approval', type: 'approval', status: 'expired',
  createdAtMs: NOW_MS - 10 * 86400_000, sentAtMs: NaN, answeredAtMs: NaN,
  expiredAtMs: NOW_MS - 86400_000, expiredReason: '', sendFailures: undefined,
  ...over,
});

describe('parseCommsRequestEntry / parseCommsRequestText', () => {
  it('keeps contract rows and skips malformed or off-contract lines', () => {
    const { rows, invalidRows } = parseCommsRequestText(journal([
      'not json',
      req({ status: 'expired', expiredAt: at(1) }),
      req({ status: 'sent', sentAt: at(1) }),
      req({ status: 'answered', sentAt: at(3), answeredAt: at(2) }),
      req({ status: 'pending', sendFailures: 2 }),
      // off-contract rows:
      '{"id":"x"}',
      req({ status: 'bogus' }),
      req({ status: 'expired' }), // expired without expiredAt
      req({ status: 'sent', sentAt: 'not-a-date' }),
      req({ status: 'pending', sendFailures: 'three' }),
      req({ status: 'pending', options: 'yes' }),
    ]));
    expect(invalidRows).toBe(7);
    expect(rows).toHaveLength(4);
    expect(rows.map((r) => r.status)).toEqual(['expired', 'sent', 'answered', 'pending']);
  });

  it('parseCommsRequestEntry returns null for non-object and off-contract values', () => {
    expect(parseCommsRequestEntry(null)).toBeNull();
    expect(parseCommsRequestEntry('x')).toBeNull();
    expect(parseCommsRequestEntry({ id: 'x' })).toBeNull();
    expect(parseCommsRequestEntry(req({ status: 'pending' }))).not.toBeNull();
  });
});

describe('classifyExpiredRequest', () => {
  it('classifies the four adverse shapes and skips designed migrations', () => {
    expect(classifyExpiredRequest(parsedRow({ sentAtMs: NOW_MS - 4 * 86400_000 }))).toEqual({ cls: 'unanswered', reasonKey: '' });
    expect(classifyExpiredRequest(parsedRow({ sentAtMs: NaN }))).toEqual({ cls: 'never-sent', reasonKey: '' });
    expect(classifyExpiredRequest(parsedRow({ expiredReason: 'send failed 3 times' }))).toEqual({ cls: 'send-failures', reasonKey: '' });
    expect(classifyExpiredRequest(parsedRow({ expiredReason: 'send failed 12 times' }))).toEqual({ cls: 'send-failures', reasonKey: '' });
    expect(classifyExpiredRequest(parsedRow({ expiredReason: 'queue purge v2' }))).toEqual({ cls: 'unclassified', reasonKey: 'queue purge v2' });
    expect(classifyExpiredRequest(parsedRow({ expiredReason: 'migration: legacy Strategist briefing retired (3.14)' }))).toBeNull();
    // An explicit reason wins over the sentAt fallback.
    expect(classifyExpiredRequest(parsedRow({ sentAtMs: NOW_MS - 86400_000, expiredReason: 'send failed 3 times' }))).toEqual({ cls: 'send-failures', reasonKey: '' });
  });
});

describe('foldCommsRequestCells', () => {
  const foldRow = (over: Partial<CommsRequestRow>): CommsRequestRow => parsedRow(over);

  it('keys cells on kind+class and counts answered rows as delivered context', () => {
    const { cells, delivered, expiredRows, designedRows } = foldCommsRequestCells([
      foldRow({ id: 'a', kind: 'manager-approval', sentAtMs: NOW_MS - 5 * 86400_000, expiredAtMs: NOW_MS - 86400_000 }),
      foldRow({ id: 'b', kind: 'manager-approval', sentAtMs: NOW_MS - 6 * 86400_000, expiredAtMs: NOW_MS - 2 * 86400_000 }),
      foldRow({ id: 'c', kind: 'manager-approval', sentAtMs: NOW_MS - 7 * 86400_000, expiredAtMs: NOW_MS - 3 * 86400_000 }),
      foldRow({ id: 'd', kind: 'leader-veto', sentAtMs: NaN, expiredAtMs: NOW_MS - 86400_000 }),
      foldRow({ id: 'e', kind: 'fleet-digest', status: 'answered', answeredAtMs: NOW_MS - 86400_000, expiredAtMs: NaN }),
      foldRow({ id: 'f', kind: 'fleet-digest', status: 'answered', answeredAtMs: NaN, createdAtMs: NOW_MS - 2 * 86400_000, expiredAtMs: NaN }),
      foldRow({ id: 'g', kind: 'manager-approval', status: 'pending', expiredAtMs: NaN }),
      foldRow({ id: 'h', kind: 'elon-vision', expiredReason: 'migration: legacy Strategist briefing retired (3.14)', expiredAtMs: NOW_MS - 86400_000 }),
    ], NOW_MS);
    expect(expiredRows).toBe(4);
    expect(designedRows).toBe(1);
    expect(delivered.get('fleet-digest')).toBe(2);
    // manager-approval unanswered: 3 rows but only 2... check days: expiredAt days are -1,-2,-3 → 3 distinct days.
    expect(cells.map((c) => [c.kind, c.cls, c.rows, c.days.size])).toEqual([
      ['manager-approval', 'unanswered', 3, 3],
    ]);
    // leader-veto never-sent has 1 row — under the bars.
  });

  it('splits unclassified cells by normalized reason and windows on expiredAt', () => {
    const { cells } = foldCommsRequestCells([
      foldRow({ id: 'a', kind: 'k', expiredReason: 'Queue Purge V2', expiredAtMs: NOW_MS - 86400_000 }),
      foldRow({ id: 'b', kind: 'k', expiredReason: 'queue purge v2', expiredAtMs: NOW_MS - 2 * 86400_000 }),
      foldRow({ id: 'c', kind: 'k', expiredReason: 'queue purge v2', expiredAtMs: NOW_MS - 3 * 86400_000 }),
      foldRow({ id: 'd', kind: 'k', expiredReason: 'other reason', expiredAtMs: NOW_MS - 86400_000 }),
      foldRow({ id: 'e', kind: 'k', expiredReason: 'other reason', expiredAtMs: NOW_MS - 2 * 86400_000 }),
      foldRow({ id: 'f', kind: 'k', expiredReason: 'other reason', expiredAtMs: NOW_MS - 9 * 86400_000 }), // outside window
    ], NOW_MS);
    expect(cells.map((c) => [c.key, c.rows])).toEqual([
      ['k:unclassified:queue purge v2', 3],
    ]);
  });

  it('drops expired rows outside the window and beyond the future-skew allowance', () => {
    const { cells, expiredRows } = foldCommsRequestCells([
      foldRow({ id: 'a', expiredAtMs: NOW_MS - 8 * 86400_000 }),
      foldRow({ id: 'b', expiredAtMs: NOW_MS - 9 * 86400_000 }),
      foldRow({ id: 'c', expiredAtMs: NOW_MS - 10 * 86400_000 }),
      foldRow({ id: 'd', expiredAtMs: NOW_MS + 2 * 3600_000 }),
      foldRow({ id: 'e', expiredAtMs: NOW_MS + 30_000 }), // inside skew, but only 1 row
    ], NOW_MS);
    expect(expiredRows).toBe(1);
    expect(cells).toEqual([]);
  });
});

describe('commsRequestsBacklogItems', () => {
  it('turns recurring unanswered expiries into a valid item', async () => {
    const items = await commsRequestsBacklogItems({
      repo: REPO, now: NOW, requestsPath: writeStore([
        unanswered('manager-approval', 1),
        unanswered('manager-approval', 3),
        unanswered('manager-approval', 5),
        req({ kind: 'manager-approval', type: 'approval', status: 'answered', sentAt: at(2), answeredAt: at(2) }),
      ]),
    });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(validBacklogItem(item)).not.toBeNull();
    expect(item).toMatchObject({ priority: 3, repo: REPO, area: 'comms-requests' });
    expect(item.id).toMatch(/^commsreq-[0-9a-f]{16}$/);
    expect(item.title).toContain("'manager-approval'");
    expect(item.title).toContain('unanswered');
    expect(item.prompt).toContain('requests.jsonl');
    expect(item.prompt).toContain('3 expired');
    expect(item.prompt).toContain('distinct UTC day(s)');
    expect(item.prompt).toContain('answered request(s)');
    expect(item.prompt).toContain('no-change');
  });

  it('emits per-class items for never-sent and send-failure cells', async () => {
    const items = await commsRequestsBacklogItems({
      repo: REPO, now: NOW, requestsPath: writeStore([
        neverSent('fleet-digest', 1), neverSent('fleet-digest', 3), neverSent('fleet-digest', 5),
        sendFailed('fleet-status', 1), sendFailed('fleet-status', 2), sendFailed('fleet-status', 4),
      ]),
    });
    expect(items).toHaveLength(2);
    const kinds = items.map((i) => i.prompt).join('\n');
    expect(kinds).toContain('expiring unsent');
    expect(kinds).toContain('expiring on send failures');
    expect(items.every((i) => validBacklogItem(i) !== null)).toBe(true);
  });

  it('emits nothing below the recurring bars of rows and distinct days', async () => {
    // Three rows but a single UTC day — under the days bar.
    const oneDay = writeStore([
      unanswered('manager-approval', 1),
      unanswered('manager-approval', 1, 3),
      unanswered('manager-approval', 1, 6),
    ]);
    expect(await commsRequestsBacklogItems({ repo: REPO, requestsPath: oneDay, now: NOW })).toEqual([]);
    // Two rows across two days — under the rows bar.
    const twoRows = writeStore([
      unanswered('manager-approval', 1),
      unanswered('manager-approval', 3),
    ]);
    expect(await commsRequestsBacklogItems({ repo: REPO, requestsPath: twoRows, now: NOW })).toEqual([]);
    expect(COMMS_REQUESTS_MIN_ROWS).toBe(3);
    expect(COMMS_REQUESTS_MIN_DAYS).toBe(2);
  });

  it('yields nothing for a missing or malformed store', async () => {
    expect(await commsRequestsBacklogItems({ repo: REPO, requestsPath: path.join(home, 'no-such.jsonl'), now: NOW })).toEqual([]);
    const file = writeStore([
      'not json',
      '{"id":"x"}',
      unanswered('manager-approval', 1),
    ]);
    expect(await commsRequestsBacklogItems({ repo: REPO, requestsPath: file, now: NOW })).toEqual([]);
    expect(await commsRequestsBacklogItems({ repo: '', requestsPath: file, now: NOW })).toEqual([]);
    expect(await commsRequestsBacklogItems({ repo: 'not-a-repo', requestsPath: file, now: NOW })).toEqual([]);
  });

  it('emits nothing for another repository', async () => {
    const file = writeStore([
      unanswered('manager-approval', 1),
      unanswered('manager-approval', 3),
      unanswered('manager-approval', 5),
    ]);
    expect(await commsRequestsBacklogItems({ repo: 'ashlrai/other', requestsPath: file, now: NOW })).toEqual([]);
    expect(await commsRequestsBacklogItems({ repo: 'AshlrAI/Phantom', requestsPath: file, now: NOW })).toHaveLength(1);
  });

  it('designed migration expiries and live queue rows never emit', async () => {
    const file = writeStore([
      // Three migration-reason expiries across three days — designed, never cells.
      req({ kind: 'elon-vision', type: 'question', status: 'expired', sentAt: at(8), expiredAt: at(1), expiredReason: 'migration: legacy Strategist briefing retired (3.14)' }),
      req({ kind: 'elon-vision', type: 'question', status: 'expired', sentAt: at(9), expiredAt: at(3), expiredReason: 'migration: Leader memos are delivered through the Leader thread (3.14)' }),
      req({ kind: 'elon-vision', type: 'question', status: 'expired', sentAt: at(10), expiredAt: at(5), expiredReason: 'migration: pending digest older than 24h (3.14)' }),
      // Live queue state — pending, sent and answered rows are not adverse.
      req({ kind: 'manager-approval', type: 'approval', status: 'pending', createdAt: at(1) }),
      req({ kind: 'manager-approval', type: 'approval', status: 'sent', sentAt: at(1) }),
      req({ kind: 'manager-approval', type: 'approval', status: 'answered', sentAt: at(3), answeredAt: at(2) }),
    ]);
    expect(await commsRequestsBacklogItems({ repo: REPO, requestsPath: file, now: NOW })).toEqual([]);
  });

  it('states truncation as a lower bound in the prompt', async () => {
    const file = writeStore([
      unanswered('manager-approval', 1),
      unanswered('manager-approval', 3),
      unanswered('manager-approval', 5),
    ]);
    // Pad the store past the 512 KiB tail so the read reports truncated.
    fs.writeFileSync(file, 'x'.repeat(600 * 1024) + '\n' + fs.readFileSync(file, 'utf8'));
    const items = await commsRequestsBacklogItems({ repo: REPO, requestsPath: file, now: NOW });
    expect(items.length).toBeGreaterThan(0);
    for (const item of items) expect(item.prompt).toContain('lower bound');
  });

  it('derives stable ids so a refresh re-adds nothing', async () => {
    const rows = [
      unanswered('manager-approval', 1),
      unanswered('manager-approval', 3),
      unanswered('manager-approval', 5),
    ];
    const file = writeStore(rows);
    const first = await commsRequestsBacklogItems({ repo: REPO, requestsPath: file, now: NOW });
    const second = await commsRequestsBacklogItems({ repo: REPO, requestsPath: file, now: NOW });
    expect(first.length).toBeGreaterThan(0);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    const grown = writeStore([...rows, unanswered('manager-approval', 6)]);
    const third = await commsRequestsBacklogItems({ repo: REPO, requestsPath: grown, now: NOW });
    expect(third.map((i) => i.id)).toEqual(first.map((i) => i.id));
    expect(first.length).toBeLessThanOrEqual(COMMS_REQUESTS_BACKLOG_MAX_ITEMS);
  });

  it('reads the default store path under ~/.ashlr/comms', async () => {
    writeStore([
      unanswered('manager-approval', 1),
      unanswered('manager-approval', 3),
      unanswered('manager-approval', 5),
    ]);
    const items = await commsRequestsBacklogItems({ repo: REPO, now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]!.id.startsWith('commsreq-')).toBe(true);
  });

  it('appends comms-request items through discovery and dedupes on refresh', async () => {
    const now = Date.now();
    const sentAt = new Date(now - 6 * 86400_000).toISOString();
    const createdAt = new Date(now - 8 * 86400_000).toISOString();
    writeStore([1, 3, 5].map((days) => ({
      id: `req-${days}`, kind: 'manager-approval', type: 'approval', text: 'Approve?', options: ['Yes', 'No'],
      status: 'expired', createdAt, sentAt, expiredAt: new Date(now - days * 86400_000).toISOString(),
    })));
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog(REPO, { gh: greenGh });
    const commsItems = first.items.filter((i) => i.id.startsWith('commsreq-'));
    expect(commsItems).toHaveLength(1);
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(commsItems)).toBe(commsItems.length);
    const second = await discoverBacklog(REPO, { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('commsreq-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('commsreq-'))).toHaveLength(commsItems.length);
  });
});
