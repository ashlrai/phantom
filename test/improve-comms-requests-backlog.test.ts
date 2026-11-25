import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  COMMS_REQUESTS_MIN_DAYS,
  COMMS_REQUESTS_MIN_ROWS,
  COMMS_REQUESTS_TAIL_BYTES,
  commsRequestCells,
  commsRequestsBacklogItems,
  foldCommsRequests,
} from '../src/core/improve/comms-requests-backlog.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import { appendUserBacklogItems, readUserBacklogItems, validBacklogItem } from '../src/core/cloud/backlog.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const J = (o: Record<string, unknown>): string => JSON.stringify(o);

/** Fixed evaluation instant; fixture timestamps are ISO-8601 UTC like the store's stamps. */
const NOW_MS = Date.parse('2026-11-23T12:00:00.000Z');
const iso = (ms: number): string => new Date(ms).toISOString();

let seq = 0;

/**
 * One CommsRequest row in the writer's persisted shape. Defaults describe
 * an expired 'fleet-digest' report; every free-text field carries a
 * marker so tests can prove prompts never surface request bodies.
 */
function reqRow(spec: {
  kind?: string;
  type?: 'question' | 'approval' | 'report' | string;
  status?: string;
  createdAtMs?: number;
  sentAtMs?: number | null;
  answeredAtMs?: number | null;
  expiredAtMs?: number | null;
  expiredReason?: string | null;
  sendFailures?: number;
  extra?: Record<string, unknown>;
} = {}): string {
  seq += 1;
  const status = spec.status ?? 'expired';
  const row: Record<string, unknown> = {
    id: `req-${seq}`,
    kind: spec.kind ?? 'fleet-digest',
    type: spec.type ?? 'report',
    text: 'FREE-TEXT-BODY-NEVER-SURFACED',
    options: ['FREE-TEXT-OPTION-NEVER-SURFACED'],
    status,
    createdAt: iso(spec.createdAtMs ?? NOW_MS - 3 * DAY),
    meta: { note: 'FREE-TEXT-META-NEVER-SURFACED' },
  };
  if (spec.sentAtMs !== undefined && spec.sentAtMs !== null) row['sentAt'] = iso(spec.sentAtMs);
  if (spec.answeredAtMs !== undefined && spec.answeredAtMs !== null) row['answeredAt'] = iso(spec.answeredAtMs);
  if (spec.expiredAtMs !== undefined && spec.expiredAtMs !== null) row['expiredAt'] = iso(spec.expiredAtMs);
  if (spec.expiredReason !== undefined && spec.expiredReason !== null) row['expiredReason'] = spec.expiredReason;
  if (spec.sendFailures !== undefined) row['sendFailures'] = spec.sendFailures;
  if (spec.extra) Object.assign(row, spec.extra);
  return J(row);
}

/** An expiry that reached the owner and died unanswered (sentAt set, TTL expiry). */
function unansweredRow(spec: Parameters<typeof reqRow>[0] = {}): string {
  return reqRow({
    sentAtMs: (spec.createdAtMs ?? NOW_MS - 3 * DAY) + HOUR,
    expiredAtMs: NOW_MS - DAY,
    ...spec,
  });
}

/** An expiry that never left pending — no sentAt, TTL expiry. */
function unsentRow(spec: Parameters<typeof reqRow>[0] = {}): string {
  return reqRow({ expiredAtMs: NOW_MS - DAY, ...spec });
}

/** An expiry noteSendFailure stamped after repeated transport rejections. */
function sendFailureRow(spec: Parameters<typeof reqRow>[0] = {}): string {
  return reqRow({
    expiredReason: 'send failed 3 times',
    sendFailures: 3,
    expiredAtMs: NOW_MS - DAY,
    ...spec,
  });
}

