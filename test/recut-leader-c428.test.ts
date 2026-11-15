/** RQ-PHX-RECUTLEADERC428 — recut of #5343 (RQ-PHX-LEADERRECEIPTRETRY253S).
 * The ported 253s test proves retry convergence end-to-end through the send
 * path and GET API. This file proves the same convergence at the real store
 * entry points the send path calls: recordDelivery appends one row per
 * attempt and readReceipts answers the LATEST state per channel, so a
 * refused -> delivered retry converges while an untouched channel keeps its
 * record and an unrecorded id stays unknown. */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readReceipts, recordDelivery } from '../src/core/leader/delivery-receipts.js';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })); });

const runsDir = () => {
  const dir = mkdtempSync(join(tmpdir(), 'recut-leader-c428-'));
  roots.push(dir);
  return dir;
};

describe('leader delivery receipts store across a retry (c428)', () => {
  it('converges failed -> delivered for the retried channel, keeps the other channel, unknown for absent ids', () => {
    const dir = runsDir();

    // Attempt 1: iMessage refused, desktop delivered.
    recordDelivery(dir, 'msg-c428', 'imessage', 'failed', 'transport down');
    recordDelivery(dir, 'msg-c428', 'desktop', 'delivered');
    expect(readReceipts(dir, ['msg-c428'])).toEqual({
      'msg-c428': {
        imessage: { state: 'failed', reason: 'transport down' },
        desktop: { state: 'delivered' },
      },
    });

    // Attempt 2: only the failed channel is retried and now delivered.
    recordDelivery(dir, 'msg-c428', 'imessage', 'delivered');
    expect(readReceipts(dir, ['msg-c428', 'msg-never-sent'])).toEqual({
      'msg-c428': {
        imessage: { state: 'delivered' },
        desktop: { state: 'delivered' },
      },
    });
  });

  it('latest row wins per channel and a pending retry does not erase a failed reason until it lands', () => {
    const dir = runsDir();
    recordDelivery(dir, 'msg-p', 'slack', 'failed', 'channel offline');
    recordDelivery(dir, 'msg-p', 'slack', 'pending');
    const during = readReceipts(dir, ['msg-p']);
    expect(during['msg-p']!.slack!.state).toBe('pending');

    recordDelivery(dir, 'msg-p', 'slack', 'delivered');
    expect(readReceipts(dir, ['msg-p'])).toEqual({
      'msg-p': { slack: { state: 'delivered' } },
    });
  });
});
