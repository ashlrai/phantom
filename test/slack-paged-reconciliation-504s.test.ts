import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deliverSlackEnvelope, type SlackCall } from '../src/core/agents/slack-transport.js';
import type { SlackBridgeConfig } from '../src/core/agents/slack-network.js';
import type { BusEnvelope } from '../src/core/fleet/bus-envelope.js';

type Row = Record<string, unknown>;
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const thread = '1793920000.000001', replyTs = '1793920001.000001';
const config: SlackBridgeConfig = { bridgeId: 'slack', teamId: 'T0TEAM', ownUserId: 'U0BOT', ownBotId: 'B0BOT',
  botTokenRef: 'phm_SLACK_AGENTNET_BOT_TOKEN', map: [{ topic: 'leader', channel: 'D0LEADER' }] };
const page = (messages: unknown[], cursor = ''): Row => ({ messages, response_metadata: { next_cursor: cursor } });

async function pending(threaded = true) {
  const stateRoot = mkdtempSync(join(tmpdir(), 'slack-paged-504s-')); roots.push(stateRoot);
  const envelope: BusEnvelope = { id: 'paged-reply', from: 'phantom:leader', to: 'leader', ttl: 60000, priority: 'P1',
    body: { kind: 'note', text: 'Synthetic receipt recovery', ...(threaded ? { thread: `slack:T0TEAM:D0LEADER:${thread}` } : {}) } };
  const options = { config, teamIdentities: [{ channel: 'slack' as const, id: 'U0MASON' }], confirmedByMason: true,
    stateRoot, runsDir: join(stateRoot, 'runs'), busRoot: join(stateRoot, 'bus') };
  let clientId = '', posts = 0;
  const auth = { team_id: config.teamId, user_id: config.ownUserId, bot_id: config.ownBotId };
  const first: SlackCall = vi.fn(async (method, args = {}) => {
    if (method === 'auth.test') return auth;
    if (method === 'conversations.info') return { channel: { id: args.channel, is_im: true, context_team_id: config.teamId } };
    if (method === 'conversations.members') return { members: ['U0BOT', 'U0MASON'] };
    if (method === 'users.info') return { user: { id: args.user, team_id: config.teamId, is_bot: args.user === 'U0BOT' } };
    if (method === 'chat.postMessage') {
      posts++; clientId = String(args.client_msg_id);
      expect(args.thread_ts).toBe(threaded ? thread : undefined);
      expect(receipts()).toMatchObject([{ state: 'attempted', clientId }]);
      throw new Error('synthetic response lost after acceptance');
    }
    throw new Error('unexpected initial method');
  });
  function receipts(): Row[] { return Object.values(JSON.parse(readFileSync(join(stateRoot, 'messages.json'), 'utf8')).messages); }
  expect(await deliverSlackEnvelope(envelope, { ...options, call: first })).toMatchObject({ status: 'uncertain' });
  const matching = { client_msg_id: clientId, user: config.ownUserId, ts: replyTs, ...(threaded ? { thread_ts: thread } : {}) };
  const historyCalls: Array<{ method: string; args: Row }> = [];
  // Each invocation constructs a fresh caller against the same durable store.
  async function restart(history: (args: Row, index: number) => Row | Promise<Row>, identity = auth) {
    historyCalls.length = 0;
    const call: SlackCall = async (method, args = {}) => {
      if (method === 'auth.test') return identity;
      if (method === 'chat.postMessage') { posts++; throw new Error('duplicate send'); }
      historyCalls.push({ method, args });
      expect(method).toBe(threaded ? 'conversations.replies' : 'conversations.history');
      expect(args).toMatchObject({ channel: 'D0LEADER', limit: 100 });
      expect(args.ts).toBe(threaded ? thread : undefined);
      return history(args, historyCalls.length - 1);
    };
    return deliverSlackEnvelope(envelope, { ...options, call });
  }
  return { matching, restart, receipts, historyCalls, posts: () => posts, envelope, options };
}