/** A recurring (kind, class) series: `days` distinct UTC days, `perDay` rows each. */
function expirySeries(opts: {
  kind?: string;
  type?: 'question' | 'approval' | 'report';
  cls?: 'unanswered' | 'unsent' | 'send-failure';
  days?: number;
  perDay?: number;
}): string[] {
  const rows: string[] = [];
  const days = opts.days ?? COMMS_REQUESTS_MIN_DAYS + 1;
  const perDay = opts.perDay ?? 1;
  const base = { kind: opts.kind, type: opts.type };
  for (let d = 0; d < days; d++) {
    for (let i = 0; i < perDay; i++) {
      const expiredAtMs = NOW_MS - d * DAY - i * HOUR - HOUR;
      if (opts.cls === 'send-failure') rows.push(sendFailureRow({ ...base, expiredAtMs }));
      else if (opts.cls === 'unsent') rows.push(unsentRow({ ...base, expiredAtMs }));
      else rows.push(unansweredRow({ ...base, expiredAtMs }));
    }
  }
  return rows;
}

describe('foldCommsRequests', () => {
  it('classifies expired rows into send-failure, unanswered and unsent', () => {
    const text = [
      sendFailureRow({ expiredAtMs: NOW_MS - DAY }),
      unansweredRow({ kind: 'manager-approval', type: 'approval', expiredAtMs: NOW_MS - 2 * DAY }),
      unsentRow({ kind: 'fleet-digest', expiredAtMs: NOW_MS - 3 * DAY }),
      // A non-migration caller reason still splits on sentAt.
      reqRow({ kind: 'custom', expiredReason: 'superseded by newer ask', sentAtMs: NOW_MS - 4 * DAY, expiredAtMs: NOW_MS - DAY }),
      reqRow({ kind: 'custom2', expiredReason: 'superseded by newer ask', expiredAtMs: NOW_MS - DAY }),
    ].join('\n');
    const fold = foldCommsRequests([text], NOW_MS, 168);
    expect(fold.requests).toBe(5);
    expect(fold.expired).toBe(5);
    expect(fold.malformed).toBe(0);
    expect(fold.cells.size).toBe(5);
    const classes = [...fold.cells.values()].map((c) => `${c.type}|${c.kind}|${c.expiryClass}`).sort();
    expect(classes).toEqual([
      'approval|manager-approval|unanswered',
      'report|custom2|unsent',
      'report|custom|unanswered',
      'report|fleet-digest|send-failure',
      'report|fleet-digest|unsent',
    ]);
  });

  it('excludes migration cleanups, live rows and out-of-window expiries', () => {
    const text = [
      // The one-time 3.14 cleanup — designed, never friction.
      reqRow({ kind: 'fleet-digest', expiredReason: 'migration: pending digest older than 24h (3.14)', expiredAtMs: NOW_MS - DAY }),
      reqRow({ kind: 'leader-memo', type: 'question', expiredReason: 'migration: Leader memos are delivered through the Leader thread (3.14)', sentAtMs: NOW_MS - 4 * DAY, expiredAtMs: NOW_MS - DAY }),
      // Live queue state: pending, sent and answered rows are not evidence.
      reqRow({ status: 'pending', createdAtMs: NOW_MS - DAY }),
      reqRow({ status: 'sent', kind: 'leader-veto', type: 'question', sentAtMs: NOW_MS - 2 * DAY, createdAtMs: NOW_MS - 3 * DAY }),
      reqRow({ status: 'answered', kind: 'manager-approval', type: 'approval', sentAtMs: NOW_MS - 4 * DAY, answeredAtMs: NOW_MS - DAY, expiredAtMs: null, createdAtMs: NOW_MS - 5 * DAY }),
      // Expired but outside the 7-day window.
      reqRow({ kind: 'old', expiredAtMs: NOW_MS - 8 * DAY }),
      // Malformed lines.
      'not json at all',
      J({ id: 'x' }),
      reqRow({ kind: 'bad', status: 'expired' }),
    ].join('\n');
    const fold = foldCommsRequests([text], NOW_MS, 168);
    expect(fold.requests).toBe(6);
    expect(fold.expired).toBe(0);
    expect(fold.outsideWindow).toBe(1);
    expect(fold.malformed).toBe(3);
    expect(fold.cells.size).toBe(0);
  });

  it('treats an expired row without expiredAt as malformed', () => {
    const fold = foldCommsRequests([[
      J({ id: 'r1', kind: 'k', type: 'report', status: 'expired', createdAt: iso(NOW_MS - DAY) }),
    ].join('\n')], NOW_MS, 168);
    expect(fold.malformed).toBe(1);
    expect(fold.requests).toBe(0);
  });
});

