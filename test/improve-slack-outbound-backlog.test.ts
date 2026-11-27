import { mkdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SLACK_OUTBOUND_MIN_DAYS,
  SLACK_OUTBOUND_MIN_EVENTS,
  SLACK_OUTBOUND_MIN_ROWS,
  SLACK_OUTBOUND_WINDOW_MS,
  foldSlackOutboundEntries,
  slackOutboundBacklogItems,
  slackOutboundCells,
  slackOutboundFoldRow,
  slackOutboundRowKind,
} from '../src/core/improve/slack-outbound-backlog.js';
import { readSlackOutboundJournal } from '../src/core/agents/slack-outbound.js';
import type { SlackOutboundRow } from '../src/core/agents/slack-outbound.js';
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
const NOW_MS = Date.parse('2026-11-26T12:00:00.000Z');
const NOW = new Date(NOW_MS);
const iso = (ms: number): string => new Date(ms).toISOString();
const REPO = 'ashlrai/phantom';
const TOPIC = 'fleet-leader';
const OTHER_TOPIC = 'fleet-comms';

let home: string;
let savedHome: string | undefined;
let savedRuns: string | undefined;
let idCounter = 0;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'slack-outbound-backlog-'));
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

/** One row in the writer's journal shape — recordSlackOutbound emits the sanitized metadata fields. */
function row(spec: {
  atMs?: number;
  kind?: 'delivery' | 'notice-pass';
  status?: string;
  reason?: string;
  topic?: string;
  envelopeId?: string;
  planned?: number;
  sent?: number;
  failed?: number;
  skipped?: number;
  extra?: Record<string, unknown>;
}): string {
  const kind = spec.kind ?? 'delivery';
  const o: Record<string, unknown> = {
    at: iso(spec.atMs ?? NOW_MS),
    kind,
    status: spec.status ?? (kind === 'delivery' ? 'sent' : 'completed'),
    ...(spec.reason === undefined ? {} : { reason: spec.reason }),
    ...(kind === 'delivery' && spec.topic !== undefined ? { topic: spec.topic } : {}),
    ...(kind === 'delivery' && spec.envelopeId !== undefined ? { envelopeId: spec.envelopeId } : {}),
    ...(kind === 'notice-pass' && spec.planned !== undefined ? { planned: spec.planned } : {}),
    ...(kind === 'notice-pass' && spec.sent !== undefined ? { sent: spec.sent } : {}),
    ...(kind === 'notice-pass' && spec.failed !== undefined ? { failed: spec.failed } : {}),
    ...(kind === 'notice-pass' && spec.skipped !== undefined ? { skipped: spec.skipped } : {}),
    ...spec.extra,
  };
  return J(o);
}

/** A unique envelope id per call. */
function envId(): string {
  idCounter += 1;
  return `env-out-${String(idCounter).padStart(4, '0')}`;
}

/** Write journal text to <home>/<runsDirName>/slack-bridge/outbound.jsonl and return the runs dir. */
function writeJournal(lines: string[], runsDirName = '.ashlr-runs'): string {
  const dir = join(home, runsDirName, 'slack-bridge');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'outbound.jsonl'), lines.join('\n') + '\n');
  return join(home, runsDirName);
}

function delivery(spec: {
  atMs?: number; status?: 'sent' | 'duplicate' | 'uncertain' | 'refused';
  reason?: string; topic?: string; envelopeId?: string;
}): string {
  return row({
    atMs: spec.atMs, kind: 'delivery', status: spec.status ?? 'refused',
    ...(spec.reason === undefined ? {} : { reason: spec.reason }),
    topic: spec.topic ?? TOPIC, envelopeId: spec.envelopeId ?? envId(),
  });
}

function pass(spec: {
  atMs?: number; status?: string; reason?: string;
  planned?: number; sent?: number; failed?: number; skipped?: number;
}): string {
  return row({
    atMs: spec.atMs, kind: 'notice-pass',
    status: spec.status ?? 'completed',
    ...(spec.reason === undefined ? {} : { reason: spec.reason }),
    planned: spec.planned ?? 0, sent: spec.sent ?? 0,
    failed: spec.failed ?? 0, skipped: spec.skipped ?? 0,
  });
}

