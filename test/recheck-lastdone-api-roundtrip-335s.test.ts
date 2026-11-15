/** RQ-PHX-LASTDONEAPIPROOF335S — the desktop recheck API roundtrip keeps the
 * current blocked task distinct from the last proven-done task. A real
 * readFleetRecheck verdict (typed fake runtime/claims/bridge/board readers: a
 * current RUNNING item that fails the owner+receipt pick rule, plus a distinct
 * older VERIFIED named-owner item) is appended through appendRecheckRecord to
 * a private temp home, then served by createFleetRecheckApi?history=N. The
 * current task state stays BLOCKED exactly as the classifier decided, the
 * verdict and the persisted compact triple both keep the done id/owner/asOf —
 * never claimReceipt or source — history never upgrades the overall status,
 * pre-334 legacy rows read lastVerified null without inheriting a sibling
 * row's evidence, and a GET leaves the log bytes untouched. Every reader is
 * faked and every root is a fresh temp dir; nothing touches the real home. */
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readFleetRecheck, type FleetRecheckDeps } from '../src/core/fleet/fleet-recheck.js';
import { appendRecheckRecord, recheckLogPath, RECHECK_RECORD_SCHEMA } from '../src/core/fleet/recheck-record.js';
import type { ChannelHealth, ChannelHealthReport } from '../src/core/fleet/channel-health.js';
import type { FleetBoard } from '../src/core/fleet/coordination.js';
import type { RuntimeIdentity } from '../src/core/fleet/runtime-identity.js';
import type { WorkBoardItem, WorkBoardResult } from '../src/core/comms/work-board.js';
import { VERSE_FLEET_RECHECK_PATH as PATH, createFleetRecheckApi } from '../src/core/verse/fleet-recheck-api.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const NOW = new Date('2026-11-13T13:13:00.000Z');
const ISO = NOW.toISOString();
const HOME = '/home/fakeuser';
const DONE_AS_OF = '2026-11-12T22:29:00.000Z';
const DONE_ID = 'fake-done-334';
const DONE_OWNER = 'agent-alpha';
const DONE_RECEIPT = 'bus-claim:fake-done-334:2:1700000000000';
const CURRENT_ID = 'fake-current-335';

const runtime: RuntimeIdentity = {
  host: 'fake-host', platform: 'fakeos', asOf: ISO,
  installedVersion: '1.2.3', sourceVersion: '1.2.3', versionDrift: false,
  fleetState: { path: '~/.ashlr-runs/guardian/state.json', mtime: '2026-11-13T13:12:00.000Z', ageSeconds: 60, stale: false },
  tailnetName: 'fake-tailnet-node', reasons: [],
};
const ledger: FleetBoard = {
  schema: 'fleet.coordination.v1', state: 'known', claims: [], messages: [], proposals: [], expiredClaims: 0,
};
const channel = (c: 'slack' | 'imessage'): ChannelHealth => ({
  channel: c, configured: true, processAlive: true, runtimeHost: 'fake-host',
  lastInboundAt: null, lastReplyAt: null, unansweredCount: 0,
  proof: { requestCoverage: 'idle', futureDatedCount: 0 }, state: 'LIVE', missing: [], asOf: ISO,
});
const channels: ChannelHealthReport = { schemaVersion: 1, asOf: ISO, channels: [channel('slack'), channel('imessage')] };

function boardItem(over: Partial<WorkBoardItem> = {}): WorkBoardItem {
  return {
    id: CURRENT_ID, channel: 'slack', channelRef: 'T0FAKEWS/C0FAKECH/9',
    receivedAt: '2026-11-13T13:10:00.000Z', state: 'RUNNING', asOf: '2026-11-13T13:10:00.000Z',
    source: 'bus-reply:fake-current-335', missing: [],
    owner: 'agent-beta', claimReceipt: null, ...over,
  };
}

/** The distinct older proven-done item: VERIFIED with a named owner and claim
 * receipt, so the classifier retains it as task.lastVerified evidence only. */
function doneItem(): WorkBoardItem {
  return boardItem({
    id: DONE_ID, state: 'VERIFIED', receivedAt: '2026-11-12T22:20:00.000Z',
    asOf: DONE_AS_OF, source: 'bus-reply:fake-done-334',
    owner: DONE_OWNER, claimReceipt: DONE_RECEIPT,
  });
}

function deps(items: WorkBoardItem[], over: Partial<FleetRecheckDeps> = {}): FleetRecheckDeps {
  return {
    now: () => NOW, homeDir: () => HOME,
    readRuntimeIdentity: () => runtime, readFleetBoard: () => ledger, readChannelHealth: () => channels,
    listWorkBoard: (): WorkBoardResult => ({ items, inbox: 'ok', truncated: false }),
    listCoordination: () => ({ source: 'unavailable', claims: [] }),
    ...over,
  };
}

const tmps: string[] = [];
afterEach(() => { while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true }); });
function tempRoot(): string {
  const d = mkdtempSync(join(tmpdir(), 'recheck-335-'));
  tmps.push(d);
  return d;
}

async function call(api: ApiModule, url = PATH) {
  let status = 0;
  let text = '';
  const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  const handled = await api({ cfg: {}, allowDispatch: true } as VerseApiContext, { url } as IncomingMessage, res, PATH, 'GET');
  return { handled, status, body: text ? JSON.parse(text) : null };
}

