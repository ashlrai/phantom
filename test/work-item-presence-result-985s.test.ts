import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { collectBusWorkItemEvidence } from '../src/core/comms/work-item-bus-evidence.js';
import { listWorkBoard } from '../src/core/comms/work-board.js';
import { readReplyState } from '../src/core/comms/reply-state.js';

let root: string, now: number;
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'presence-result-985s-')); now = Date.now(); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

function post(id: string, body: unknown, request = false) {
  expect(appendBusInbox({ id, from: request ? 'leader' : 'worker', to: request ? 'worker' : 'leader',
    priority: 'P2', ttl: 60_000, body, ...(request ? { channel: 'slack' as const, channel_ref: 'fake-thread',
      sender: { agent_id: 'leader', vendor: 'fake', human: false, team: true }, external: false } : {}) },
  { root, now: () => now++ }).status).toBe('posted');
}

describe('presence is not work result evidence', () => {
  it.each([
    ['verified', { verified: { tests: 'passed', artifact: 'report' } }, 'VERIFIED'],
    ['blocked', { blocked: { dependency: 'build' } }, 'BLOCKED'],
  ] as const)('ignores %s presence and retains normal reply evidence', (_name, result, state) => {
    post('request', { kind: 'work' }, true);
    post('repeat', { kind: 'work' }, true);
    post('presence-first', { kind: 'group.presence', inReplyTo: 'request', ...result });
    expect(collectBusWorkItemEvidence('request', { root, now }).evidence).not.toHaveProperty(_name === 'blocked' ? 'blocker' : 'verified');
    expect(readReplyState('repeat', { root, now })).toMatchObject({ id: 'request', state: 'RECEIVED' });
    expect(listWorkBoard({ root, now }).items.find(item => item.id === 'request')?.state).toBe('RECEIVED');

    post('reply', { in_reply_to: 'request', ...result });
    expect(readReplyState('repeat', { root, now }).state).toBe(state);
    expect(listWorkBoard({ root, now }).items.find(item => item.id === 'request')?.state).toBe(state);
    const evidence = collectBusWorkItemEvidence('request', { root, now }).evidence;
    post('presence-later', { kind: 'group.presence', inReplyTo: 'request', in_reply_to: 'request',
      verified: { tests: 'fake later' }, blocked: { dependency: 'fake later' } });
    expect(collectBusWorkItemEvidence('request', { root, now }).evidence).toEqual(evidence);
    expect(readReplyState('repeat', { root, now }).state).toBe(state);
  });
});
