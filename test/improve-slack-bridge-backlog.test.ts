import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SLACK_BRIDGE_MIN_DAYS,
  SLACK_BRIDGE_MIN_EVENTS,
  SLACK_BRIDGE_MIN_ROWS,
  SLACK_BRIDGE_WINDOW_MS,
  foldSlackBridgeEntries,
  slackBridgeBacklogItems,
  slackBridgeCells,
  slackBridgeFoldRow,
  slackBridgeRowKind,
} from '../src/core/improve/slack-bridge-backlog.js';
import { readSlackJournal } from '../src/core/agents/slack-journal.js';
import type { SlackObservation } from '../src/core/agents/slack-journal.js';
import { discoverBacklog } from '../src/core/improve/discover.js';
import {
  appendUserBacklogItems,
  readUserBacklogItems,
  validBacklogItem,
} from '../src/core/cloud/backlog.js';

const DAY = 86_400_000;
const HOUR = 3_600_000;
const J = (o: Record<string, unknown>): string => JSON.stringify(o);

/** Fixed evaluation instant; fixture timestamps are ISO-8601 UTC like the journal writer's `at`. */
const NOW_MS = Date.parse('2026-11-23T12:00:00.000Z');
const NOW = new Date(NOW_MS);
const iso = (ms: number): string => new Date(ms).toISOString();
const REPO = 'ashlrai/phantom';
const CHANNEL = 'C0123ABCD';
const OTHER_CHANNEL = 'C0999ZZZZ';

let home: string;
let savedHome: string | undefined;
let savedRuns: string | undefined;
let idCounter = 0;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'slack-bridge-backlog-'));
  savedHome = process.env['HOME'];
  savedRuns = process.env['ASHLR_RUNS_DIR'];
  process.env['HOME'] = home;
  delete process.env['ASHLR_RUNS_DIR'];
});
afterEach(async () => {
  if (savedHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = savedHome;
  if (savedRuns === undefined) delete process.env['ASHLR_RUNS_DIR'];
  else process.env['ASHLR_RUNS_DIR'] = savedRuns;
  await rm(home, { recursive: true, force: true });
});

/** One row in the writer's journal shape — recordSlackObservation emits the sanitized metadata fields. */
function row(spec: {
  atMs?: number;
  decision?: 'ingested' | 'ignored';
  reason?: string;
  bus?: 'posted' | 'duplicate' | 'failed';
  channelId?: string;
  authorId?: string;
  messageTs?: string;
  threadTs?: string;
  eventId?: string;
  envelopeId?: string;
  extra?: Record<string, unknown>;
}): string {
  const o: Record<string, unknown> = {
    at: iso(spec.atMs ?? NOW_MS),
    decision: spec.decision ?? 'ignored',
    ...(spec.reason === undefined ? {} : { reason: spec.reason }),
    ...(spec.bus === undefined ? {} : { bus: spec.bus }),
    ...(spec.channelId === undefined ? {} : { channelId: spec.channelId }),
    ...(spec.authorId === undefined ? {} : { authorId: spec.authorId }),
    ...(spec.messageTs === undefined ? {} : { messageTs: spec.messageTs }),
    ...(spec.threadTs === undefined ? {} : { threadTs: spec.threadTs }),
    ...(spec.eventId === undefined ? {} : { eventId: spec.eventId }),
    ...(spec.envelopeId === undefined ? {} : { envelopeId: spec.envelopeId }),
    ...spec.extra,
  };
  return J(o);
}

/** A unique Slack-ts-shaped message id per call. */
function msgTs(): string {
  idCounter += 1;
  return `1700000${String(idCounter).padStart(3, '0')}.000100`;
}

/** Write journal text to <home>/<runsDirName>/slack-bridge/journal.jsonl and return the runs dir. */
function writeJournal(lines: string[], runsDirName = '.ashlr-runs'): string {
  const dir = join(home, runsDirName, 'slack-bridge');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'journal.jsonl'), lines.join('\n') + '\n');
  return join(home, runsDirName);
}

/** An ignored row carrying the fields the writer records post-channel-validation. */
function ignored(spec: {
  atMs?: number; reason: string; channelId?: string; messageTs?: string; eventId?: string;
}): string {
  idCounter += 1;
  return row({
    atMs: spec.atMs, decision: 'ignored', reason: spec.reason,
    channelId: spec.channelId ?? CHANNEL, messageTs: spec.messageTs ?? msgTs(),
    eventId: spec.eventId ?? `EvFixture${idCounter}`,
    authorId: 'U0123ABCD',
  });
}

