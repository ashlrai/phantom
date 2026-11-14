/**
 * coord-pick-parity-328.test.ts — RQ-PHX-COORDPICKPARITY328. The strip's
 * example task is picked by the server rule (fleet-recheck taskSection):
 * RUNNING/ASSIGNED only, owned AND claimed, RUNNING first, newest first.
 */
import { expect, it } from 'vitest';
import type { ChannelHealthView } from '../fleet-channels/channel-health-model.js';
import type { RuntimeIdentityView } from '../fleet-host/runtime-identity-model.js';
import { deriveCoordAnswer, type CoordBoardItem } from './coord-answer-model.js';

const NOW = Date.parse('2026-11-13T18:00:00.000Z');
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const runtime: RuntimeIdentityView = {
  generatedAt: ago(1000), host: 'fake-host-a', platform: 'darwin', asOf: ago(1000),
  installedVersion: '1.2.3', sourceVersion: '1.2.3', versionDrift: false,
  tailnetName: 'fake-host-a.tailnet.fake', fleetState: { ageSeconds: 10, stale: false }, reasons: [],
};
const channels: ChannelHealthView = {
  available: true, asOf: ago(1000),
  channels: [{ channel: 'slack', configured: true, processAlive: true, runtimeHost: null, lastInboundAt: null, lastReplyAt: ago(1000), unansweredCount: 0, state: 'LIVE', missing: [] }],
};
const item = (id: string, state: string, ageMs: number, extra: Record<string, unknown> = {}): CoordBoardItem => ({
  id, state, channelRef: 'fake-team/fake-chan/1.2', receivedAt: ago(ageMs), ...extra,
});
const owned = { owner: 'devin', claimReceipt: 'bus-claim:x' };
const unowned = { owner: null, claimReceipt: 'bus-claim:y' };
const unclaimed = { owner: 'claude', claimReceipt: null };
const derive = (items: CoordBoardItem[]) =>
  deriveCoordAnswer({ runtime, channels, board: { inbox: 'ok', asOf: ago(1000), items }, now: NOW });
const taskRow = (a: ReturnType<typeof derive>) => a.rows.find((r) => r.label === 'Example task')!;

it('picks the older owned+claimed ASSIGNED item over a newer unowned RUNNING one', () => {
  const a = derive([item('wi-fake-unowned', 'RUNNING', 1000, unowned), item('wi-fake-owned', 'ASSIGNED', 9000, owned)]);
  expect(a.exampleTask?.id).toBe('wi-fake-owned');
  expect(taskRow(a)).toEqual({ label: 'Example task', value: 'wi-fake-owned · ASSIGNED · owner devin · fake-team/fake-chan/1.2', ok: true });
});

it('never picks a VERIFIED item', () => {
  const a = derive([item('wi-fake-verified', 'VERIFIED', 1000, owned), item('wi-fake-assigned', 'ASSIGNED', 9000, owned)]);
  expect(a.exampleTask?.id).toBe('wi-fake-assigned');
  const only = derive([item('wi-fake-verified', 'VERIFIED', 1000, owned)]);
  expect(only.exampleTask).toBeNull();
});

it('RUNNING beats a newer ASSIGNED among qualified items; newest wins within a state', () => {
  const a = derive([
    item('wi-fake-assigned', 'ASSIGNED', 1000, owned),
    item('wi-fake-run-old', 'RUNNING', 9000, owned),
    item('wi-fake-run-new', 'RUNNING', 5000, owned),
  ]);
  expect(a.exampleTask?.id).toBe('wi-fake-run-new');
});

it('with no qualified item shows the newest eligible one with unowned/unclaimed counts', () => {
  const a = derive([
    item('wi-fake-a', 'RUNNING', 1000, unowned),
    item('wi-fake-b', 'ASSIGNED', 2000, unclaimed),
    item('wi-fake-c', 'ASSIGNED', 3000, { owner: null, claimReceipt: null }),
  ]);
  expect(a.exampleTask?.id).toBe('wi-fake-a');
  expect(taskRow(a).ok).toBe(false);
  expect(taskRow(a).value).toContain('no named owner/claim');
  expect(a.missing).toContain('no RUNNING or ASSIGNED task with a named owner and claim receipt');
  expect(a.missing).toContain('2 task(s) lack a named owner');
  expect(a.missing).toContain('2 task(s) lack a claim receipt');
});

it('omits a count line when its count is zero', () => {
  const a = derive([item('wi-fake-a', 'RUNNING', 1000, unowned)]);
  expect(a.missing).toContain('1 task(s) lack a named owner');
  expect(a.missing.some((m) => m.includes('lack a claim receipt'))).toBe(false);
});

it('reports none when no RUNNING or ASSIGNED item exists', () => {
  const a = derive([item('wi-fake-v', 'VERIFIED', 1000, owned), item('wi-fake-b', 'BLOCKED', 2000, owned)]);
  expect(a.exampleTask).toBeNull();
  expect(taskRow(a)).toEqual({ label: 'Example task', value: 'none', ok: 'unknown' });
  expect(a.missing).toContain('no RUNNING or ASSIGNED task on the board');
  expect(a.missing.join(' ')).not.toContain('VERIFIED');
});

it('treats an unparseable receivedAt as oldest', () => {
  const a = derive([
    { ...item('wi-fake-bad', 'ASSIGNED', 0, owned), receivedAt: 'not-a-date' },
    item('wi-fake-ok', 'ASSIGNED', 9000, owned),
  ]);
  expect(a.exampleTask?.id).toBe('wi-fake-ok');
});

it('keeps the older-payload message when the chosen item lacks owner/claim keys', () => {
  const a = derive([item('wi-fake-legacy', 'RUNNING', 1000)]);
  expect(a.exampleTask?.id).toBe('wi-fake-legacy');
  expect(taskRow(a).ok).toBe('unknown');
  expect(a.missing).toContain('owner/claim not in web payload');
});
