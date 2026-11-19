import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { cmdApps } from '../src/cli/apps-control.js';
import { buildAppActions, formatAppActions, readAppActions } from '../src/core/apps-actions.js';
import { runAppsControl } from '../src/core/apps-control.js';
import type { BusInboxReceipt, BusInboxScan } from '../src/core/fleet/bus-inbox.js';
import { APPS_ACTIONS_PATH, createAppsControlApi } from '../src/core/verse/apps-control-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const T0 = Date.parse('2026-11-19T12:00:00Z');
let cursor = 0;
/** One feed line as runAppsControl writes it, `minute` minutes after noon. */
const line = (minute: number, body: Record<string, unknown>): BusInboxReceipt => ({
  cursor: ++cursor, receivedAt: T0 + minute * 60_000,
  envelope: { id: `apps-control-${cursor}`, from: 'apps-control', to: 'mason', priority: 'P3', ttl: 604_800_000, body: { kind: 'apps-control', ...body } },
} as BusInboxReceipt);
const pair = (minute: number, action: string, app: string, outcome: string, detail: string) => [
  line(minute, { phase: 'start', action, app }), line(minute, { phase: 'result', action, app, outcome, detail })];
const scan = (rows: BusInboxReceipt[], source: BusInboxScan['source'] = 'available'): BusInboxScan => ({ source, rows, skipped: 0 });

const feed = () => scan([
  ...pair(1, 'open', 'Cursor', 'done', 'asked macOS to open Cursor.'),
  ...pair(2, 'list', '*', 'done', '3 allowed'),
  ...pair(3, 'quit', 'Chrome', 'refused', 'Chrome is your own browser.'),
  ...pair(4, 'status', 'Cursor', 'done', 'running.'),
  line(5, { phase: 'start', action: 'restart', app: 'Safari' }),
  line(6, { phase: 'result', action: 'focus', app: 'Notes', outcome: 'needs-you', detail: 'Sent to needs-you.' }),
  { cursor: ++cursor, receivedAt: T0, envelope: { id: 'other', from: 'leader', to: 'mason', priority: 'P2', ttl: 60_000, body: { kind: 'note' } } } as BusInboxReceipt,
]);

describe('buildAppActions', () => {
  it('lists one entry per acting operation, newest first, with the result that followed its intent', () => {
    const report = buildAppActions(feed(), { now: T0 + 600_000 });
    expect(report).toMatchObject({ schema: 'phm.apps.actions/1', version: 1, source: 'available', total: 4, lookups: 2, truncated: false, generatedAt: '2026-11-19T12:10:00.000Z' });
    expect(report.actions.map(entry => `${entry.action} ${entry.app}: ${entry.outcome}`)).toEqual([
      'focus Notes: needs-you', 'restart Safari: no-result', 'quit Chrome: refused', 'open Cursor: done']);
    expect(report.actions[3]).toMatchObject({ at: '2026-11-19T12:01:00.000Z', detail: 'asked macOS to open Cursor.' });
    expect(report.counts).toEqual({ done: 1, refused: 1, 'no-result': 1, 'needs-you': 1 });
    expect(new Set(report.actions.map(entry => entry.key)).size).toBe(4);
  });

  it('keeps an intent with no result as no-result and never borrows another app\'s result', () => {
    const report = buildAppActions(scan([
      line(1, { phase: 'start', action: 'quit', app: 'Safari' }),
      ...pair(2, 'quit', 'Notes', 'done', 'quit.'),
      ...pair(3, 'quit', 'Safari', 'unknown', 'had not closed after 10 s.'),
    ]));
    // The result closes the intent written just before it; the earlier Safari intent never got one.
    expect(report.actions.map(entry => `${entry.app}: ${entry.outcome} ${entry.at.slice(14, 16)}`)).toEqual(['Safari: unknown 03', 'Notes: done 02', 'Safari: no-result 01']);
  });

  it('an unreadable feed is unknown, not zero; a feed that does not exist yet is zero', () => {
    expect(buildAppActions(scan([], 'unavailable'))).toMatchObject({ source: 'unavailable', total: null, lookups: null, actions: [], counts: {} });
    expect(buildAppActions(scan([], 'missing'))).toMatchObject({ source: 'missing', total: 0, lookups: 0, actions: [] });
  });

  it('limits the list, says so, and still counts everything', () => {
    const rows = Array.from({ length: 60 }, (_, index) => pair(index, 'open', 'Cursor', 'done', 'opened.')).flat();
    expect(buildAppActions(scan(rows))).toMatchObject({ total: 60, truncated: true, counts: { done: 60 } });
    expect(buildAppActions(scan(rows)).actions).toHaveLength(50);
    expect(buildAppActions(scan(rows), { limit: 5 }).actions.map(entry => entry.at.slice(11, 16))).toEqual(['12:59', '12:58', '12:57', '12:56', '12:55']);
    expect(buildAppActions(scan(rows), { limit: 9999 }).actions).toHaveLength(60);
  });

  it('ignores lines with an action or outcome it does not know', () => {
    const report = buildAppActions(scan([
      line(1, { phase: 'result', action: 'erase', app: 'Notes', outcome: 'done' }),
      line(2, { phase: 'result', action: 'open', app: 'Notes', outcome: 'exploded' }),
      line(3, { phase: 'result', action: 'open', app: 7, outcome: 'done' }),
    ]));
    expect(report).toMatchObject({ total: 0, actions: [] });
  });
});

