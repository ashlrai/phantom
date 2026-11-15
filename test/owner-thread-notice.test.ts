import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OwnerChannelTransport, OwnerThreadSettings } from '../src/core/comms/owner-channel.js';
import { OWNER_CHANNELS } from '../src/core/comms/leader-mailbox.js';
import { postOwnerNotice, readOwnerThread, type OwnerThreadOptions } from '../src/core/comms/owner-thread.js';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

const settings: OwnerThreadSettings = {
  owners: {
    desktop: 'local-owner', telegram: 'telegram:100', email: 'email:owner@example.com',
    imessage: 'owner@example.com', slack: 'U0123456789',
  },
  secretHandles: { telegram: 'phm_TELEGRAM_BOT_TOKEN', email: 'phm_EMAIL_CREDENTIAL', slack: 'phm_SLACK_BOT_TOKEN' },
  imessageBridge: 'loopback',
  confirmed: true,
  team: [
    { channel: 'bus', id: 'local-owner' },
    { channel: 'telegram', id: 'telegram:100' },
    { channel: 'email', id: 'email:owner@example.com' },
    { channel: 'imessage', id: 'owner@example.com' },
    { channel: 'slack', id: 'U0123456789' },
  ],
};

function fixture(overrides: Partial<OwnerThreadOptions> = {}) {
  const runsDir = mkdtempSync(join(tmpdir(), 'owner-notice-'));
  roots.push(runsDir);
  const deliver = vi.fn(async () => ({ status: 'sent' as const, reason: 'ok' }));
  const pull = vi.fn(async () => []);
  const transport = (): OwnerChannelTransport => ({ pull, deliver });
  const transports = Object.fromEntries(OWNER_CHANNELS.map(channel => [channel, transport()]));
  const options: OwnerThreadOptions = {
    runsDir, busRoot: join(runsDir, 'bus'), now: () => 1_700_000_000_000,
    settings, halted: false, paused: false, transports, ...overrides,
  };
  return { options, deliver, pull };
}

describe('postOwnerNotice', () => {
  it('appends one outbound desktop line the thread reader returns', async () => {
    const { options } = fixture();
    const result = await postOwnerNotice({ text: 'Morning brief is ready.', idempotencyKey: 'line-0123456789abcdef' }, options);
    expect(result.status).toBe('accepted');
    const thread = readOwnerThread(options);
    expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0]).toMatchObject({
      channel: 'desktop', senderId: 'leader', direction: 'outbound', fanout: ['desktop'],
      text: 'Morning brief is ready.', idempotencyKey: 'line-0123456789abcdef',
    });
  });

  it('a repeated key is a duplicate and adds no line', async () => {
    const { options } = fixture();
    const input = { text: 'PR is up.', idempotencyKey: 'line-aaaaaaaaaaaaaaaa' };
    expect((await postOwnerNotice(input, options)).status).toBe('accepted');
    expect((await postOwnerNotice(input, options)).status).toBe('duplicate');
    expect(readOwnerThread(options).messages).toHaveLength(1);
  });

  it('a repeated key is a duplicate after the line has been archived', async () => {
    const { options } = fixture({ capacity: { messages: 2, bytes: 100_000 } });
    const first = { text: 'one', idempotencyKey: 'line-0000000000000001' };
    await postOwnerNotice(first, options);
    await postOwnerNotice({ text: 'two', idempotencyKey: 'line-0000000000000002' }, options);
    await postOwnerNotice({ text: 'three', idempotencyKey: 'line-0000000000000003' }, options);
    const before = readOwnerThread(options).messages.length;
    expect((await postOwnerNotice(first, options)).status).toBe('duplicate');
    expect(readOwnerThread(options).messages).toHaveLength(before);
  });

  it.each([{ halted: true }, { paused: true }])('writes nothing when %o', async flags => {
    const { options } = fixture(flags);
    const result = await postOwnerNotice({ text: 'Held.', idempotencyKey: 'line-bbbbbbbbbbbbbbbb' }, options);
    expect(result.status).toBe('halted');
    const live = { ...options, halted: false, paused: false };
    expect(readOwnerThread(live).messages).toHaveLength(0);
  });

  it('refuses secret-shaped text and bad keys', async () => {
    const { options } = fixture();
    const secret = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
    expect((await postOwnerNotice({ text: `token ${secret}`, idempotencyKey: 'line-cccccccccccccccc' }, options)).status).toBe('refused');
    expect((await postOwnerNotice({ text: 'fine', idempotencyKey: 'x' }, options)).status).toBe('refused');
    expect(readOwnerThread(options).messages).toHaveLength(0);
  });

  it('never calls any transport', async () => {
    const { options, deliver, pull } = fixture();
    await postOwnerNotice({ text: 'Result ping.', idempotencyKey: 'line-dddddddddddddddd' }, options);
    expect(deliver).not.toHaveBeenCalled();
    expect(pull).not.toHaveBeenCalled();
  });
});
