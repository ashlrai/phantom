/**
 * coord-answer-model.test.ts — RQ-PHX-COORDANSWERSTRIP322. The pure verdict:
 * REACHABLE only on a non-stale runtime + ok inbox + one LIVE bridge; honest
 * 'unknown' rendering; the RUNNING/VERIFIED-then-ASSIGNED example-task pick;
 * and the rule that an owner is never invented. Fake hosts and ids only.
 */
import { expect, it } from 'vitest';
import type { ChannelHealthRow, ChannelHealthView } from '../fleet-channels/channel-health-model.js';
import type { RuntimeIdentityView } from '../fleet-host/runtime-identity-model.js';
import { deriveCoordAnswer, type CoordBoardItem, type CoordBoardView } from './coord-answer-model.js';

const NOW = Date.parse('2026-11-13T18:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();

const runtime = (fs: Partial<RuntimeIdentityView['fleetState']> = {}): RuntimeIdentityView => ({
  generatedAt: ago(60_000), host: 'fake-host-a', platform: 'darwin', asOf: ago(60_000),
  installedVersion: '1.2.3', sourceVersion: '1.2.3', versionDrift: false,
  tailnetName: 'fake-host-a.tailnet.fake',
  fleetState: { ageSeconds: 120, stale: false, ...fs }, reasons: [],
});

const chan = (channel: ChannelHealthRow['channel'], state: ChannelHealthRow['state'], missing: string[] = []): ChannelHealthRow => ({
  channel, configured: true, processAlive: true, runtimeHost: null, lastInboundAt: null,
  lastReplyAt: ago(4 * 60_000), unansweredCount: 0, state, missing,
});

const channels = (...rows: ChannelHealthRow[]): ChannelHealthView => ({ available: true, asOf: ago(30_000), channels: rows });

const item = (id: string, state: string, ageMs: number, extra: Record<string, unknown> = {}): CoordBoardItem => ({
  id, channelRef: 'fake-team/fake-chan/111.2', receivedAt: ago(ageMs), state, ...extra,
});

const board = (items: CoordBoardItem[], inbox = 'ok'): CoordBoardView => ({ items, inbox, asOf: ago(5_000) });

const derive = (runtime: RuntimeIdentityView | null | undefined, channels: ChannelHealthView | undefined, board: CoordBoardView | null | undefined) =>
  deriveCoordAnswer({ runtime, channels, board, now: NOW });
const row = (answer: ReturnType<typeof derive>, label: string) => answer.rows.find((r) => r.label === label)!;

it('REACHABLE when runtime is fresh, inbox ok and one bridge is LIVE', () => {
  const answer = derive(runtime(),
    channels(chan('slack', 'LIVE'), chan('imessage', 'BLOCKED', ['bridge process'])),
    board([item('wi-fake-0001', 'RUNNING', 2 * 60_000, { owner: 'devin', claimReceipt: 'bus-claim:x' })]));
  expect(answer.verdict).toBe('REACHABLE');
  expect(row(answer, 'Runtime').ok).toBe(true);
  expect(row(answer, 'Runtime').value).toContain('fake-host-a');
  expect(row(answer, 'Claims/work read').ok).toBe(true);
  expect(row(answer, 'Slack bridge').ok).toBe(true);
  // The non-LIVE bridge is still a named gap; it just does not block the verdict.
  expect(answer.missing).toEqual(['iMessage bridge BLOCKED · missing bridge process']);
  expect(answer.exampleTask).toEqual({ id: 'wi-fake-0001', state: 'RUNNING', channelRef: 'fake-team/fake-chan/111.2' });
  expect(row(answer, 'Example task').value).toContain('owner devin');
});

it('BLOCKED with the reason when the runtime fleet state is stale', () => {
  const answer = derive(runtime({ stale: true }), channels(chan('slack', 'LIVE')), board([]));
  expect(answer.verdict).toBe('BLOCKED');
  expect(row(answer, 'Runtime').ok).toBe(false);
  expect(answer.missing).toContain('fleet state is stale');
});

it('BLOCKED when the work-board inbox is unavailable', () => {
  const answer = derive(runtime(), channels(chan('imessage', 'LIVE')), board([], 'unavailable'));
  expect(answer.verdict).toBe('BLOCKED');
  expect(row(answer, 'Claims/work read').ok).toBe(false);
  expect(answer.missing).toContain('work-board inbox unreadable');
});

it('LOADING while any input is undefined, printing unknown never 0', () => {
  const answer = derive(undefined, undefined, undefined);
  expect(answer.verdict).toBe('LOADING');
  expect(answer.missing).toEqual([]);
  for (const r of answer.rows) {
    expect(r.value).toBe('unknown');
    expect(r.ok).toBe('unknown');
  }
});

it('prints unknown for a missing runtime route (null) and blocks the verdict', () => {
  const answer = derive(null, channels(chan('slack', 'LIVE')), board([]));
  expect(answer.verdict).toBe('BLOCKED');
  expect(row(answer, 'Runtime').value).toContain('unknown');
  expect(row(answer, 'Runtime').ok).toBe('unknown');
  expect(answer.missing).toContain('runtime identity not available on this build');
});

it('picks the newest RUNNING or VERIFIED item, else the newest ASSIGNED', () => {
  const pickOrder = [
    item('wi-fake-assigned', 'ASSIGNED', 1 * 60_000, { owner: 'claude', claimReceipt: 'r1' }),
    item('wi-fake-verified', 'VERIFIED', 3 * 60_000, { owner: 'devin', claimReceipt: 'r2' }),
    item('wi-fake-running', 'RUNNING', 5 * 60_000, { owner: 'devin', claimReceipt: 'r3' }),
  ];
  expect(derive(runtime(), channels(chan('slack', 'LIVE')), board(pickOrder)).exampleTask?.id).toBe('wi-fake-verified');
  const fallback = [
    item('wi-fake-older', 'ASSIGNED', 9 * 60_000),
    item('wi-fake-received', 'RECEIVED', 1 * 60_000),
    item('wi-fake-newer', 'ASSIGNED', 2 * 60_000),
  ];
  expect(derive(runtime(), channels(chan('slack', 'LIVE')), board(fallback)).exampleTask?.id).toBe('wi-fake-newer');
});

it('never presents an unowned item as owned, whatever the payload carries', () => {
  // Older payload without the keys at all: shown but unconfirmed.
  const noKeys = derive(runtime(), channels(chan('slack', 'LIVE')), board([item('wi-fake-0002', 'RUNNING', 60_000)]));
  expect(row(noKeys, 'Example task').ok).toBe('unknown');
  expect(row(noKeys, 'Example task').value).not.toContain('owner ');
  expect(noKeys.missing).toContain('owner/claim not in web payload');
  // Newer payload carrying the keys as null: confirmed unowned.
  const nullKeys = derive(runtime(), channels(chan('slack', 'LIVE')),
    board([item('wi-fake-0003', 'RUNNING', 60_000, { owner: null, claimReceipt: null })]));
  expect(row(nullKeys, 'Example task').ok).toBe(false);
  expect(row(nullKeys, 'Example task').value).not.toContain('owner ');
  expect(nullKeys.missing).toContain('example task wi-fake-0003 has no named owner/claim');
});

it('reports no example task when nothing is RUNNING, VERIFIED or ASSIGNED', () => {
  const answer = derive(runtime(), channels(chan('slack', 'LIVE')), board([item('wi-fake-blocked', 'BLOCKED', 60_000)]));
  expect(answer.exampleTask).toBeNull();
  expect(row(answer, 'Example task').value).toBe('none');
  expect(answer.missing).toContain('no RUNNING, VERIFIED or ASSIGNED task on the board');
});
