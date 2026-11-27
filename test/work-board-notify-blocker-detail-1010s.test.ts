import { expect, it } from 'vitest';
import { diffBoard, planNotifications, type BoardSnapshotItem } from '../src/core/fleet/work-board-notify.js';

const plan = (dependency: string) => {
  const row: BoardSnapshotItem = {
    id: 'fake-blocker-1010s', state: 'BLOCKED', asOf: '2026-11-26T12:00:00Z',
    source: 'bus-reply:fake-blocker', owner: null, claimReceipt: null,
    channel: 'slack', channelRef: 'TFAKE/CFAKE/1700000000.001010',
    blocker: { dependency }, verified: null,
  };
  return planNotifications(diffBoard([], [row]), new Set()).notices[0]!;
};

it('retains a full snapshot-sized dependency and its actionable tail', () => {
  const dependency = `${'x'.repeat(231)} resolve fake-ticket-1010`;
  expect(dependency).toHaveLength(256);
  const notice = plan(dependency);
  expect(notice.detail).toBe(dependency);
  expect(notice.text).toContain(dependency);
});

it('bounds oversized dependencies with an omission marker', () => {
  const notice = plan(`${'x'.repeat(600)} fake-tail`);
  expect(notice.detail).toHaveLength(512);
  expect(notice.detail).toMatch(/ \[\.\.\. omitted\]$/);
  expect(notice.text).toContain(notice.detail);
  expect(notice.text).not.toContain('fake-tail');
});

it('flattens lines and scrubs the complete value before bounding', () => {
  const notice = plan(`${'x'.repeat(470)}\r\nAPI_TOKEN=plainly-fake-noncredential-value\n${'follow up '.repeat(10)}`);
  expect(notice.detail).toContain('[REDACTED]');
  expect(notice.text).not.toContain('plainly-fake-noncredential-value');
  expect(notice.text).not.toMatch(/[\r\n]/);
  expect(notice.detail).toContain('[... omitted]');
});