describe('commsRequestCells', () => {
  it('emits only cells at the row and day bars', () => {
    const rows = [
      // Below bars: 2 rows on 2 days is not enough rows.
      ...expirySeries({ kind: 'thin', days: 2, perDay: 1 }),
      // At bars: 3 rows across 2 days.
      ...expirySeries({ kind: 'manager-approval', type: 'approval', cls: 'unanswered', days: 2, perDay: 2 }),
    ];
    const fold = foldCommsRequests([rows.join('\n')], NOW_MS, 168);
    const cells = commsRequestCells(fold);
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({
      kind: 'comms-request-expiry',
      type: 'approval',
      requestKind: 'manager-approval',
      expiryClass: 'unanswered',
      rows: 4,
    });
    expect(cells[0]!.days).toHaveLength(2);
    expect(COMMS_REQUESTS_MIN_ROWS).toBe(3);
    expect(COMMS_REQUESTS_MIN_DAYS).toBe(2);
  });

  it('orders send-failure before unanswered before unsent, approvals first within a class', () => {
    const rows = [
      ...expirySeries({ kind: 'digest-q', type: 'question', cls: 'unanswered' }),
      ...expirySeries({ kind: 'merge-ok', type: 'approval', cls: 'unanswered' }),
      ...expirySeries({ kind: 'starved', cls: 'unsent' }),
      ...expirySeries({ kind: 'broken', cls: 'send-failure' }),
    ];
    const fold = foldCommsRequests([rows.join('\n')], NOW_MS, 168);
    const cells = commsRequestCells(fold);
    expect(cells.map((c) => `${c.expiryClass}|${c.type}|${c.requestKind}`)).toEqual([
      'send-failure|report|broken',
      'unanswered|approval|merge-ok',
      'unanswered|question|digest-q',
      'unsent|report|starved',
    ]);
  });
});