/** An ingested row with a bus outcome. */
function ingested(spec: {
  atMs?: number; bus?: 'posted' | 'duplicate' | 'failed'; channelId?: string; messageTs?: string;
}): string {
  return row({
    atMs: spec.atMs, decision: 'ingested', bus: spec.bus ?? 'failed',
    channelId: spec.channelId ?? CHANNEL, messageTs: spec.messageTs ?? msgTs(),
    authorId: 'U0123ABCD', envelopeId: 'env-1',
  });
}

/** Journal line → validated entry, the shape readSlackJournal returns. */
function obs(line: string): SlackObservation {
  return JSON.parse(line) as SlackObservation;
}

/** Three adverse rows across two days and three distinct messages — the emit bar. */
function recurring(kind: 'bus' | 'untrusted' | 'oversize' | 'secret' | 'unknown', channelId = CHANNEL): string[] {
  const mk = (atMs: number, n: number): string => {
    const ts = `1700001${String(n).padStart(3, '0')}.000200`;
    if (kind === 'bus') return ingested({ atMs, bus: 'failed', channelId, messageTs: ts });
    const reason = kind === 'untrusted' ? 'untrusted-sender'
      : kind === 'oversize' ? 'oversize-text'
      : kind === 'secret' ? 'secret-shaped-text'
      : 'some-future-reason';
    return ignored({ atMs, reason, channelId, messageTs: ts });
  };
  return [mk(NOW_MS - 2 * DAY, 1), mk(NOW_MS - DAY - HOUR, 2), mk(NOW_MS - HOUR, 3)];
}

describe('slackBridgeRowKind', () => {
  it('classifies ingested bus failures and the three adverse ignore reasons', () => {
    expect(slackBridgeRowKind({ decision: 'ingested', bus: 'failed' })).toBe('bus-failed');
    expect(slackBridgeRowKind({ decision: 'ingested', bus: 'posted' })).toBeNull();
    expect(slackBridgeRowKind({ decision: 'ingested', bus: 'duplicate' })).toBeNull();
    expect(slackBridgeRowKind({ decision: 'ingested' })).toBeNull();
    expect(slackBridgeRowKind({ decision: 'ignored', reason: 'untrusted-sender' })).toBe('untrusted-sender');
    expect(slackBridgeRowKind({ decision: 'ignored', reason: 'oversize-text' })).toBe('oversize-text');
    expect(slackBridgeRowKind({ decision: 'ignored', reason: 'secret-shaped-text' })).toBe('secret-shaped-text');
  });

  it('treats designed ignore reasons as context and unknown vocabulary as unclassified', () => {
    for (const reason of [
      'unsupported-envelope-type', 'unsupported-event-type', 'unsupported-subtype', 'hidden-event',
      'malformed-event', 'foreign-team', 'unmapped-channel', 'self-message', 'empty-text',
    ]) {
      expect(slackBridgeRowKind({ decision: 'ignored', reason })).toBeNull();
    }
    expect(slackBridgeRowKind({ decision: 'ignored', reason: 'some-future-reason' })).toBe('unclassified-ignore');
    expect(slackBridgeRowKind({ decision: 'ignored' })).toBe('unclassified-ignore');
    expect(slackBridgeRowKind({ decision: 'ignored', reason: '' })).toBe('unclassified-ignore');
  });
});

