import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AshlrConfig } from '../src/core/types.js';
import { acknowledgeTelegramUpdate, pollTelegramUpdates, readTelegramHealth,
  setTelegramTransportForTests, telegramQuestionNamespace } from '../src/core/integrations/telegram.js';

const cfg = (chatId = '4242') => ({ comms: { enabled: true, channel: 'telegram',
  telegram: { chatId, botToken: 'fake-test-token' } } }) as AshlrConfig;
const message = () => ({ chat: { id: 4242, type: 'private' },
  from: { id: 4242, is_bot: false }, message_id: 7, text: 'verified instruction' });
let home: string;
let previousHome: string | undefined;
let batch: unknown[];
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  previousHome = process.env.HOME;
  home = mkdtempSync(join(tmpdir(), 'telegram-sender-'));
  process.env.HOME = home;
  batch = [];
  fetchMock = vi.fn(async () => ({ json: async () => ({ ok: true, result: batch }) }));
  vi.stubGlobal('fetch', fetchMock);
  // The adapter uses HTTPS in production. Route its method-only seam through
  // mocked fetch, with no provider URL or network fallback.
  setTelegramTransportForTests(async (method, body) => {
    if (method === 'deleteWebhook') return { ok: true };
    expect(method).toBe('getUpdates');
    return (await fetch('https://telegram.invalid/test', { body: JSON.stringify(body) })).json();
  });
});
afterEach(() => {
  setTelegramTransportForTests(null);
  vi.unstubAllGlobals();
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  rmSync(home, { recursive: true, force: true });
});

describe('Telegram operator sender verification', () => {
  it('accepts a verified private sender and preserves reply threading', async () => {
    batch = [{ update_id: 1, message: { ...message(), reply_to_message: { message_id: 3 } } }];
    expect((await pollTelegramUpdates(cfg())).updates).toEqual([
      { kind: 'text', text: 'verified instruction', fromChatId: '4242', messageId: 7, replyToMessageId: 3 },
    ]);
  });

  it.each([
    { from: { id: 99, is_bot: false } }, { from: undefined },
    { from: { id: '4242', is_bot: false } }, { from: { id: 4242 } },
    { from: { id: 4242, is_bot: true } }, { sender_chat: { id: 4242 } },
    { chat: { id: 4242, type: 'channel' } }, { chat: { id: 4242, type: 'group' } },
    { chat: { id: '4242', type: 'private' } },
  ])('rejects unsafe identity %j without persisting content or blocking later input', async patch => {
    batch = [{ update_id: 10, message: { ...message(), ...patch, text: 'rejected content' } },
      { update_id: 11, message: message() }];
    const result = await pollTelegramUpdates(cfg(), true);
    expect(result.newOffset).toBe(12);
    expect(result.updates).toHaveLength(1);
    expect(readFileSync(join(home, '.ashlr/comms/telegram-inbound.json'), 'utf8')).not.toContain('rejected content');
    acknowledgeTelegramUpdate(11, cfg());
    batch = [];
    await pollTelegramUpdates(cfg(), true);
    expect(JSON.parse(fetchMock.mock.calls.at(-1)![1].body)).toMatchObject({ offset: 12 });
  });

  it.each(['request:0', 'lt:question', 'revert:proposal'])('verifies callbacks before routing %s', async data => {
    const callback = (id: number, chatId = 4242) => ({ id: 'fake-callback', from: { id, is_bot: false },
      message: { chat: { id: chatId, type: 'private' }, message_id: 8 }, data });
    batch = [{ update_id: 1, callback_query: callback(99) },
      { update_id: 2, callback_query: callback(4242, 99) },
      { update_id: 3, callback_query: { ...callback(4242), from: undefined } },
      { update_id: 4, callback_query: callback(4242) }];
    const result = await pollTelegramUpdates(cfg(), true);
    expect(result.updates).toHaveLength(1);
    expect(result.updates[0]).toMatchObject({ kind: 'callback', updateId: 4, messageId: 8 });
    expect((await pollTelegramUpdates(cfg(), true)).updates).toEqual(result.updates);
  });

  it('fails closed for configured groups and explains the configuration limitation', async () => {
    batch = [{ update_id: 1, message: { ...message(), chat: { id: -4242, type: 'supergroup' } } }];
    expect(await pollTelegramUpdates(cfg('-4242'), true)).toEqual({ updates: [], newOffset: 2 });
    expect(readTelegramHealth(cfg('-4242')).error).toContain('no group operator allowlist');
  });

  it.each([{}, { senderUserId: 99, privateChat: true }, { senderUserId: 4242, privateChat: false }])(
    'purges insufficient persisted identity evidence %j before replay', async evidence => {
      const dir = join(home, '.ashlr/comms');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'telegram-inbound.json'), JSON.stringify({ namespace: telegramQuestionNamespace(cfg()),
        newOffset: 20, updates: [{ updateId: 19, kind: 'text', fromChatId: '4242', text: 'legacy unsafe content', ...evidence }] }));
      batch = [{ update_id: 20, message: message() }];
      const result = await pollTelegramUpdates(cfg(), true);
      expect(result.updates).toHaveLength(1);
      expect(result.updates[0]?.updateId).toBe(20);
      expect(readFileSync(join(dir, 'telegram-inbound.json'), 'utf8')).not.toContain('legacy unsafe content');
    });
});
