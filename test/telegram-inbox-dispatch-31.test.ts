/**
 * RQ-PHX-TELEGRAMTOINBOX31 — dispatch wiring for the Telegram inbox bridge.
 *
 * Proves handleTelegramText's fall-through path (src/core/comms/dispatch.ts)
 * records each verified Mason text into MASON-INBOX.md through
 * recordTelegramToInbox exactly once, before the unchanged
 * converseWithLeader call — and that texts handled by earlier branches
 * (pause/resume, local /commands) never reach the bridge.
 *
 * runCommsCycle is driven end-to-end with a stubbed inbound source:
 * setTelegramTransportForTests answers getUpdates with updates that pass
 * integrations/telegram.ts sender verification (private chat + matching
 * non-bot `from`). The bridge itself is mocked — its behavior is covered in
 * telegram-inbox-bridge-31.test.ts. converseWithLeader is stubbed so the test
 * asserts wiring, not the Leader thread. HOME is a fresh tmp dir per test.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const bridge = vi.hoisted(() => ({
  recordTelegramToInbox: vi.fn(async () => ({ ok: true as const })),
}));
const leader = vi.hoisted(() => ({ converseWithLeader: vi.fn(async () => {}) }));

vi.mock('../src/core/comms/telegram-inbox-bridge.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/comms/telegram-inbox-bridge.js')>()),
  recordTelegramToInbox: bridge.recordTelegramToInbox,
}));
vi.mock('../src/core/comms/telegram-channel.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/comms/telegram-channel.js')>()),
  converseWithLeader: leader.converseWithLeader,
}));

import { runCommsCycle } from '../src/core/comms/dispatch.js';
import { setTelegramTransportForTests } from '../src/core/integrations/telegram.js';
import type { AshlrConfig } from '../src/core/types.js';

const CHAT = 1234567;
const fastCycle = { sendGapMs: 0, sleep: async () => {} };

function cfg(): AshlrConfig {
  return { comms: { enabled: true, channel: 'telegram', telegram: { botToken: 'fake-token-dispatch-31', chatId: String(CHAT) } } } as AshlrConfig;
}

let updateId = 1;
function textUpdate(text: string, messageId: number): unknown {
  return {
    update_id: updateId++,
    message: {
      message_id: messageId,
      chat: { id: CHAT, type: 'private' },
      from: { id: CHAT, is_bot: false },
      text,
    },
  };
}

let updates: unknown[] = [];
function fakeTransport(method: string, _body: Record<string, unknown>): Promise<unknown> {
  if (method === 'getUpdates') {
    const result = updates;
    updates = [];
    return Promise.resolve({ ok: true, result });
  }
  if (method === 'sendMessage') return Promise.resolve({ ok: true, result: { message_id: 8000 } });
  return Promise.resolve({ ok: true, result: true });
}

let home = '';
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env['HOME'];
  home = mkdtempSync(join(tmpdir(), 'tg-dispatch-home-'));
  process.env['HOME'] = home;
  updates = [];
  bridge.recordTelegramToInbox.mockClear();
  leader.converseWithLeader.mockClear();
  setTelegramTransportForTests(fakeTransport);
});

afterEach(() => {
  setTelegramTransportForTests(null);
  if (previousHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = previousHome;
  rmSync(home, { recursive: true, force: true });
});

describe('handleTelegramText fall-through records to the inbox bridge', () => {
  it('a verified Mason text reaches the bridge once, before the Leader', async () => {
    updates = [textUpdate('what is blocking billing?', 500)];
    const config = cfg();
    await runCommsCycle(config, fastCycle);

    expect(bridge.recordTelegramToInbox).toHaveBeenCalledTimes(1);
    const [event, text, passedCfg] = bridge.recordTelegramToInbox.mock.calls[0]!;
    expect(event).toMatchObject({
      kind: 'text', text: 'what is blocking billing?', fromChatId: String(CHAT),
      senderUserId: CHAT, privateChat: true, messageId: 500,
    });
    expect(text).toBe('what is blocking billing?');
    expect(passedCfg).toBe(config);

    // Conversation path unchanged: the Leader still hears the same message, after the receipt.
    expect(leader.converseWithLeader).toHaveBeenCalledTimes(1);
    expect(leader.converseWithLeader).toHaveBeenCalledWith(event, 'what is blocking billing?', config);
    expect(bridge.recordTelegramToInbox.mock.invocationCallOrder[0]!)
      .toBeLessThan(leader.converseWithLeader.mock.invocationCallOrder[0]!);
  });

  it('two conversational texts → one bridge call each', async () => {
    updates = [textUpdate('first note', 600), textUpdate('second note', 601)];
    await runCommsCycle(cfg(), fastCycle);
    expect(bridge.recordTelegramToInbox).toHaveBeenCalledTimes(2);
    expect(bridge.recordTelegramToInbox.mock.calls.map((c) => c[1])).toEqual(['first note', 'second note']);
  });

  it.each(['pause', 'resume', '/help'])('earlier-branch text %j never reaches the bridge', async (text) => {
    updates = [textUpdate(text, 700)];
    await runCommsCycle(cfg(), fastCycle);
    expect(bridge.recordTelegramToInbox).not.toHaveBeenCalled();
    expect(leader.converseWithLeader).not.toHaveBeenCalled();
  });
});
