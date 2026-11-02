import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const bridge = vi.hoisted(() => ({ record: vi.fn(async () => ({ ok: false as const, reason: 'status-replied' as const })) }));
const leader = vi.hoisted(() => ({ converse: vi.fn(async () => {}) }));
vi.mock('../src/core/comms/telegram-inbox-bridge.js', async (original) => ({
  ...(await original<typeof import('../src/core/comms/telegram-inbox-bridge.js')>()), recordTelegramToInbox: bridge.record,
}));
vi.mock('../src/core/comms/telegram-channel.js', async (original) => ({
  ...(await original<typeof import('../src/core/comms/telegram-channel.js')>()), converseWithLeader: leader.converse,
}));
import { runCommsCycle } from '../src/core/comms/dispatch.js';
import { setTelegramTransportForTests } from '../src/core/integrations/telegram.js';
import type { AshlrConfig } from '../src/core/types.js';

let home = '';
let previousHome: string | undefined;
let sent: string[] = [];
beforeEach(() => {
  previousHome = process.env['HOME'];
  home = mkdtempSync(join(tmpdir(), 'ship-dispatch-'));
  process.env['HOME'] = home;
  sent = [];
  bridge.record.mockClear();
  leader.converse.mockClear();
});
afterEach(() => {
  setTelegramTransportForTests(null);
  if (previousHome === undefined) delete process.env['HOME']; else process.env['HOME'] = previousHome;
  rmSync(home, { recursive: true, force: true });
});

describe('ship dispatch', () => {
  it.each(['/ship', '/ship confirm', '/ship@ExampleBot confirm'])('routes %s to the bridge before slash or reply handlers', async text => {
    const cfg = { comms: { enabled: true, channel: 'telegram', telegram: { botToken: 'fake', chatId: '123' } } } as AshlrConfig;
    let first = true;
    setTelegramTransportForTests(async (method, body) => {
      if (method === 'getUpdates') {
        if (!first) return { ok: true, result: [] };
        first = false;
        return { ok: true, result: [{ update_id: 1, message: { message_id: 9, chat: { id: 123, type: 'private' }, from: { id: 123, is_bot: false }, text, reply_to_message: { message_id: 8 } } }] };
      }
      if (method === 'sendMessage') sent.push(String(body['text']));
      return { ok: true, result: { message_id: 10 } };
    });
    await runCommsCycle(cfg, { sendGapMs: 0, sleep: async () => {} });
    expect(bridge.record).toHaveBeenCalledOnce();
    expect(bridge.record.mock.calls[0]?.[1]).toBe(text);
    expect(leader.converse).not.toHaveBeenCalled();
    expect(sent).toEqual([]);
  });
});
