/**
 * RQ-PHX-TELEGRAMSTATUSEND2END01 — a Telegram "status" asks the real fleet,
 * once, and never reaches the Leader thread.
 *
 * End-to-end through runCommsCycle with a stubbed Bot API transport (same
 * pattern as telegram-inbox-dispatch-31.test.ts): updates pass
 * integrations/telegram.ts sender verification, the inbox bridge and local
 * commands run for real, and only the two outermost seams are mocked —
 * telegramFleetStatus ('Fleet: 3 running') and converseWithLeader.
 *
 *   /fleet-status  → the bridge answers, result.resolved++, Leader silent.
 *   status         → the local command answers the same fleet text.
 *   send failure   → the cycle reports it, the Leader stays silent.
 *   free text      → still receipted to MASON-INBOX.md and forwarded once.
 *   /fleet-status as a reply to a Leader message → status, not a memo reply.
 *
 * HOME is a fresh tmp dir per test; chat ids and tokens are plainly fake.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const fleet = vi.hoisted(() => ({ telegramFleetStatus: vi.fn(async () => 'Fleet: 3 running') }));
const leader = vi.hoisted(() => ({ converseWithLeader: vi.fn(async () => {}) }));

vi.mock('../src/core/comms/telegram-fleet-status.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/comms/telegram-fleet-status.js')>()),
  telegramFleetStatus: fleet.telegramFleetStatus,
}));
vi.mock('../src/core/comms/telegram-channel.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../src/core/comms/telegram-channel.js')>()),
  converseWithLeader: leader.converseWithLeader,
}));

import { runCommsCycle } from '../src/core/comms/dispatch.js';
import { recordTelegramMessages } from '../src/core/comms/telegram-thread-map.js';
import { setTelegramTransportForTests } from '../src/core/integrations/telegram.js';
import type { AshlrConfig } from '../src/core/types.js';

const CHAT = 1234567;
const fastCycle = { sendGapMs: 0, sleep: async () => {} };

function cfg(): AshlrConfig {
  return { comms: { enabled: true, channel: 'telegram', telegram: { botToken: 'fake-token-status-e2e', chatId: String(CHAT) } } } as AshlrConfig;
}

let updateId = 1;
function textUpdate(text: string, messageId: number, replyToMessageId?: number): unknown {
  return {
    update_id: updateId++,
    message: {
      message_id: messageId,
      chat: { id: CHAT, type: 'private' },
      from: { id: CHAT, is_bot: false },
      text,
      ...(replyToMessageId !== undefined ? { reply_to_message: { message_id: replyToMessageId } } : {}),
    },
  };
}

let updates: unknown[] = [];
let sentTexts: string[] = [];
let sendFails = false;
function fakeTransport(method: string, body: Record<string, unknown>): Promise<unknown> {
  if (method === 'getUpdates') {
    const result = updates;
    updates = [];
    return Promise.resolve({ ok: true, result });
  }
  if (method === 'sendMessage') {
    sentTexts.push(String(body['text']));
    return Promise.resolve(sendFails ? { ok: false, error_code: 500 } : { ok: true, result: { message_id: 8000 } });
  }
  return Promise.resolve({ ok: true, result: true });
}

let home = '';
let previousHome: string | undefined;

beforeEach(() => {
  previousHome = process.env['HOME'];
  home = mkdtempSync(join(tmpdir(), 'tg-status-e2e-home-'));
  process.env['HOME'] = home;
  updates = [];
  sentTexts = [];
  sendFails = false;
  fleet.telegramFleetStatus.mockClear();
  leader.converseWithLeader.mockClear();
  setTelegramTransportForTests(fakeTransport);
});

afterEach(() => {
  setTelegramTransportForTests(null);
  if (previousHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = previousHome;
  rmSync(home, { recursive: true, force: true });
});

describe('Telegram status end to end', () => {
  it('/fleet-status answers once from the fleet; the Leader is never called', async () => {
    updates = [textUpdate('/fleet-status', 500)];
    const result = await runCommsCycle(cfg(), fastCycle);

    expect(sentTexts).toEqual(['Fleet: 3 running']);
    expect(leader.converseWithLeader).not.toHaveBeenCalled();
    expect(result.resolved).toBe(1);
  });

  it('plain "status" answers the same fleet text through the local command', async () => {
    updates = [textUpdate('status', 501)];
    const result = await runCommsCycle(cfg(), fastCycle);

    expect(sentTexts).toEqual(['Fleet: 3 running']);
    expect(leader.converseWithLeader).not.toHaveBeenCalled();
    expect(result.resolved).toBe(1);
  });

  it.each(['/fleet-status', 'status'])('a failed %s send reports the cycle failure; the Leader is never called', async (text) => {
    sendFails = true;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      updates = [textUpdate(text, 502)];
      const result = await runCommsCycle(cfg(), fastCycle);

      expect(sentTexts).toEqual(['Fleet: 3 running']);
      expect(leader.converseWithLeader).not.toHaveBeenCalled();
      expect(result.resolved).toBe(0);
      expect(err.mock.calls.flat().join(' ')).toContain('Telegram inbound handling failed');
    } finally {
      err.mockRestore();
    }
  });

  it('a free-text message is receipted to MASON-INBOX.md and reaches the Leader once', async () => {
    updates = [textUpdate('what is blocking billing?', 503)];
    await runCommsCycle(cfg(), fastCycle);

    const inbox = join(home, '.ashlr-runs', 'leader', 'MASON-INBOX.md');
    expect(existsSync(inbox)).toBe(true);
    const entries = readFileSync(inbox, 'utf8');
    expect(entries.match(/^## /gm)).toHaveLength(1);
    expect(entries).toContain('what is blocking billing?');
    expect(sentTexts).toHaveLength(1);
    expect(sentTexts[0]).toContain('Inbox: what is blocking billing?');

    expect(leader.converseWithLeader).toHaveBeenCalledTimes(1);
    const [event, text] = leader.converseWithLeader.mock.calls[0]!;
    expect(event).toMatchObject({ kind: 'text', senderUserId: CHAT, privateChat: true, messageId: 503 });
    expect(text).toBe('what is blocking billing?');
  });

  it('/fleet-status sent as a reply to a Leader message still answers from the fleet', async () => {
    recordTelegramMessages([900], { kind: 'memo', memoId: 'memo-1' });
    updates = [textUpdate('/fleet-status', 504, 900)];
    const result = await runCommsCycle(cfg(), fastCycle);

    expect(sentTexts).toEqual(['Fleet: 3 running']);
    expect(leader.converseWithLeader).not.toHaveBeenCalled();
    expect(result.resolved).toBe(1);
  });
});
