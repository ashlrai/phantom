import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AshlrConfig } from '../src/core/types.js';
import type { InboundEvent } from '../src/core/integrations/telegram.js';

const thread = vi.hoisted(() => ({ appendMasonMessage: vi.fn() }));
vi.mock('../src/core/vision/leader-thread.js', () => ({ appendMasonMessage: thread.appendMasonMessage }));
vi.mock('../src/core/comms/leader-line.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/core/comms/leader-line.js')>(),
  routeLeaderText: vi.fn(async () => false),
}));

import { converseWithLeader, recordMappedTelegramReply, telegramSourceEventId } from '../src/core/comms/telegram-channel.js';
import { recordTelegramMessages } from '../src/core/comms/telegram-thread-map.js';
import { setTelegramSendClockForTests, setTelegramTransportForTests } from '../src/core/integrations/telegram.js';

const cfg = { comms: { enabled: true, channel: 'telegram', telegram: { botToken: '000000:FAKE', chatId: '7' } } } as AshlrConfig;
const event: InboundEvent = { kind: 'text', fromChatId: '7', updateId: 777 };
const privateText = 'Private text that must never appear in warnings';
let home: string;
const savedHome = process.env['HOME'];
let messages: string[];

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'telegram-replay-'));
  process.env['HOME'] = home;
  messages = [];
  const receipts = new Map<string, { fingerprint: string; result: { message: { id: string }; reply: null } }>();
  thread.appendMasonMessage.mockReset().mockImplementation(async (body: string, opts: { sourceEventId?: string; replyTo?: string; recordOnly?: boolean }) => {
    const fingerprint = JSON.stringify([body, opts.replyTo ?? null, opts.recordOnly === true]);
    const prior = opts.sourceEventId ? receipts.get(opts.sourceEventId) : undefined;
    if (prior) {
      if (prior.fingerprint !== fingerprint) {
        throw Object.assign(new Error('sourceEventId conflicts with an accepted payload'), { name: 'LeaderThreadError', code: 409 });
      }
      return prior.result;
    }
    messages.push(body);
    const result = { message: { id: `message-${messages.length}` }, reply: null };
    if (opts.sourceEventId) receipts.set(opts.sourceEventId, { fingerprint, result });
    return result;
  });
  setTelegramTransportForTests(async () => ({ ok: true, result: { message_id: 1000 } }));
  let now = 0;
  setTelegramSendClockForTests({ now: () => now, sleep: async (ms) => { now += ms; } });
});

afterEach(() => {
  vi.restoreAllMocks();
  setTelegramTransportForTests(null);
  setTelegramSendClockForTests(null);
  if (savedHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = savedHome;
  rmSync(home, { recursive: true, force: true });
});

describe('Telegram Leader input replay', () => {
  it('passes the update ID on each conversation attempt and records it once', async () => {
    await converseWithLeader(event, privateText, cfg);
    await converseWithLeader(event, privateText, cfg);
    expect(thread.appendMasonMessage).toHaveBeenCalledTimes(2);
    for (const [, opts] of thread.appendMasonMessage.mock.calls) expect(opts.sourceEventId).toBe('telegram:777');
    expect(messages).toEqual([privateText]);
  });

  it('omits the ID for older events', async () => {
    await converseWithLeader({ kind: 'text', fromChatId: '7' }, privateText, cfg);
    expect(thread.appendMasonMessage.mock.calls[0]![1]).not.toHaveProperty('sourceEventId');
  });

  it('rejects a conflicting conversation replay without logging message text', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await converseWithLeader(event, 'First accepted message', cfg);
    await expect(converseWithLeader(event, privateText, cfg)).resolves.toBeUndefined();
    expect(messages).toEqual(['First accepted message']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]!.join(' ')).toContain('777');
    expect(warn.mock.calls[0]!.join(' ')).not.toContain(privateText);
  });

  it('deduplicates mapped replies and consumes a conflicting replay', async () => {
    recordTelegramMessages([42], { kind: 'notification', threadId: 'lt-20261031000000-abcdef' });
    const reply = { ...event, replyToMessageId: 42 };
    expect(await recordMappedTelegramReply(reply, 'First accepted message', cfg)).toBe(true);
    expect(await recordMappedTelegramReply(reply, 'First accepted message', cfg)).toBe(true);
    expect(thread.appendMasonMessage).toHaveBeenCalledTimes(2);
    for (const [, opts] of thread.appendMasonMessage.mock.calls) {
      expect(opts).toMatchObject({ sourceEventId: 'telegram:777', recordOnly: true });
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await recordMappedTelegramReply(reply, privateText, cfg)).toBe(true);
    expect(messages).toEqual(['First accepted message']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]!.join(' ')).toContain('777');
    expect(warn.mock.calls[0]!.join(' ')).not.toContain(privateText);
  });

  it('does not swallow other 409 errors on mapped replies', async () => {
    recordTelegramMessages([42], { kind: 'notification' });
    const error = Object.assign(new Error('Leader input receipt store is full'), { name: 'LeaderThreadError', code: 409 });
    thread.appendMasonMessage.mockRejectedValueOnce(error);
    await expect(recordMappedTelegramReply({ ...event, replyToMessageId: 42 }, privateText, cfg)).rejects.toBe(error);
  });

  it('accepts only non-negative safe integer update IDs', () => {
    expect(telegramSourceEventId({ updateId: 0 })).toBe('telegram:0');
    for (const updateId of [-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(telegramSourceEventId({ updateId })).toBeUndefined();
    }
    expect(telegramSourceEventId({})).toBeUndefined();
    expect(telegramSourceEventId({ updateId: Number.MAX_SAFE_INTEGER })).toBe(`telegram:${Number.MAX_SAFE_INTEGER}`);
  });
});