describe('bounded durable Slack reconciliation across history pages', () => {
  it.each([true, false])('recovers page two after restart (threaded=%s) without another send', async threaded => {
    const h = await pending(threaded);
    expect(await h.restart(args => args.cursor === undefined ? page([{ ts: '1793920009.000001' }], 'opaque+/= cursor') : page([h.matching])))
      .toMatchObject({ status: 'sent', reason: 'delivery-reconciled', ts: replyTs });
    expect(h.historyCalls.map(row => row.args.cursor)).toEqual([undefined, 'opaque+/= cursor']);
    expect(h.receipts()).toMatchObject([{ state: 'sent', ts: replyTs }]);
    expect(await h.restart(() => { throw new Error('terminal receipt must not read history'); })).toMatchObject({ status: 'duplicate' });
    expect(h.historyCalls).toHaveLength(0);
    expect(h.posts()).toBe(1);
  });

  it.each(['conflict', 'cycle', 'page cap', 'throw', 'malformed messages', 'oversized page', 'bad metadata',
    'bad cursor', 'blank cursor', 'missing cursor', 'bad has_more', 'zero matches'] as const)(
    'retains attempted evidence on %s and recovers after history is repaired', async failure => {
    const h = await pending();
    const before = h.receipts();
    const result = await h.restart((_args, index) => {
      if (failure === 'page cap') return page(index === 0 ? [h.matching] : [], `page-${index}`);
      if (failure === 'zero matches') return page([]);
      if (index === 0) return page([h.matching], 'second-page');
      switch (failure) {
        case 'conflict': return page([{ ...h.matching, ts: '1793920002.000001' }]);
        case 'cycle': return page([], 'second-page');
        case 'throw': throw new Error('synthetic later-page failure');
        case 'malformed messages': return page([null]);
        case 'oversized page': return page(Array.from({ length: 101 }, () => ({})));
        case 'bad metadata': return { messages: [], response_metadata: [] };
        case 'bad cursor': return { messages: [], response_metadata: { next_cursor: 42 } };
        case 'blank cursor': return page([], '  ');
        case 'missing cursor': return { messages: [], has_more: true };
        case 'bad has_more': return { messages: [], has_more: 'false' };
      }
    });
    expect(result.status).toBe('uncertain');
    expect(h.historyCalls).toHaveLength(failure === 'page cap' ? 16 : failure === 'zero matches' ? 1 : 2);
    expect(h.receipts()).toEqual(before);
    expect(h.receipts()).toMatchObject([{ state: 'attempted' }]);
    expect(h.receipts()[0]).not.toHaveProperty('ts');
    expect(h.posts()).toBe(1);
    expect(await h.restart(() => page([h.matching]))).toMatchObject({ status: 'sent', ts: replyTs });
    expect(h.receipts()).toMatchObject([{ state: 'sent', ts: replyTs }]);
    expect(h.posts()).toBe(1);
  });

  it('counts overlapping pages by physical timestamp while checking the whole history', async () => {
    const h = await pending();
    expect(await h.restart((_args, index) => page([h.matching], index === 0 ? 'overlap' : ''))).toMatchObject({ status: 'sent' });
    expect(h.historyCalls).toHaveLength(2);
    expect(h.posts()).toBe(1);
  });

  it.each(['client id', 'bot', 'thread', 'timestamp'] as const)('requires exact %s on later pages', async mismatch => {
    const h = await pending();
    const wrong = { ...h.matching, ...(mismatch === 'client id' ? { client_msg_id: 'other' } : mismatch === 'bot' ? { user: 'U0OTHER' } :
      mismatch === 'thread' ? { thread_ts: '1793920009.000001' } : { ts: 'invalid' }) };
    expect(await h.restart((_args, index) => page(index === 0 ? [] : [wrong], index === 0 ? 'next' : ''))).toMatchObject({ status: 'uncertain' });
    expect(h.receipts()).toMatchObject([{ state: 'attempted' }]);
    expect(await h.restart(() => page([h.matching]))).toMatchObject({ status: 'sent' });
    expect(h.posts()).toBe(1);
  });

  it('keeps unthreaded attempts separate from replies in another thread', async () => {
    const h = await pending(false);
    expect(await h.restart(() => page([{ ...h.matching, thread_ts: thread }]))).toMatchObject({ status: 'uncertain' });
    expect(h.receipts()).toMatchObject([{ state: 'attempted' }]);
    expect(await h.restart(() => page([h.matching]))).toMatchObject({ status: 'sent' });
    expect(h.posts()).toBe(1);
  });

  it('preserves digest, authenticated bot and exclusive store-lock checks', async () => {
    const h = await pending();
    const noCall = vi.fn<SlackCall>();
    expect(await deliverSlackEnvelope({ ...h.envelope, body: { kind: 'note', text: 'Changed reply' } }, { ...h.options, call: noCall }))
      .toMatchObject({ status: 'refused', reason: 'message-identity-conflict' });
    expect(noCall).not.toHaveBeenCalled();
    expect(await h.restart(() => page([h.matching]), { team_id: config.teamId, user_id: 'U0OTHER', bot_id: 'B0OTHER' }))
      .toMatchObject({ status: 'uncertain' });
    expect(h.historyCalls).toHaveLength(0);
    expect(await h.restart(async () => {
      expect(await deliverSlackEnvelope(h.envelope, { ...h.options, call: noCall })).toMatchObject({ status: 'refused', reason: 'delivery-claimed' });
      return page([h.matching]);
    })).toMatchObject({ status: 'sent' });
    expect(noCall).not.toHaveBeenCalled();
    expect(h.posts()).toBe(1);
  });
});
