/** RQ-PHX-RECHECKRECORDLASTDONE334 — the retained recheck row keeps the
 * verdict's task.lastVerified as the small {id, owner, asOf} evidence triple
 * (never its claimReceipt or source) so recheck history can name the last
 * proven-done task. Pre-334 rows read back with lastVerified null; a malformed
 * lastVerified is counted skipped, never thrown. Every reader is faked and
 * every root is a fresh temp dir; nothing touches the real home. */
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readFleetRecheck, type FleetRecheckDeps } from '../src/core/fleet/fleet-recheck.js';
import {
  appendRecheckRecord, readRecheckRecords, recheckLogPath,
  RECHECK_REASON_MAX, RECHECK_RECORD_SCHEMA,
} from '../src/core/fleet/recheck-record.js';
import type { ChannelHealth, ChannelHealthReport } from '../src/core/fleet/channel-health.js';
import type { FleetBoard } from '../src/core/fleet/coordination.js';
import type { RuntimeIdentity } from '../src/core/fleet/runtime-identity.js';
import type { WorkBoardItem, WorkBoardResult } from '../src/core/comms/work-board.js';

const NOW = new Date('2026-11-13T13:13:00.000Z');
const ISO = NOW.toISOString();
const HOME = '/home/fakeuser';
const DONE_AS_OF = '2026-11-13T13:05:00.000Z';

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

function item(over: Partial<WorkBoardItem> = {}): WorkBoardItem {
  return {
    id: 'fake-done-1', channel: 'slack', channelRef: 'T0FAKEWS/C0FAKECH/1',
    receivedAt: '2026-11-13T13:00:00.000Z', state: 'VERIFIED', asOf: DONE_AS_OF,
    source: 'bus-reply:fake-reply-1', missing: [],
    owner: 'agent-alpha', claimReceipt: 'bus-claim:fake-done-1:1:1700000000000', ...over,
  };
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

function logRow(over: Record<string, unknown> = {}, task: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: RECHECK_RECORD_SCHEMA, asOf: '2026-11-12T00:00:00.000Z', overall: 'VERIFIED',
    sections: {
      runtime: { state: 'VERIFIED', host: 'fake-host', installedVersion: '1.2.3', asOf: '2026-11-12T00:00:00.000Z' },
      claims: { state: 'VERIFIED', active: 1, asOf: '2026-11-12T00:00:00.000Z' },
      bridge: { state: 'VERIFIED', missingBridge: null, asOf: '2026-11-12T00:00:00.000Z' },
      task: { state: 'VERIFIED', id: 'T-1', owner: 'fake-agent', claimReceipt: 'rcpt-1', asOf: '2026-11-12T00:00:00.000Z', ...task },
    },
    ...over,
  });
}

const dirs: string[] = [];
const tempRoot = (): string => { const d = mkdtempSync(join(tmpdir(), 'recheck-334-')); dirs.push(d); return d; };
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

describe('recheck-record task.lastVerified', () => {
  it('retains exactly {id, owner, asOf} — never claimReceipt or source — and reads it back', async () => {
    const root = tempRoot();
    const verdict = await readFleetRecheck(deps([item()]));
    expect(verdict.sections.task.lastVerified).toMatchObject({ id: 'fake-done-1', owner: 'agent-alpha', asOf: DONE_AS_OF });
    const res = appendRecheckRecord(root, verdict, HOME);
    if (!res.ok) throw new Error('append failed');
    const lv = res.record.sections.task.lastVerified;
    expect(lv).toEqual({ id: 'fake-done-1', owner: 'agent-alpha', asOf: DONE_AS_OF });
    expect(lv).not.toHaveProperty('claimReceipt');
    expect(lv).not.toHaveProperty('source');
    const line = readFileSync(recheckLogPath(root), 'utf8');
    expect(line).not.toContain('bus-reply:fake-reply-1');
    const rows = readRecheckRecords(root, 5);
    expect(rows.skipped).toBe(0);
    expect(rows.rows[0]!.sections.task.lastVerified).toEqual({ id: 'fake-done-1', owner: 'agent-alpha', asOf: DONE_AS_OF });
  });

  it('stores null when the verdict has no lastVerified', async () => {
    const root = tempRoot();
    const verdict = await readFleetRecheck(deps([]));
    expect(verdict.sections.task.lastVerified).toBeNull();
    const res = appendRecheckRecord(root, verdict, HOME);
    if (!res.ok) throw new Error('append failed');
    expect(res.record.sections.task.lastVerified).toBeNull();
    expect(readRecheckRecords(root, 5).rows[0]!.sections.task.lastVerified).toBeNull();
  });

  it('reads a pre-334 row without the key back as lastVerified null with skipped 0', () => {
    const root = tempRoot();
    mkdirSync(join(root, 'fleet'), { recursive: true });
    appendFileSync(recheckLogPath(root), `${logRow()}\n`);
    const res = readRecheckRecords(root, 5);
    expect(res.skipped).toBe(0);
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]!.sections.task.lastVerified).toBeNull();
  });

  it('counts a malformed lastVerified as skipped, never thrown', () => {
    const root = tempRoot();
    mkdirSync(join(root, 'fleet'), { recursive: true });
    appendFileSync(recheckLogPath(root), `${logRow({}, { lastVerified: { id: 5 } })}\n${logRow()}\n`);
    const res = readRecheckRecords(root, 5);
    expect(res.skipped).toBe(1);
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]!.sections.task.lastVerified).toBeNull();
  });

  it('sanitizes the home dir inside lastVerified.owner', async () => {
    const root = tempRoot();
    // The verdict read has no real home to redact, so the owner arrives raw.
    const verdict = await readFleetRecheck(deps([item({ owner: `${HOME}/agent` })], { homeDir: () => '/nonexistent' }));
    expect(verdict.sections.task.lastVerified?.owner).toBe(`${HOME}/agent`);
    const res = appendRecheckRecord(root, verdict, HOME);
    if (!res.ok) throw new Error('append failed');
    expect(res.record.sections.task.lastVerified?.owner).toBe('~/agent');
    expect(readFileSync(recheckLogPath(root), 'utf8')).not.toContain(HOME);
  });

  it('caps an oversized id at RECHECK_REASON_MAX', async () => {
    const root = tempRoot();
    const verdict = await readFleetRecheck(deps([item({ id: 'x'.repeat(400) })]));
    const res = appendRecheckRecord(root, verdict, HOME);
    if (!res.ok) throw new Error('append failed');
    expect(res.record.sections.task.lastVerified?.id).toBe('x'.repeat(RECHECK_REASON_MAX));
    expect(readRecheckRecords(root, 5).rows[0]!.sections.task.lastVerified?.id).toHaveLength(RECHECK_REASON_MAX);
  });
});