describe('commsRequestsBacklogItems', () => {
  let home: string;
  let saved: { HOME?: string; ASHLR_HOME?: string; ASHLR_RUNS_DIR?: string };
  const NOW = new Date(NOW_MS);

  beforeEach(async () => {
    saved = { HOME: process.env.HOME, ASHLR_HOME: process.env.ASHLR_HOME, ASHLR_RUNS_DIR: process.env.ASHLR_RUNS_DIR };
    delete process.env.ASHLR_HOME;
    delete process.env.ASHLR_RUNS_DIR;
    home = await mkdtemp(join(tmpdir(), 'comms-requests-backlog-'));
    process.env.HOME = home;
  });
  afterEach(async () => {
    for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.restoreAllMocks();
    await rm(home, { recursive: true, force: true });
  });

  /** A store file under the temp home carrying the given rows. */
  async function store(name: string, rows: string[]): Promise<string> {
    const dir = join(home, '.ashlr', 'comms');
    await mkdir(dir, { recursive: true });
    const path = join(dir, `${name}.jsonl`);
    await writeFile(path, rows.join('\n') + '\n');
    return path;
  }

  it('emits one item per recurring cell with grounded prompts', async () => {
    const rows = [
      ...expirySeries({ kind: 'manager-approval', type: 'approval', cls: 'unanswered', days: 3, perDay: 2 }),
      ...expirySeries({ kind: 'fleet-digest', cls: 'unsent', days: 2, perDay: 2 }),
      ...expirySeries({ kind: 'leader-veto', type: 'question', cls: 'send-failure', days: 2, perDay: 2 }),
    ];
    const path = await store('requests', rows);
    const items = await commsRequestsBacklogItems({ repo: 'ashlrai/phantom', journalPath: path, now: NOW });
    expect(items).toHaveLength(3);
    expect(items.map((i) => i.area)).toEqual(['comms-send-failure', 'comms-unanswered', 'comms-unsent']);
    for (const item of items) {
      expect(item.id).toMatch(/^comms-req-[0-9a-f]{16}$/);
      expect(item).toMatchObject({ priority: 3, repo: 'ashlrai/phantom' });
      expect(validBacklogItem(item)).not.toBeNull();
      expect(item.prompt).toContain('requests.jsonl');
      expect(item.prompt).toContain('no-change');
      // Free-text request bodies, options, meta and answers never reach a prompt.
      expect(item.prompt).not.toContain('FREE-TEXT');
    }
    const [sendFail, unanswered, unsent] = items;
    expect(sendFail!.title).toContain('leader-veto');
    expect(sendFail!.title).toContain('failing');
    expect(sendFail!.prompt).toContain('send failed');
    expect(unanswered!.title).toContain('manager-approval');
    expect(unanswered!.title).toContain('unanswered');
    expect(unanswered!.prompt).toContain('approval');
    expect(unsent!.title).toContain('fleet-digest');
    expect(unsent!.title).toContain('unsent');
    expect(unsent!.prompt).toContain('without ever being sent');
  });

  it('emits nothing for missing, unreadable, foreign-repo or below-bar evidence', async () => {
    expect(await commsRequestsBacklogItems({ repo: 'ashlrai/phantom', journalPath: join(home, 'nope', 'requests.jsonl'), now: NOW })).toEqual([]);

    // A directory instead of a file.
    const dirPath = join(home, '.ashlr', 'comms', 'requests.jsonl');
    await mkdir(dirPath, { recursive: true });
    expect(await commsRequestsBacklogItems({ repo: 'ashlrai/phantom', journalPath: dirPath, now: NOW })).toEqual([]);

    // Another repository never inherits this install's owner channel.
    const thin = expirySeries({ days: 3, perDay: 3 });
    const thinPath = await store('requests-thin', thin);
    expect(await commsRequestsBacklogItems({ repo: 'ashlrai/lexicon', journalPath: thinPath, now: NOW })).toEqual([]);
    expect(await commsRequestsBacklogItems({ repo: '', journalPath: thinPath, now: NOW })).toEqual([]);
    expect(await commsRequestsBacklogItems({ repo: 'ashlrai/phantom', journalPath: thinPath, now: NOW })).not.toEqual([]);

    // Rows below the recurring bars emit nothing.
    const sparse = [
      unansweredRow({ expiredAtMs: NOW_MS - DAY }),
      unansweredRow({ expiredAtMs: NOW_MS - 2 * DAY }),
      'not json at all',
    ];
    const sparsePath = await store('requests-sparse', sparse);
    expect(await commsRequestsBacklogItems({ repo: 'ashlrai/phantom', journalPath: sparsePath, now: NOW })).toEqual([]);
  });

  it('states truncation as a lower bound in every prompt', async () => {
    const rows = expirySeries({ days: 3, perDay: 2 });
    // Pad past the 1 MiB tail bound so the read reports truncated.
    const pad = 'x'.repeat(COMMS_REQUESTS_TAIL_BYTES + 64 * 1024);
    const path = await store('requests-big', []);
    await writeFile(path, `${pad}\n${rows.join('\n')}\n`);
    const items = await commsRequestsBacklogItems({ repo: 'ashlrai/phantom', journalPath: path, now: NOW });
    expect(items.length).toBeGreaterThan(0);
    expect(items.every((i) => i.prompt.includes('lower bound'))).toBe(true);
  });

  it('derives stable ids so a refresh re-adds nothing and honours the limit', async () => {
    const rows = [
      ...expirySeries({ kind: 'manager-approval', type: 'approval', cls: 'unanswered' }),
      ...expirySeries({ kind: 'fleet-digest', cls: 'unsent' }),
      ...expirySeries({ kind: 'broken', cls: 'send-failure' }),
    ];
    const path = await store('requests-stable', rows);
    const opts = { repo: 'ashlrai/phantom', journalPath: path, now: NOW };
    const first = await commsRequestsBacklogItems(opts);
    const second = await commsRequestsBacklogItems(opts);
    expect(second.map((i) => i.id)).toEqual(first.map((i) => i.id));
    expect(first).toHaveLength(3);
    const limited = await commsRequestsBacklogItems({ ...opts, limit: 1 });
    expect(limited).toHaveLength(1);
    expect(first.map((i) => i.id)).toContain(limited[0]!.id);
  });

  it('reads the writer’s own default path under the relocated home', async () => {
    // No journalPath: the fold resolves join(homedir(), '.ashlr', 'comms',
    // 'requests.jsonl') — the same path storeDir() writes.
    const rows = expirySeries({ kind: 'manager-approval', type: 'approval', cls: 'unanswered' });
    const dir = join(home, '.ashlr', 'comms');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'requests.jsonl'), rows.join('\n') + '\n');
    const items = await commsRequestsBacklogItems({ repo: 'ashlrai/phantom', now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]!.title).toContain('manager-approval');
  });

  it('appends comms request items through discovery and dedupes on refresh', async () => {
    // discoverBacklog anchors the window on the real clock, so these rows
    // are stamped relative to Date.now() rather than the fixed NOW_MS.
    // The store's writer path is <home>/.ashlr/comms — homedir() honors
    // the relocated HOME, never $ASHLR_HOME.
    const realNow = Date.now();
    const at = (d: number, i = 0): number => realNow - d * DAY - i * HOUR;
    const commsDir = join(home, '.ashlr', 'comms');
    await mkdir(commsDir, { recursive: true });
    const liveRows = [
      // manager-approval unanswered: 4 rows, 2 days — over the bars.
      unansweredRow({ kind: 'manager-approval', type: 'approval', expiredAtMs: at(0) }),
      unansweredRow({ kind: 'manager-approval', type: 'approval', expiredAtMs: at(0, 1) }),
      unansweredRow({ kind: 'manager-approval', type: 'approval', expiredAtMs: at(1) }),
      unansweredRow({ kind: 'manager-approval', type: 'approval', expiredAtMs: at(2) }),
      // A sparse cell that stays below the bars.
      unansweredRow({ kind: 'one-off', type: 'question', expiredAtMs: at(0, 2) }),
      unansweredRow({ kind: 'one-off', type: 'question', expiredAtMs: at(1, 2) }),
    ];
    await writeFile(join(commsDir, 'requests.jsonl'), liveRows.join('\n') + '\n');
    const greenGh = async (args: string[]) => {
      const p = args[4] ?? '';
      if (p === 'repos/ashlrai/phantom') return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
      return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
    };
    const first = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    const journalItems = first.items.filter((i) => i.id.startsWith('comms-req-'));
    expect(journalItems).toHaveLength(1);
    expect(journalItems[0]!.title).toContain('manager-approval');
    expect(journalItems[0]!.area).toBe('comms-unanswered');
    expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
    expect(appendUserBacklogItems(journalItems)).toBe(1);
    const second = await discoverBacklog('ashlrai/phantom', { gh: greenGh });
    expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('comms-req-')))).toBe(0);
    expect(readUserBacklogItems().filter((i) => i.id.startsWith('comms-req-'))).toHaveLength(1);
  });
});