describe('slackBridgeFoldRow', () => {
  const base: SlackObservation = {
    at: iso(NOW_MS - HOUR), decision: 'ignored', reason: 'untrusted-sender',
    channelId: CHANNEL, messageTs: '1700000000.000001',
  };

  it('folds in-window adverse rows with channel, day and event identity', () => {
    const folded = slackBridgeFoldRow(base, { nowMs: NOW_MS });
    expect(folded).not.toBeNull();
    expect(folded!.kind).toBe('untrusted-sender');
    expect(folded!.channel).toBe(CHANNEL);
    expect(folded!.utcDay).toBe('2026-11-23');
    expect(folded!.eventKey).toBe(`${CHANNEL}|1700000000.000001`);
  });

  it('returns null for context rows and out-of-window rows', () => {
    expect(slackBridgeFoldRow({ at: iso(NOW_MS - HOUR), decision: 'ingested', bus: 'posted' }, { nowMs: NOW_MS })).toBeNull();
    expect(slackBridgeFoldRow({ at: iso(NOW_MS - HOUR), decision: 'ignored', reason: 'unmapped-channel' }, { nowMs: NOW_MS })).toBeNull();
    expect(slackBridgeFoldRow({ ...base, at: iso(NOW_MS - SLACK_BRIDGE_WINDOW_MS - DAY) }, { nowMs: NOW_MS })).toBeNull();
    expect(slackBridgeFoldRow({ ...base, at: iso(NOW_MS + 2 * HOUR) }, { nowMs: NOW_MS })).toBeNull(); // beyond skew
    expect(slackBridgeFoldRow({ ...base, at: 'not-a-date' }, { nowMs: NOW_MS })).toBeNull();
  });

  it('marks rows without a channel as unknown and prefers messageTs for event identity across redelivery', () => {
    const noChannel = slackBridgeFoldRow(
      { at: iso(NOW_MS - HOUR), decision: 'ignored', reason: 'untrusted-sender', messageTs: '1700000000.000009' },
      { nowMs: NOW_MS });
    expect(noChannel!.channel).toBe('unknown');
    expect(noChannel!.eventKey).toBe(`unknown|1700000000.000009`);
    // A Socket Mode redelivery re-records the same message under a fresh
    // envelope/event id — the message ts still identifies the one event.
    const redelivery = slackBridgeFoldRow(
      {
        at: iso(NOW_MS - HOUR), decision: 'ignored', reason: 'untrusted-sender',
        channelId: CHANNEL, messageTs: '1700000000.000009', eventId: 'EvNEW', envelopeId: 'env-new',
      },
      { nowMs: NOW_MS });
    expect(redelivery!.eventKey).toBe(`${CHANNEL}|1700000000.000009`);
    expect(redelivery!.eventKey).not.toBe(noChannel!.eventKey); // different channel → different event
  });
});

describe('foldSlackBridgeEntries + slackBridgeCells', () => {
  it('emits a cell at the row/day/event bars and counts context', () => {
    const entries = [
      ...recurring('untrusted').map(obs),
      obs(ingested({ atMs: NOW_MS - HOUR, bus: 'posted' })),
      obs(ignored({ atMs: NOW_MS - 2 * HOUR, reason: 'unmapped-channel' })),
    ];
    const fold = foldSlackBridgeEntries(entries, { nowMs: NOW_MS });
    expect(fold.entries).toBe(entries.length);
    expect(fold.contextRows).toBe(2);
    const cells = slackBridgeCells(fold);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.kind).toBe('untrusted-sender');
    expect(cells[0]!.rows).toBe(SLACK_BRIDGE_MIN_ROWS);
    expect(cells[0]!.days.length).toBeGreaterThanOrEqual(SLACK_BRIDGE_MIN_DAYS);
    expect(cells[0]!.events).toBeGreaterThanOrEqual(SLACK_BRIDGE_MIN_EVENTS);
    expect(cells[0]!.context).toBe(2);
    expect(cells[0]!.records).toBe(entries.length);
    expect(cells[0]!.degraded).toBe(false);
  });

  it('suppresses cells below the bars: one day, one retried event, too few rows', () => {
    // Three rows and two events but all on one UTC day — the day bar fails.
    const sameDay = [
      ignored({ atMs: NOW_MS - 3 * HOUR, reason: 'oversize-text', messageTs: '1700000200.000001' }),
      ignored({ atMs: NOW_MS - 2 * HOUR, reason: 'oversize-text', messageTs: '1700000200.000002' }),
      ignored({ atMs: NOW_MS - HOUR, reason: 'oversize-text', messageTs: '1700000200.000001' }), // redelivery of first
    ].map(obs);
    expect(slackBridgeCells(foldSlackBridgeEntries(sameDay, { nowMs: NOW_MS }))).toHaveLength(0);

    // Two days but a single distinct message — a retry storm is one event.
    const storm = [
      ignored({ atMs: NOW_MS - 2 * DAY, reason: 'oversize-text', messageTs: '1700000300.000001' }),
      ignored({ atMs: NOW_MS - DAY, reason: 'oversize-text', messageTs: '1700000300.000001' }),
      ignored({ atMs: NOW_MS - HOUR, reason: 'oversize-text', messageTs: '1700000300.000001' }),
    ].map(obs);
    expect(slackBridgeCells(foldSlackBridgeEntries(storm, { nowMs: NOW_MS }))).toHaveLength(0);

    // Only two rows across two days and two events.
    const two = [
      ignored({ atMs: NOW_MS - 2 * DAY, reason: 'oversize-text', messageTs: '1700000400.000001' }),
      ignored({ atMs: NOW_MS - HOUR, reason: 'oversize-text', messageTs: '1700000400.000002' }),
    ].map(obs);
    expect(slackBridgeCells(foldSlackBridgeEntries(two, { nowMs: NOW_MS }))).toHaveLength(0);
  });

  it('groups unclassified ignores by channel and reason, quoting the reason bounded', () => {
    const entries = [
      ...recurring('unknown', CHANNEL).map(obs),
      ...recurring('unknown', OTHER_CHANNEL).map(obs),
    ];
    const cells = slackBridgeCells(foldSlackBridgeEntries(entries, { nowMs: NOW_MS }));
    expect(cells).toHaveLength(2);
    for (const c of cells) {
      expect(c.kind).toBe('unclassified-ignore');
      expect(c.reasonKey).toBe('some-future-reason');
      expect(c.reasonText).toBe('some-future-reason');
    }
    expect(new Set(cells.map((c) => c.channel))).toEqual(new Set([CHANNEL, OTHER_CHANNEL]));
  });

  it('marks degraded reads on emitted cells', () => {
    const entries = recurring('bus').map(obs);
    const cells = slackBridgeCells(foldSlackBridgeEntries(entries, { nowMs: NOW_MS, degraded: true }));
    expect(cells).toHaveLength(1);
    expect(cells[0]!.degraded).toBe(true);
  });
});