/** Journal line → validated entry, the shape readSlackOutboundJournal returns. */
function entry(line: string): SlackOutboundRow {
  return JSON.parse(line) as SlackOutboundRow;
}

/** Three adverse rows across two days and three distinct events — the emit bar. */
function recurring(kind: 'uncertain' | 'refused' | 'halted' | 'degraded-pass', topic = TOPIC): string[] {
  const mk = (atMs: number, n: number): string => {
    if (kind === 'uncertain') {
      return delivery({ atMs, status: 'uncertain', reason: 'transport-or-storage-unavailable', topic, envelopeId: `env-u-${n}` });
    }
    if (kind === 'refused') {
      return delivery({ atMs, status: 'refused', reason: 'audience-unproved', topic, envelopeId: `env-r-${n}` });
    }
    if (kind === 'halted') {
      return pass({ atMs, status: 'ledger-unavailable', reason: 'sent-ledger-unreadable', planned: 0, sent: 0, failed: 0, skipped: 0 });
    }
    return pass({ atMs, status: 'completed', planned: 4, sent: 2, failed: 2, skipped: 0 });
  };
  return [mk(NOW_MS - 2 * DAY, 1), mk(NOW_MS - DAY - HOUR, 2), mk(NOW_MS - HOUR, 3)];
}

describe('slackOutboundRowKind', () => {
  it('classifies unproved and refused deliveries; sent and duplicate are context', () => {
    expect(slackOutboundRowKind(entry(delivery({ status: 'uncertain' })))).toEqual({ kind: 'delivery-uncertain', status: 'uncertain' });
    expect(slackOutboundRowKind(entry(delivery({ status: 'refused' })))).toEqual({ kind: 'delivery-refused', status: 'refused' });
    expect(slackOutboundRowKind(entry(delivery({ status: 'sent' })))).toBeNull();
    expect(slackOutboundRowKind(entry(delivery({ status: 'duplicate' })))).toBeNull();
  });

  it('classifies halted and degraded passes; clean and dry-run passes are context', () => {
    for (const status of ['board-unavailable', 'ledger-unavailable', 'bindings-unavailable', 'prev-unavailable', 'error']) {
      expect(slackOutboundRowKind(entry(pass({ status })))).toEqual({ kind: 'notice-pass-halted', status });
    }
    expect(slackOutboundRowKind(entry(pass({ status: 'completed', failed: 2 })))).toEqual({ kind: 'notice-pass-degraded', status: 'completed' });
    expect(slackOutboundRowKind(entry(pass({ status: 'completed', failed: 0 })))).toBeNull();
    expect(slackOutboundRowKind(entry(pass({ status: 'dry-run' })))).toBeNull();
    // A completed pass with no failed field at all is clean, not degraded.
    expect(slackOutboundRowKind({ at: iso(NOW_MS), kind: 'notice-pass', status: 'completed' })).toBeNull();
  });
});