/** A pre-334 retained row: valid schema, no task.lastVerified key at all. */
function legacyRow(): string {
  return JSON.stringify({
    schema: RECHECK_RECORD_SCHEMA, asOf: '2026-11-12T22:30:00.000Z', overall: 'VERIFIED',
    sections: {
      runtime: { state: 'VERIFIED', host: 'fake-host', installedVersion: '1.2.3', asOf: '2026-11-12T22:30:00.000Z' },
      claims: { state: 'VERIFIED', active: 0, asOf: '2026-11-12T22:30:00.000Z' },
      bridge: { state: 'VERIFIED', missingBridge: null, asOf: '2026-11-12T22:30:00.000Z' },
      task: { state: 'VERIFIED', id: DONE_ID, owner: DONE_OWNER, claimReceipt: DONE_RECEIPT, asOf: DONE_AS_OF },
    },
  });
}

describe('fleet recheck api lastVerified roundtrip', () => {
  it('serves a blocked current task beside the last verified done item, read-only', async () => {
    const root = tempRoot();
    const verdict = await readFleetRecheck(deps([boardItem(), doneItem()]));
    // The classifier's own answer: the RUNNING item lacks a claim receipt, so
    // no pick qualifies and the task section is BLOCKED; the VERIFIED item is
    // evidence only and never becomes the pick or changes a state.
    expect(verdict.sections.task.state).toBe('BLOCKED');
    expect(verdict.sections.task.task).toBeNull();
    expect(verdict.sections.task.lastVerified).toMatchObject({
      id: DONE_ID, owner: DONE_OWNER, asOf: DONE_AS_OF, claimReceipt: DONE_RECEIPT,
    });
    expect(verdict.overall.state).toBe('BLOCKED');

    const appended = appendRecheckRecord(root, verdict, HOME);
    if (!appended.ok) throw new Error('append failed');
    expect(appended.record.sections.task.lastVerified).toEqual({ id: DONE_ID, owner: DONE_OWNER, asOf: DONE_AS_OF });

    const api = createFleetRecheckApi({ readRecheck: () => verdict, home: () => root });
    const before = readFileSync(recheckLogPath(root), 'utf8');
    const r = await call(api, `${PATH}?history=5`);
    expect(r.handled).toBe(true);
    expect(r.status).toBe(200);
    // Read-only: the GET served history without touching the retained log.
    expect(readFileSync(recheckLogPath(root), 'utf8')).toBe(before);

    // Current verdict: still blocked, pick still null, lastVerified intact.
    expect(r.body.recheck.sections.task.state).toBe('BLOCKED');
    expect(r.body.recheck.sections.task.task).toBeNull();
    expect(r.body.recheck.overall.state).toBe('BLOCKED');
    expect(r.body.recheck.sections.task.lastVerified).toMatchObject({
      id: DONE_ID, owner: DONE_OWNER, asOf: DONE_AS_OF,
    });

    // Persisted history: the compact triple carries id/owner/asOf only.
    expect(r.body.history.missing).toBe(false);
    expect(r.body.history.rows).toHaveLength(1);
    const row = r.body.history.rows[0];
    expect(row.overall).toBe('BLOCKED');
    expect(row.sections.task.state).toBe('BLOCKED');
    expect(row.sections.task.id).toBeNull();
    expect(row.sections.task.lastVerified).toEqual({ id: DONE_ID, owner: DONE_OWNER, asOf: DONE_AS_OF });
    expect(row.sections.task.lastVerified).not.toHaveProperty('claimReceipt');
    expect(row.sections.task.lastVerified).not.toHaveProperty('source');
    expect(JSON.stringify(row.sections.task.lastVerified)).not.toContain('bus-claim');
    expect(JSON.stringify(row.sections.task.lastVerified)).not.toContain('bus-reply');
  });

  it('keeps lastVerified null when no board item verified, per request and per row', async () => {
    const root = tempRoot();
    const verdict = await readFleetRecheck(deps([boardItem()]));
    expect(verdict.sections.task.lastVerified).toBeNull();
    const appended = appendRecheckRecord(root, verdict, HOME);
    if (!appended.ok) throw new Error('append failed');
    expect(appended.record.sections.task.lastVerified).toBeNull();

    const api = createFleetRecheckApi({ readRecheck: () => verdict, home: () => root });
    const r = await call(api, `${PATH}?history=5`);
    expect(r.status).toBe(200);
    expect(r.body.recheck.sections.task.lastVerified).toBeNull();
    expect(r.body.history.rows[0].sections.task.lastVerified).toBeNull();
  });

  it('reads a pre-334 legacy row as lastVerified null beside a verified row, never inheriting', async () => {
    const root = tempRoot();
    // Legacy row first (older), then the real appended record (newest): the
    // reader returns newest-first, so the legacy row must not pick up the
    // sibling row's lastVerified evidence.
    mkdirSync(join(root, 'fleet'), { recursive: true });
    appendFileSync(recheckLogPath(root), `${legacyRow()}\n`);
    const verdict = await readFleetRecheck(deps([boardItem(), doneItem()]));
    const appended = appendRecheckRecord(root, verdict, HOME);
    if (!appended.ok) throw new Error('append failed');

    const api = createFleetRecheckApi({ readRecheck: () => verdict, home: () => root });
    const r = await call(api, `${PATH}?history=5`);
    expect(r.status).toBe(200);
    expect(r.body.history.skipped).toBe(0);
    expect(r.body.history.rows).toHaveLength(2);
    // Newest row: the appended record keeps the compact done triple.
    expect(r.body.history.rows[0].sections.task.lastVerified).toEqual({
      id: DONE_ID, owner: DONE_OWNER, asOf: DONE_AS_OF,
    });
    // Older legacy row: no lastVerified key on disk, reads back null — and a
    // VERIFIED overall in history never upgrades the current BLOCKED verdict.
    expect(r.body.history.rows[1].overall).toBe('VERIFIED');
    expect(r.body.history.rows[1].sections.task.lastVerified).toBeNull();
    expect(r.body.recheck.overall.state).toBe('BLOCKED');
    expect(r.body.recheck.sections.task.state).toBe('BLOCKED');
  });
});