describe('slackBridgeBacklogItems', () => {
  it('emits items for recurring bus-failed cells and derives stable ids', async () => {
    const runsDir = writeJournal(recurring('bus'));
    const items = await slackBridgeBacklogItems({ repo: REPO, runsDir, now: NOW });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.area).toBe('slack-bridge-bus-failed');
    expect(item.priority).toBe(3);
    expect(item.repo).toBe(REPO);
    expect(item.title).toContain('Slack bridge');
    expect(item.title).toContain(CHANNEL);
    expect(item.prompt).toContain('bus append');
    expect(item.prompt).toContain(CHANNEL);
    expect(item.prompt).toContain('3 adverse row(s)');
    expect(validBacklogItem(item)).not.toBeNull();

    // A refresh re-derives the same id — appendUserBacklogItems adds nothing new.
    const again = await slackBridgeBacklogItems({ repo: REPO, runsDir, now: NOW });
    expect(again[0]!.id).toBe(item.id);
  });

  it('emits distinct items per kind and channel — titles stay unique for backlog dedupe', async () => {
    const runsDir = writeJournal([
      ...recurring('bus', CHANNEL),
      ...recurring('untrusted', OTHER_CHANNEL),
      ...recurring('secret', CHANNEL),
      ...recurring('unknown', CHANNEL),
      ...recurring('unknown', OTHER_CHANNEL),
    ]);
    const items = await slackBridgeBacklogItems({ repo: REPO, runsDir, now: NOW });
    expect(items).toHaveLength(5);
    expect(new Set(items.map((i) => i.id)).size).toBe(5);
    // appendUserBacklogItems dedupes on id AND normalised title — every
    // emitted title must survive that second gate.
    expect(new Set(items.map((i) => i.title.toLowerCase())).size).toBe(5);
    const areas = items.map((i) => i.area).sort();
    expect(areas).toEqual([
      'slack-bridge-bus-failed',
      'slack-bridge-secret-shaped-text',
      'slack-bridge-unclassified-ignore',
      'slack-bridge-unclassified-ignore',
      'slack-bridge-untrusted-sender',
    ]);
    for (const item of items) expect(validBacklogItem(item)).not.toBeNull();
  });

  it('stays quiet on missing, empty and below-bar journals', async () => {
    expect(await slackBridgeBacklogItems({ repo: REPO, runsDir: join(home, 'nope'), now: NOW })).toEqual([]);
    const empty = writeJournal([], 'empty-runs');
    expect(await slackBridgeBacklogItems({ repo: REPO, runsDir: empty, now: NOW })).toEqual([]);
    // Healthy traffic only: posted/duplicate ingests and designed ignores.
    const healthy = writeJournal([
      ingested({ atMs: NOW_MS - HOUR, bus: 'posted' }),
      ingested({ atMs: NOW_MS - 2 * HOUR, bus: 'duplicate' }),
      ignored({ atMs: NOW_MS - 3 * HOUR, reason: 'unmapped-channel' }),
      ignored({ atMs: NOW_MS - DAY, reason: 'unsupported-event-type' }),
      ignored({ atMs: NOW_MS - 2 * DAY, reason: 'self-message' }),
    ], 'healthy-runs');
    expect(await slackBridgeBacklogItems({ repo: REPO, runsDir: healthy, now: NOW })).toEqual([]);
    // Below the bars: recurring reason but a single distinct message.
    const storm = writeJournal([
      ignored({ atMs: NOW_MS - 2 * DAY, reason: 'untrusted-sender', messageTs: '1700000500.000001' }),
      ignored({ atMs: NOW_MS - DAY, reason: 'untrusted-sender', messageTs: '1700000500.000001' }),
      ignored({ atMs: NOW_MS - HOUR, reason: 'untrusted-sender', messageTs: '1700000500.000001' }),
    ], 'storm-runs');
    expect(await slackBridgeBacklogItems({ repo: REPO, runsDir: storm, now: NOW })).toEqual([]);
  });

  it('emits only for the fleet repository and respects the repo gate', async () => {
    const runsDir = writeJournal(recurring('bus'));
    expect(await slackBridgeBacklogItems({ repo: 'ashlrai/other', runsDir, now: NOW })).toEqual([]);
    expect(await slackBridgeBacklogItems({ repo: 'other', runsDir, now: NOW })).toEqual([]);
    expect(await slackBridgeBacklogItems({ repo: '', runsDir, now: NOW })).toEqual([]);
    expect(await slackBridgeBacklogItems({ repo: 'not a repo!!', runsDir, now: NOW })).toEqual([]);
    const items = await slackBridgeBacklogItems({ repo: 'ashlrai/phantom', runsDir, now: NOW });
    expect(items).toHaveLength(1);
  });

  it('folds a degraded journal with valid retained rows and states the floor', async () => {
    const runsDir = writeJournal([
      ...recurring('oversize'),
      '{"at":"2026-11-23T10:00:00.000Z","decision":"ignored","reason":"untrusted-sender",', // torn line
      'not json at all',
    ]);
    const read = readSlackJournal({ runsDir, limit: 4096 });
    expect(read.state).toBe('degraded');
    expect(read.entries.length).toBeGreaterThan(0);
    const items = await slackBridgeBacklogItems({ repo: REPO, runsDir, now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('recorded floor');
  });

  it('honors ASHLR_RUNS_DIR and homeDir resolution', async () => {
    // $ASHLR_RUNS_DIR wins over the home-derived default.
    const custom = join(home, 'custom-runs');
    mkdirSync(join(custom, 'slack-bridge'), { recursive: true });
    writeFileSync(join(custom, 'slack-bridge', 'journal.jsonl'), recurring('secret').join('\n') + '\n');
    process.env['ASHLR_RUNS_DIR'] = custom;
    expect(await slackBridgeBacklogItems({ repo: REPO, now: NOW })).toHaveLength(1);
    delete process.env['ASHLR_RUNS_DIR'];
    // homeDir resolves <homeDir>/.ashlr-runs — the same layout the
    // reader's own default uses.
    const altHome = join(home, 'alt-home');
    mkdirSync(join(altHome, '.ashlr-runs', 'slack-bridge'), { recursive: true });
    writeFileSync(
      join(altHome, '.ashlr-runs', 'slack-bridge', 'journal.jsonl'),
      recurring('secret').join('\n') + '\n');
    expect(await slackBridgeBacklogItems({ repo: REPO, homeDir: altHome, now: NOW })).toHaveLength(1);
    // And a homeDir without the journal stays quiet.
    expect(await slackBridgeBacklogItems({ repo: REPO, homeDir: join(home, 'empty-home'), now: NOW })).toEqual([]);
  });

  it('caps emitted items at the limit', async () => {
    const runsDir = writeJournal([
      ...recurring('bus', CHANNEL),
      ...recurring('untrusted', OTHER_CHANNEL),
      ...recurring('secret', CHANNEL),
      ...recurring('oversize', OTHER_CHANNEL),
    ]);
    const items = await slackBridgeBacklogItems({ repo: REPO, runsDir, now: NOW, limit: 2 });
    expect(items).toHaveLength(2);
  });
});

describe('discoverBacklog integration', () => {
  it('surfaces journal cells through discovery and dedupes on refresh', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
    try {
      // discoverBacklog calls the feed with no path overrides, so the feed
      // resolves <home>/.ashlr-runs — HOME is this test's temp dir.
      writeJournal(recurring('bus'));
      const greenGh = async (args: string[]) => {
        const p = args[4] ?? '';
        if (p === 'repos/ashlrai/phantom') {
          return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
        }
        return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
      };
      const first = await discoverBacklog(REPO, { gh: greenGh });
      const landed = first.items.filter((i) => i.id.startsWith('slack-bridge-'));
      expect(landed).toHaveLength(1);
      expect(landed[0]!.area).toBe('slack-bridge-bus-failed');
      expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
      expect(appendUserBacklogItems(landed)).toBe(landed.length);
      const second = await discoverBacklog(REPO, { gh: greenGh });
      expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('slack-bridge-')))).toBe(0);
      expect(readUserBacklogItems().filter((i) => i.id.startsWith('slack-bridge-'))).toHaveLength(landed.length);
    } finally {
      vi.useRealTimers();
    }
  });
});
