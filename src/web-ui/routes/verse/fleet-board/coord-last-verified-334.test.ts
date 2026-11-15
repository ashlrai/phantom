/**
 * coord-last-verified-334.test.ts — RQ-PHX-COORDSTRIPLASTDONE334. The strip's
 * `Last verified` row follows the server rule (fleet-recheck taskSection) and
 * is evidence only: it never moves verdict, missing or exampleTask.
 */
import { describe, expect, it } from 'vitest';
import { readFleetRecheck, type FleetRecheckDeps } from '../../../../core/fleet/fleet-recheck.js';
import type { WorkBoardItem, WorkBoardResult } from '../../../../core/comms/work-board.js';
import type { ChannelHealthView } from '../fleet-channels/channel-health-model.js';
import type { RuntimeIdentityView } from '../fleet-host/runtime-identity-model.js';
import { deriveCoordAnswer, type CoordBoardItem } from './coord-answer-model.js';

const NOW = Date.parse('2026-11-13T18:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const runtime: RuntimeIdentityView = {
  generatedAt: ago(1000), host: 'fake-host-a', platform: 'darwin', asOf: ago(1000),
  installedVersion: '1.2.3', sourceVersion: '1.2.3', versionDrift: false,
  tailnetName: 'fake-host-a.tailnet.fake', fleetState: { ageSeconds: 10, stale: false }, reasons: [],
};
const channels: ChannelHealthView = {
  available: true, asOf: ago(1000),
  channels: [{ channel: 'slack', configured: true, processAlive: true, runtimeHost: null, lastInboundAt: null, lastReplyAt: ago(1000), unansweredCount: 0, state: 'LIVE', missing: [] }],
};
const done = (id: string, ageMs: number, extra: Partial<CoordBoardItem> = {}): CoordBoardItem => ({
  id, state: 'VERIFIED', channelRef: 'fake-team/fake-chan/1.2', receivedAt: ago(ageMs + MIN), asOf: ago(ageMs),
  owner: 'agent-alpha', claimReceipt: 'bus-claim:fake-done-1:1:1700000000000', ...extra,
});
const derive = (items: CoordBoardItem[]) =>
  deriveCoordAnswer({ runtime, channels, board: { inbox: 'ok', asOf: ago(1000), items }, now: NOW });
const lvRow = (a: ReturnType<typeof derive>) => a.rows.find((r) => r.label === 'Last verified')!;

describe('strip Last verified row', () => {
  it('names a lone VERIFIED item without moving verdict, missing or exampleTask', () => {
    const a = derive([done('fake-done-1', 5 * MIN)]);
    const empty = derive([]);
    expect(lvRow(a).value.startsWith('fake-done-1 · owner agent-alpha')).toBe(true);
    expect(lvRow(a).ok).toBe(true);
    expect(a.lastVerified).toEqual({ id: 'fake-done-1', owner: 'agent-alpha', asOf: ago(5 * MIN) });
    expect(a.exampleTask).toBeNull();
    expect(a.verdict).toEqual(empty.verdict);
    expect(a.missing).toEqual(empty.missing);
    expect(lvRow(empty)).toEqual({ label: 'Last verified', value: 'none', ok: 'unknown' });
  });

  it('newer asOf wins; ownerless, receiptless and bad-time items are ignored', () => {
    const a = derive([
      done('fake-old', 60 * MIN),
      done('fake-new', 10 * MIN),
      done('fake-noowner', 1 * MIN, { owner: null }),
      done('fake-noreceipt', 2 * MIN, { claimReceipt: '' }),
      done('fake-badtime', 3 * MIN, { asOf: 'not-a-date' }),
    ]);
    expect(a.lastVerified?.id).toBe('fake-new');
  });

  it('matches the server task.lastVerified pick for the same items', async () => {
    const stripItems = [
      done('fake-old', 60 * MIN), done('fake-new', 10 * MIN),
      done('fake-noowner', 1 * MIN, { owner: null }), done('fake-badtime', 3 * MIN, { asOf: 'not-a-date' }),
    ];
    const serverItems = stripItems.map((i): WorkBoardItem => ({
      id: i.id!, channel: 'slack', channelRef: i.channelRef ?? null, receivedAt: i.receivedAt!, state: 'VERIFIED',
      asOf: i.asOf!, source: 'bus-reply:fake', missing: [],
      owner: i.owner ?? null, claimReceipt: i.claimReceipt ?? null,
    }));
    const deps: FleetRecheckDeps = {
      now: () => new Date(NOW), homeDir: () => '/home/fakeuser',
      readRuntimeIdentity: async () => ({
        host: 'fake-host', platform: 'fakeos', asOf: ago(0), installedVersion: '1.2.3', sourceVersion: '1.2.3',
        versionDrift: false, tailnetName: 'fake-node', reasons: [],
        fleetState: { path: '~/fake/state.json', mtime: ago(60_000), ageSeconds: 60, stale: false },
      }),
      readFleetBoard: async () => ({ schema: 'fleet.coordination.v1', state: 'known', claims: [], messages: [], proposals: [], expiredClaims: 0 }),
      readChannelHealth: async () => ({ schemaVersion: 1, asOf: ago(0), channels: [] }),
      listWorkBoard: async (): Promise<WorkBoardResult> => ({ items: serverItems, inbox: 'ok', truncated: false }),
      listCoordination: async () => ({ source: 'unavailable', claims: [] }),
    };
    const server = (await readFleetRecheck(deps)).sections.task.lastVerified;
    expect(server?.id).toBe('fake-new');
    expect(derive(stripItems).lastVerified?.id).toBe(server?.id);
  });

  it('prints unknown while loading and unavailable without a board', () => {
    const base = { runtime, channels, now: NOW };
    const u = deriveCoordAnswer({ ...base, board: undefined });
    const n = deriveCoordAnswer({ ...base, board: null });
    expect(u.rows.find((r) => r.label === 'Last verified')).toEqual({ label: 'Last verified', value: 'unknown', ok: 'unknown' });
    expect(n.rows.find((r) => r.label === 'Last verified')).toEqual({ label: 'Last verified', value: 'unavailable', ok: 'unknown' });
    expect(u.lastVerified).toBeNull();
    expect(n.lastVerified).toBeNull();
  });
});