describe('slackOutboundFoldRow', () => {
  const base = entry(delivery({ atMs: NOW_MS - HOUR, status: 'uncertain', reason: 'delivery-needs-reconciliation', topic: TOPIC, envelopeId: 'env-fold-1' }));

  it('folds in-window adverse rows with topic, day and event identity', () => {
    const folded = slackOutboundFoldRow(base, { nowMs: NOW_MS });
    expect(folded).not.toBeNull();
    expect(folded!.kind).toBe('delivery-uncertain');
    expect(folded!.status).toBe('uncertain');
    expect(folded!.topic).toBe(TOPIC);
    expect(folded!.utcDay).toBe('2026-11-26');
    expect(folded!.reasonKey).toBe('delivery-needs-reconciliation');
    expect(folded!.eventKey).toBe('delivery|env-fold-1');
  });

  it('returns null for context rows and out-of-window rows', () => {
    expect(slackOutboundFoldRow(entry(delivery({ status: 'sent' })), { nowMs: NOW_MS })).toBeNull();
    expect(slackOutboundFoldRow(entry(pass({ status: 'completed', failed: 0 })), { nowMs: NOW_MS })).toBeNull();
    expect(slackOutboundFoldRow({ ...base, at: iso(NOW_MS - SLACK_OUTBOUND_WINDOW_MS - DAY) } as SlackOutboundRow, { nowMs: NOW_MS })).toBeNull();
    expect(slackOutboundFoldRow({ ...base, at: iso(NOW_MS + 2 * HOUR) } as SlackOutboundRow, { nowMs: NOW_MS })).toBeNull(); // beyond skew
    expect(slackOutboundFoldRow({ ...base, at: 'not-a-date' } as SlackOutboundRow, { nowMs: NOW_MS })).toBeNull();
  });

  it('collapses retried sends of one envelope to a single event; pass rows key on their own timestamp', () => {
    const first = slackOutboundFoldRow(
      entry(delivery({ status: 'refused', reason: 'audience-unproved', envelopeId: 'env-same' })), { nowMs: NOW_MS });
    const retry = slackOutboundFoldRow(
      entry(delivery({ atMs: NOW_MS - HOUR, status: 'refused', reason: 'audience-unproved', envelopeId: 'env-same' })), { nowMs: NOW_MS });
    expect(first!.eventKey).toBe(retry!.eventKey);
    // No envelope id: the row timestamp is the identity floor.
    const noId = slackOutboundFoldRow(
      { at: iso(NOW_MS - HOUR), kind: 'delivery', status: 'uncertain', reason: 'x' } as SlackOutboundRow, { nowMs: NOW_MS });
    expect(noId!.eventKey).toBe(`delivery|${iso(NOW_MS - HOUR)}`);
    // Pass rows have no envelope id — each pass is its own event.
    const p1 = slackOutboundFoldRow(entry(pass({ atMs: NOW_MS - HOUR, status: 'error', reason: 'pass-error' })), { nowMs: NOW_MS });
    const p2 = slackOutboundFoldRow(entry(pass({ atMs: NOW_MS - 2 * HOUR, status: 'error', reason: 'pass-error' })), { nowMs: NOW_MS });
    expect(p1!.eventKey).not.toBe(p2!.eventKey);
    expect(p1!.topic).toBe('fleet-claim-notices');
  });
});

