import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { appendBusInbox, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import { postBusReply } from '../src/core/fleet/bus-reply-post.js';
import { collectBusWorkItemEvidence } from '../src/core/comms/work-item-bus-evidence.js';
import { classifyWorkItem } from '../src/core/comms/work-item-state.js';

let root: string, now: number;
const options = () => ({ root, now: () => now });
const request = (id: string) => appendBusInbox({ id, from: 'requester', to: 'owner', priority: 'P1', ttl: 10000, body: {} }, options());
const snapshot = () => readFileSync(join(root, 'bus-inbox/messages.json'), 'utf8');
const collect = (id: string) => collectBusWorkItemEvidence(id, { root, now }).evidence;
const classify = (id: string) => classifyWorkItem(collect(id), new Date(now).toISOString());
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'reply-alias-')); now = 1000; });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('bus reply alias round trip', () => {
  it('records a blocked reply and preserves the receipt on an exact retry', () => {
    expect(request('request-blocked').status).toBe('posted');
    const body = { in_reply_to: 'request-blocked', blocked: { dependency: 'review' } };
    expect(postBusReply('request-blocked', 'reply-blocked', body, options())).toMatchObject({ outcome: 'posted', correlation: 'untrusted-routing-only' });
    const page = listBusInboxAfter(0, 100, options());
    expect(page.status === 'ok' && page.messages.find(row => row.envelope.id === 'reply-blocked')?.envelope.body)
      .toMatchObject({ ...body, inReplyTo: 'request-blocked' });
    expect(collect('request-blocked').blocker).toMatchObject({ dependency: 'review', source: 'bus-reply:reply-blocked' });
    expect(classify('request-blocked')).toMatchObject({ state: 'BLOCKED', source: 'bus-reply:reply-blocked' });
    const before = snapshot(); now += 500;
    expect(postBusReply('request-blocked', 'reply-blocked', body, options()).outcome).toBe('duplicate');
    expect(snapshot()).toBe(before);
  });

  it('attributes a verified artifact to a separate request', () => {
    expect(request('request-verified').status).toBe('posted');
    expect(postBusReply('request-verified', 'reply-verified', { in_reply_to: 'request-verified', verified: { artifact: 'report.txt' } }, options()).outcome).toBe('posted');
    expect(collect('request-verified').verified).toMatchObject({ artifact: 'report.txt', source: 'bus-reply:reply-verified' });
    expect(classify('request-verified')).toMatchObject({ state: 'VERIFIED', source: 'bus-reply:reply-verified' });
  });

  it.each(['other', '', ' request ', null, 7, [], {}])('rejects alias %j before storage access', alias => {
    expect(request('request').status).toBe('posted');
    const before = snapshot(), list = vi.fn(), append = vi.fn();
    expect(postBusReply('request', 'reply', { in_reply_to: alias }, options(), { list, append }).outcome).toBe('invalid-input');
    expect(list).not.toHaveBeenCalled(); expect(append).not.toHaveBeenCalled();
    expect(snapshot()).toBe(before);
  });

  it('continues to reject caller-supplied camel alias', () => {
    const list = vi.fn(), append = vi.fn();
    expect(postBusReply('request', 'reply', { inReplyTo: 'request', in_reply_to: 'request' }, options(), { list, append }).outcome).toBe('invalid-input');
    expect(list).not.toHaveBeenCalled(); expect(append).not.toHaveBeenCalled();
  });
});
