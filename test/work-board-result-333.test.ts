/**
 * work-board-result-333.test.ts — RQ-PHX-BOARDRESULTCOLUMN333. listWorkBoard
 * carries the verified / blocked evidence as `result`, and omits it otherwise.
 * Real stores in a mkdtemp root; fake ids only.
 */
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { appendBusInbox } from '../src/core/fleet/bus-inbox.js';
import { postBusReply } from '../src/core/fleet/bus-reply-post.js';
import { listWorkBoard } from '../src/core/comms/work-board.js';

let root: string, now: number;
const TTL = 10_000_000;
const request = (id: string) => {
  expect(appendBusInbox({ id, from: 'fake-requester', to: 'fake-lane', priority: 'P1', ttl: TTL,
    body: { kind: 'work' } }, { root, now: () => now }).status).toBe('posted');
  now += 1_000;
};
const reply = (to: string, rid: string, body: unknown) => {
  now += 1_000;
  expect(postBusReply(to, rid, body, { root, now: () => now }).outcome).toBe('posted');
};

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'work-board-result-333-'));
  chmodSync(root, 0o700);
  now = Date.now();
});
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe('work board result', { timeout: 60_000 }, () => {
  it('carries verified and blocked evidence, and omits result otherwise', () => {
    request('fake-verified-333');
    reply('fake-verified-333', 'fake-reply-v', { verified: { pr: 7, head: 'fakehead333abc' } });
    request('fake-blocked-333');
    reply('fake-blocked-333', 'fake-reply-b', { blocked: { dependency: 'fake dep' } });
    request('fake-plain-333');

    const board = listWorkBoard({ root, now });
    expect(board.inbox).toBe('ok');
    const byId = new Map(board.items.map(i => [i.id, i]));
    expect(byId.get('fake-verified-333')!.state).toBe('VERIFIED');
    expect(byId.get('fake-verified-333')!.result)
      .toEqual({ kind: 'verified', pr: 7, head: 'fakehead333abc', tests: null, artifact: null });
    expect(byId.get('fake-blocked-333')!.state).toBe('BLOCKED');
    expect(byId.get('fake-blocked-333')!.result).toEqual({ kind: 'blocked', dependency: 'fake dep' });
    expect('result' in byId.get('fake-plain-333')!).toBe(false);
  });

  it('keeps tests-only and artifact-only verification with null pr/head', () => {
    request('fake-tests-333');
    reply('fake-tests-333', 'fake-reply-t', { verified: { tests: '12 passed' } });
    request('fake-art-333');
    reply('fake-art-333', 'fake-reply-a', { verified: { artifact: 'fake-artifact.log' } });
    const byId = new Map(listWorkBoard({ root, now }).items.map(i => [i.id, i]));
    expect(byId.get('fake-tests-333')!.result)
      .toEqual({ kind: 'verified', pr: null, head: null, tests: '12 passed', artifact: null });
    expect(byId.get('fake-art-333')!.result)
      .toEqual({ kind: 'verified', pr: null, head: null, tests: null, artifact: 'fake-artifact.log' });
  });

  it('caps verified strings at 200 chars', () => {
    request('fake-long-333');
    reply('fake-long-333', 'fake-reply-l', { verified: { tests: 'x'.repeat(500) } });
    const item = listWorkBoard({ root, now }).items.find(i => i.id === 'fake-long-333')!;
    expect(item.result).toMatchObject({ kind: 'verified' });
    expect((item.result as { tests: string }).tests).toHaveLength(200);
  });
});