describe('the log reads what runAppsControl writes', () => {
  it('a refused quit of the owner browser is on record with its reason', async () => {
    const root = mkdtempSync(join(tmpdir(), 'apps-actions-'));
    try {
      const written: BusInboxReceipt[] = [];
      const result = await runAppsControl({ action: 'quit', app: 'Chrome' }, { allowFile: join(root, 'allow.json'), launcher: null, probe: null,
        feed: (entry) => { written.push(line(written.length, entry as unknown as Record<string, unknown>)); return true; } });
      expect(result.report).toMatchObject({ outcome: 'refused', code: 'protected' });
      const report = readAppActions({ scanActions: () => scan(written) });
      expect(report.actions).toHaveLength(1);
      expect(report.actions[0]).toMatchObject({ action: 'quit', app: 'Chrome', outcome: 'refused', detail: (result.report as { detail: string }).detail });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});

describe('phm apps log', () => {
  const run = async (args: string[], source: BusInboxScan = feed()) => {
    const out: string[] = [];
    const exit = await cmdApps(args, { scanActions: () => source, now: () => T0 + 600_000, out: text => { out.push(text); } });
    return { exit, text: out.join('\n') };
  };

  it('prints the count line and one line per action, and the same report as JSON', async () => {
    const text = await run(['log']);
    expect(text.exit).toBe(0);
    expect(text.text.split('\n')).toEqual([
      '4 app actions on record (1 refused, 1 no result on record, 1 sent to needs-you). 2 lookups (list, status) are not listed.',
      '2026-11-19 12:06Z  focus Notes: sent to needs-you. Sent to needs-you.',
      '2026-11-19 12:05Z  restart Safari: no result on record',
      '2026-11-19 12:03Z  quit Chrome: refused. Chrome is your own browser.',
      '2026-11-19 12:01Z  open Cursor: done. asked macOS to open Cursor.',
    ]);
    const json = await run(['log', '--limit', '2', '--json']);
    expect(JSON.parse(json.text)).toMatchObject({ schema: 'phm.apps.actions/1', total: 4, truncated: true, actions: [{ app: 'Notes' }, { app: 'Safari' }] });
  });

  it('says unknown and exits 1 when the feed cannot be read; says nothing is on record when it is empty', async () => {
    expect(await run(['log'], scan([], 'unavailable'))).toEqual({ exit: 1, text: 'App actions are unknown: the feed could not be read.' });
    expect(await run(['log'], scan([], 'missing'))).toEqual({ exit: 0, text: 'No app action is on record: nothing has been logged to the feed yet.' });
    expect(formatAppActions(buildAppActions(scan(pair(1, 'list', '*', 'done', '0 allowed')))))
      .toBe('No app action is on record in the last 7 days. 1 lookups (list, status) are not listed.');
  });

  it('refuses a malformed limit or a dry run as a usage error', async () => {
    for (const args of [['log', '--limit'], ['log', '--limit', '0'], ['log', '--limit', 'ten'], ['log', 'Cursor'], ['log', '--dry-run']]) {
      expect((await run(args)).exit).toBe(2);
    }
  });
});

describe('GET /api/verse/apps/actions', () => {
  async function get(url = APPS_ACTIONS_PATH, options: { method?: string; address?: string; channel?: string } = {}) {
    const req = Object.assign(new PassThrough(), { url, headers: { 'x-ashlr-channel': options.channel ?? '' }, socket: { remoteAddress: options.address ?? '127.0.0.1' } }) as unknown as IncomingMessage;
    let status = 0, response = '';
    const res = { writeHead(code: number) { status = code; return this; }, end(text: string) { response = text; } } as unknown as ServerResponse;
    const handler = createAppsControlApi({ scanActions: feed, now: () => T0 + 600_000, launcher: null, feed: () => { throw new Error('a read must not write to the feed'); } });
    const pending = handler({ token: 'fixture', allowDispatch: true } as VerseApiContext, req, res, APPS_ACTIONS_PATH, options.method ?? 'GET');
    (req as unknown as PassThrough).end('');
    expect(await pending).toBe(true);
    return { status, body: JSON.parse(response) };
  }

  it('returns the log, honours limit and writes nothing', async () => {
    expect(await get()).toMatchObject({ status: 200, body: { schema: 'phm.apps.actions/1', total: 4, lookups: 2 } });
    const limited = await get(`${APPS_ACTIONS_PATH}?limit=1`);
    expect(limited.body.actions).toHaveLength(1);
    expect(limited.body.truncated).toBe(true);
  });

  it('refuses a bad limit, a write, a remote peer and the mobile channel', async () => {
    expect((await get(`${APPS_ACTIONS_PATH}?limit=all`)).status).toBe(400);
    expect((await get(APPS_ACTIONS_PATH, { method: 'POST' })).status).toBe(405);
    expect((await get(APPS_ACTIONS_PATH, { address: '10.0.0.8' })).status).toBe(403);
    expect((await get(APPS_ACTIONS_PATH, { channel: 'mobile' })).status).toBe(403);
  });
});
