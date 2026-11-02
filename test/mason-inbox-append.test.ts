import { EventEmitter } from 'node:events';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { recordEmailToInbox } from '../src/core/comms/email-drop-bridge.js';
import { recordTelegramToInbox } from '../src/core/comms/telegram-inbox-bridge.js';
import {
  appendMasonInboxOrder,
  channelAppendIdentity,
  MASON_INBOX_SPAWN_OPTIONS,
  masonInboxAppendBinary,
  SAVE_FAILED_REPLY,
  setMasonInboxAppendSpawnForTests,
  type MasonInboxChild,
  type MasonInboxSpawn,
} from '../src/core/fleet/mason-inbox-append.js';
import type { AshlrConfig } from '../src/core/types.js';

interface SpawnCall { file: string; args: readonly string[]; stdin: string }

function mockSpawn(result: { code?: number | null; error?: Error; stderr?: string } = {}): { spawn: MasonInboxSpawn; calls: SpawnCall[] } {
  const calls: SpawnCall[] = [];
  const spawn: MasonInboxSpawn = (file, args) => {
    const call: SpawnCall = { file, args, stdin: '' };
    calls.push(call);
    const stderr = new EventEmitter();
    const child = new EventEmitter() as MasonInboxChild & EventEmitter;
    child.stderr = stderr;
    child.stdin = {
      write(chunk: string) { call.stdin += chunk; },
      end() {
        queueMicrotask(() => {
          if (result.stderr) stderr.emit('data', Buffer.from(result.stderr));
          if (result.error) child.emit('error', result.error);
          else child.emit('close', result.code === undefined ? 0 : result.code);
        });
      },
    };
    return child;
  };
  return { spawn, calls };
}

afterEach(() => setMasonInboxAppendSpawnForTests(null));

describe('mason inbox append helper', () => {
  it('spawns the absolute helper with an args array, shell off, and the message on stdin', async () => {
    const home = mkdtempSync(join(tmpdir(), 'inbox-append-'));
    const mocked = mockSpawn();
    try {
      const result = await appendMasonInboxOrder({
        src: 'telegram', id: '12345', message: 'hold the lane\n--src email --id intruder@evil.test',
        home, spawn: mocked.spawn,
      });
      expect(result.ok).toBe(true);
      expect(mocked.calls).toEqual([{
        file: masonInboxAppendBinary(home),
        args: ['--src', 'telegram', '--id', '12345'],
        stdin: 'hold the lane\n--src email --id intruder@evil.test',
      }]);
      expect(MASON_INBOX_SPAWN_OPTIONS).toEqual({ shell: false, stdio: ['pipe', 'ignore', 'pipe'] });
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('takes telegram, email, and phone identity from the verified sender, not the message', () => {
    expect(channelAppendIdentity('telegram', 'telegram:42')).toEqual({ src: 'telegram', id: '42' });
    expect(channelAppendIdentity('email', 'email:mason@example.com')).toEqual({ src: 'email', id: 'mason@example.com' });
    expect(channelAppendIdentity('mobile', 'verse-operator@mobile')).toEqual({ src: 'phone', id: 'verse-operator@mobile' });
    expect(channelAppendIdentity('telegram', 'telegram:not-a-user-id')).toBeNull();
    expect(channelAppendIdentity('desktop', 'verse-inbox-operator')).toBeNull();
  });

  it('logs a scrubbed warning and does not write when the helper is missing or exits nonzero', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      const missing = mockSpawn({ error: new Error('spawn ENOENT sk-FAKEFAKEFAKEFAKEFAKEFAKE1234 /Users/mason/.ashlr-runs/bin/mason-inbox-append') });
      expect(await appendMasonInboxOrder({ src: 'email', id: 'mason@example.com', message: 'order', spawn: missing.spawn })).toEqual({ ok: false, reason: 'write-failed' });
      expect(warn.mock.calls.flat().join(' ')).not.toMatch(/sk-FAKEFAKEFAKEFAKEFAKEFAKE1234|\/Users\/mason/);
      warn.mockClear();
      const failed = mockSpawn({ code: 1, stderr: 'readonly /home/mason/.ashlr-runs/leader/MASON-INBOX.md' });
      expect(await appendMasonInboxOrder({ src: 'phone', id: 'verse-operator@mobile', message: 'order', spawn: failed.spawn })).toEqual({ ok: false, reason: 'write-failed' });
      expect(warn.mock.calls.flat().join(' ')).not.toContain('/home/mason');
      expect(SAVE_FAILED_REPLY).toBe('save failed, retry');
    } finally {
      warn.mockRestore();
    }
  });

  it('replies save failed, retry on telegram and email when the helper exits nonzero', async () => {
    const root = mkdtempSync(join(tmpdir(), 'inbox-reply-'));
    const outbox = join(root, 'out');
    setMasonInboxAppendSpawnForTests(mockSpawn({ code: 2 }).spawn);
    const send = vi.fn(async () => ({ ok: true, messageId: 1 }));
    const cfg = { comms: { enabled: true, channel: 'telegram', telegram: { botToken: 'fake-token', chatId: '12345' } } } as AshlrConfig;
    try {
      const telegram = await recordTelegramToInbox(
        { updateId: 1, kind: 'text', text: 'hold the lane', fromChatId: '12345', senderUserId: 12345, privateChat: true, messageId: 9 },
        'hold the lane', cfg, { send, runsDir: root, now: () => new Date('2026-11-02T12:00:00Z') },
      );
      expect(telegram).toEqual({ ok: false, reason: 'write-failed' });
      expect(send).toHaveBeenCalledWith(SAVE_FAILED_REPLY, { replyToMessageId: 9 }, cfg);
      const email = await recordEmailToInbox(
        'From: Mason <mason@example.com>\r\nMessage-ID: <m1@example.com>\r\n\r\nhold the lane\r\n',
        { allowedSenders: new Set(['mason@example.com']), runsDir: root, outboxDir: outbox, now: () => new Date('2026-11-02T12:00:00Z') },
      );
      expect(email).toEqual({ ok: false, reason: 'write-failed' });
      const reply = readFileSync(join(outbox, readdirSync(outbox)[0]!), 'utf8');
      expect(reply).toContain(SAVE_FAILED_REPLY);
      expect(reply).not.toContain('hold the lane');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