describe('foldSlackOutboundEntries + slackOutboundCells', () => {
  it('emits a cell at the row/day/event bars and counts context', () => {
    const entries = [
      ...recurring('refused').map(entry),
      entry(delivery({ atMs: NOW_MS - HOUR, status: 'sent', reason: 'delivery-proved' })),
      entry(delivery({ atMs: NOW_MS - 2 * HOUR, status: 'duplicate', reason: 'delivery-proved' })),
      entry(pass({ atMs: NOW_MS - 3 * HOUR, status: 'completed', failed: 0, planned: 2, sent: 2 })),
    ];
    const fold = foldSlackOutboundEntries(entries, { nowMs: NOW_MS });
    expect(fold.entries).toBe(entries.length);
    expect(fold.contextRows).toBe(3);
    const cells = slackOutboundCells(fold);
    expect(cells).toHaveLength(1);
    expect(cells[0]!.kind).toBe('delivery-refused');
    expect(cells[0]!.status).toBe('refused');
    expect(cells[0]!.reasonKey).toBe('audience-unproved');
    expect(cells[0]!.topic).toBe(TOPIC);
    expect(cells[0]!.rows).toBe(SLACK_OUTBOUND_MIN_ROWS);
    expect(cells[0]!.days.length).toBeGreaterThanOrEqual(SLACK_OUTBOUND_MIN_DAYS);
    expect(cells[0]!.events).toBeGreaterThanOrEqual(SLACK_OUTBOUND_MIN_EVENTS);
    expect(cells[0]!.context).toBe(3);
    expect(cells[0]!.records).toBe(entries.length);
    expect(cells[0]!.degraded).toBe(false);
  });

  it('suppresses cells below the bars: one day, one retried event, too few rows', () => {
    // Three rows and two events but all on one UTC day — the day bar fails.
    const sameDay = [
      delivery({ atMs: NOW_MS - 3 * HOUR, status: 'uncertain', reason: 'transport-or-storage-unavailable', envelopeId: 'env-sd-1' }),
      delivery({ atMs: NOW_MS - 2 * HOUR, status: 'uncertain', reason: 'transport-or-storage-unavailable', envelopeId: 'env-sd-2' }),
      delivery({ atMs: NOW_MS - HOUR, status: 'uncertain', reason: 'transport-or-storage-unavailable', envelopeId: 'env-sd-1' }), // retry of first
    ].map(entry);
    expect(slackOutboundCells(foldSlackOutboundEntries(sameDay, { nowMs: NOW_MS }))).toHaveLength(0);

    // Two days but a single distinct envelope — a retry storm is one event.
    const storm = [
      delivery({ atMs: NOW_MS - 2 * DAY, status: 'uncertain', reason: 'transport-or-storage-unavailable', envelopeId: 'env-storm' }),
      delivery({ atMs: NOW_MS - DAY, status: 'uncertain', reason: 'transport-or-storage-unavailable', envelopeId: 'env-storm' }),
      delivery({ atMs: NOW_MS - HOUR, status: 'uncertain', reason: 'transport-or-storage-unavailable', envelopeId: 'env-storm' }),
    ].map(entry);
    expect(slackOutboundCells(foldSlackOutboundEntries(storm, { nowMs: NOW_MS }))).toHaveLength(0);

    // Only two rows across two days and two events.
    const two = [
      delivery({ atMs: NOW_MS - 2 * DAY, status: 'refused', reason: 'audience-unproved', envelopeId: 'env-two-1' }),
      delivery({ atMs: NOW_MS - HOUR, status: 'refused', reason: 'audience-unproved', envelopeId: 'env-two-2' }),
    ].map(entry);
    expect(slackOutboundCells(foldSlackOutboundEntries(two, { nowMs: NOW_MS }))).toHaveLength(0);
  });

  it('groups cells by kind, status, reason and topic; pass cells carry summed tallies', () => {
    const entries = [
      ...recurring('refused', TOPIC).map(entry),
      ...recurring('refused', OTHER_TOPIC).map(entry),
      ...recurring('halted').map(entry),
      ...recurring('degraded-pass').map(entry),
    ];
    const cells = slackOutboundCells(foldSlackOutboundEntries(entries, { nowMs: NOW_MS }));
    expect(cells).toHaveLength(4);
    const byKind = new Map(cells.map((c) => [`${c.kind}|${c.topic}|${c.status}`, c]));
    expect(byKind.get(`delivery-refused|${TOPIC}|refused`)!.reasonKey).toBe('audience-unproved');
    expect(byKind.get(`delivery-refused|${OTHER_TOPIC}|refused`)!.topic).toBe(OTHER_TOPIC);
    const halted = byKind.get(`notice-pass-halted|fleet-claim-notices|ledger-unavailable`)!;
    expect(halted.kind).toBe('notice-pass-halted');
    expect(halted.reasonKey).toBe('sent-ledger-unreadable');
    const degraded = byKind.get(`notice-pass-degraded|fleet-claim-notices|completed`)!;
    expect(degraded.kind).toBe('notice-pass-degraded');
    // Tallies sum across the cell's three rows: 4+4+4 planned, 2+2+2 sent, 2+2+2 failed.
    expect(degraded.planned).toBe(12);
    expect(degraded.sent).toBe(6);
    expect(degraded.failed).toBe(6);
    expect(degraded.skipped).toBe(0);
  });

  it('marks degraded reads on emitted cells', () => {
    const entries = recurring('uncertain').map(entry);
    const cells = slackOutboundCells(foldSlackOutboundEntries(entries, { nowMs: NOW_MS, degraded: true }));
    expect(cells).toHaveLength(1);
    expect(cells[0]!.degraded).toBe(true);
  });
});

describe('slackOutboundBacklogItems', () => {
  it('emits items for recurring refused cells and derives stable ids', async () => {
    const runsDir = writeJournal(recurring('refused'));
    const items = await slackOutboundBacklogItems({ repo: REPO, runsDir, now: NOW });
    expect(items).toHaveLength(1);
    const item = items[0]!;
    expect(item.area).toBe('slack-outbound-delivery-refused');
    expect(item.priority).toBe(3);
    expect(item.repo).toBe(REPO);
    expect(item.title).toContain('Slack outbound');
    expect(item.title).toContain(TOPIC);
    expect(item.prompt).toContain('refused');
    expect(item.prompt).toContain(TOPIC);
    expect(item.prompt).toContain('3 adverse row(s)');
    expect(item.prompt).toContain('audience-unproved');
    expect(validBacklogItem(item)).not.toBeNull();

    // A refresh re-derives the same id — appendUserBacklogItems adds nothing new.
    const again = await slackOutboundBacklogItems({ repo: REPO, runsDir, now: NOW });
    expect(again[0]!.id).toBe(item.id);
  });

  it('emits distinct items per kind and topic — titles stay unique for backlog dedupe', async () => {
    const runsDir = writeJournal([
      ...recurring('refused', TOPIC),
      ...recurring('uncertain', OTHER_TOPIC),
      ...recurring('halted'),
      ...recurring('degraded-pass'),
    ]);
    const items = await slackOutboundBacklogItems({ repo: REPO, runsDir, now: NOW });
    expect(items).toHaveLength(4);
    expect(new Set(items.map((i) => i.id)).size).toBe(4);
    // appendUserBacklogItems dedupes on id AND normalised title — every
    // emitted title must survive that second gate.
    expect(new Set(items.map((i) => i.title.toLowerCase())).size).toBe(4);
    const areas = items.map((i) => i.area).sort();
    expect(areas).toEqual([
      'slack-outbound-delivery-refused',
      'slack-outbound-delivery-uncertain',
      'slack-outbound-notice-pass-degraded',
      'slack-outbound-notice-pass-halted',
    ]);
    for (const item of items) expect(validBacklogItem(item)).not.toBeNull();
  });

  it('stays quiet on missing, empty and below-bar journals', async () => {
    expect(await slackOutboundBacklogItems({ repo: REPO, runsDir: join(home, 'nope'), now: NOW })).toEqual([]);
    const empty = writeJournal([], 'empty-runs');
    expect(await slackOutboundBacklogItems({ repo: REPO, runsDir: empty, now: NOW })).toEqual([]);
    // Healthy traffic only: proved sends and clean passes.
    const healthy = writeJournal([
      delivery({ atMs: NOW_MS - HOUR, status: 'sent', reason: 'delivery-proved' }),
      delivery({ atMs: NOW_MS - 2 * HOUR, status: 'duplicate', reason: 'delivery-proved' }),
      delivery({ atMs: NOW_MS - 3 * HOUR, status: 'sent', reason: 'delivery-reconciled' }),
      pass({ atMs: NOW_MS - DAY, status: 'completed', failed: 0, planned: 2, sent: 2 }),
      pass({ atMs: NOW_MS - 2 * DAY, status: 'dry-run' }),
    ], 'healthy-runs');
    expect(await slackOutboundBacklogItems({ repo: REPO, runsDir: healthy, now: NOW })).toEqual([]);
    // Below the bars: recurring reason but a single distinct envelope.
    const storm = writeJournal([
      delivery({ atMs: NOW_MS - 2 * DAY, status: 'uncertain', reason: 'transport-or-storage-unavailable', envelopeId: 'env-storm-1' }),
      delivery({ atMs: NOW_MS - DAY, status: 'uncertain', reason: 'transport-or-storage-unavailable', envelopeId: 'env-storm-1' }),
      delivery({ atMs: NOW_MS - HOUR, status: 'uncertain', reason: 'transport-or-storage-unavailable', envelopeId: 'env-storm-1' }),
    ], 'storm-runs');
    expect(await slackOutboundBacklogItems({ repo: REPO, runsDir: storm, now: NOW })).toEqual([]);
  });

  it('emits only for the fleet repository and respects the repo gate', async () => {
    const runsDir = writeJournal(recurring('halted'));
    expect(await slackOutboundBacklogItems({ repo: 'ashlrai/other', runsDir, now: NOW })).toEqual([]);
    expect(await slackOutboundBacklogItems({ repo: 'other', runsDir, now: NOW })).toEqual([]);
    expect(await slackOutboundBacklogItems({ repo: '', runsDir, now: NOW })).toEqual([]);
    expect(await slackOutboundBacklogItems({ repo: 'not a repo!!', runsDir, now: NOW })).toEqual([]);
    const items = await slackOutboundBacklogItems({ repo: 'ashlrai/phantom', runsDir, now: NOW });
    expect(items).toHaveLength(1);
  });

  it('folds a degraded journal with valid retained rows and states the floor', async () => {
    const runsDir = writeJournal([
      ...recurring('degraded-pass'),
      '{"at":"2026-11-26T10:00:00.000Z","kind":"notice-pass",', // torn line
      'not json at all',
    ]);
    const read = readSlackOutboundJournal({ runsDir, limit: 4096 });
    expect(read.state).toBe('degraded');
    expect(read.entries.length).toBeGreaterThan(0);
    const items = await slackOutboundBacklogItems({ repo: REPO, runsDir, now: NOW });
    expect(items).toHaveLength(1);
    expect(items[0]!.prompt).toContain('recorded floor');
  });

  it('honors ASHLR_RUNS_DIR and homeDir resolution', async () => {
    // $ASHLR_RUNS_DIR wins over the home-derived default.
    const custom = join(home, 'custom-runs');
    mkdirSync(join(custom, 'slack-bridge'), { recursive: true });
    writeFileSync(join(custom, 'slack-bridge', 'outbound.jsonl'), recurring('halted').join('\n') + '\n');
    process.env['ASHLR_RUNS_DIR'] = custom;
    expect(await slackOutboundBacklogItems({ repo: REPO, now: NOW })).toHaveLength(1);
    delete process.env['ASHLR_RUNS_DIR'];
    // homeDir resolves <homeDir>/.ashlr-runs — the same layout the
    // reader's own default uses.
    const altHome = join(home, 'alt-home');
    mkdirSync(join(altHome, '.ashlr-runs', 'slack-bridge'), { recursive: true });
    writeFileSync(
      join(altHome, '.ashlr-runs', 'slack-bridge', 'outbound.jsonl'),
      recurring('halted').join('\n') + '\n');
    expect(await slackOutboundBacklogItems({ repo: REPO, homeDir: altHome, now: NOW })).toHaveLength(1);
    // And a homeDir without the journal stays quiet.
    expect(await slackOutboundBacklogItems({ repo: REPO, homeDir: join(home, 'empty-home'), now: NOW })).toEqual([]);
  });

  it('caps emitted items at the limit', async () => {
    const runsDir = writeJournal([
      ...recurring('refused', TOPIC),
      ...recurring('uncertain', OTHER_TOPIC),
      ...recurring('halted'),
      ...recurring('degraded-pass'),
    ]);
    const items = await slackOutboundBacklogItems({ repo: REPO, runsDir, now: NOW, limit: 2 });
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
      writeJournal(recurring('halted'));
      const greenGh = async (args: string[]) => {
        const p = args[4] ?? '';
        if (p === 'repos/ashlrai/phantom') {
          return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n{"default_branch":"master"}', stderr: '' };
        }
        return { ok: true, stdout: 'HTTP/2.0 200 OK\n\n[]', stderr: '' };
      };
      const first = await discoverBacklog(REPO, { gh: greenGh });
      const landed = first.items.filter((i) => i.id.startsWith('slack-outbound-'));
      expect(landed).toHaveLength(1);
      expect(landed[0]!.area).toBe('slack-outbound-notice-pass-halted');
      expect(first.items.every((i) => validBacklogItem(i) !== null)).toBe(true);
      expect(appendUserBacklogItems(landed)).toBe(landed.length);
      const second = await discoverBacklog(REPO, { gh: greenGh });
      expect(appendUserBacklogItems(second.items.filter((i) => i.id.startsWith('slack-outbound-')))).toBe(0);
      expect(readUserBacklogItems().filter((i) => i.id.startsWith('slack-outbound-'))).toHaveLength(landed.length);
    } finally {
      vi.useRealTimers();
    }
  });
});
