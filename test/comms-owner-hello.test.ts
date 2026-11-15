import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdCommsOwner } from '../src/cli/comms-owner-thread.js';
import type { OwnerChannelTransport, OwnerDelivery, OwnerThreadSettings } from '../src/core/comms/owner-channel.js';
import { OWNER_HELLO_TEXT, readOwnerThread, sendOwnerHello, type OwnerThreadOptions } from '../src/core/comms/owner-thread.js';
import { listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); vi.restoreAllMocks(); });

const base: OwnerThreadSettings = {
  owners: { telegram: 'telegram:owner-test-1', imessage: 'owner-test-2' },
  secretHandles: { telegram: 'phm_TELEGRAM_BOT_TOKEN' },
  imessageBridge: 'off',
  confirmed: true,
  team: [
    { channel: 'telegram', id: 'telegram:owner-test-1' },
    { channel: 'imessage', id: 'owner-test-2' },
  ],
};

function fixture(settings: Partial<OwnerThreadSettings> = {}, overrides: Partial<OwnerThreadOptions> = {}) {
  const runsDir = mkdtempSync(join(tmpdir(), 'owner-hello-'));
  roots.push(runsDir);
  const sent: Array<OwnerDelivery & { channel: string }> = [];
  const transport = (channel: string, fail = false): OwnerChannelTransport => ({
    async pull() { return []; },
    async deliver(input) {
      if (fail) throw new Error('boom');
      sent.push({ ...input, channel });
      return { status: 'sent', reason: 'ok' };
    },
  });
  const options: OwnerThreadOptions = {
    runsDir, busRoot: join(runsDir, 'bus'), now: () => 1_700_000_000_000,
    settings: { ...base, ...settings }, halted: false, paused: false,
    transports: { telegram: transport('telegram'), imessage: transport('imessage'), slack: transport('slack') },
    ...overrides,
  };
  return { options, sent, transport };
}

describe('sendOwnerHello', () => {
  it('delivers once with the exact text, records it, and reports duplicate on retry', async () => {
    const { options, sent } = fixture();
    const first = await sendOwnerHello(options);
    expect(first.status).toBe('sent');
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ channel: 'telegram', text: 'Leader is live here, reply to talk to me.', ownerId: 'telegram:owner-test-1', idempotencyKey: 'hello-telegram-v1:telegram' });
    expect(OWNER_HELLO_TEXT).toBe(sent[0]!.text);
    const thread = readOwnerThread(options);
    expect(thread.messages).toHaveLength(1);
    expect(thread.messages[0]).toMatchObject({ direction: 'outbound', senderId: 'leader', channel: 'telegram', fanout: ['telegram'], idempotencyKey: 'hello-telegram-v1' });
    expect(thread.messages[0]!.replyTo).toBeUndefined();

    const second = await sendOwnerHello(options);
    expect(second.status).toBe('duplicate');
    expect(second.deliveries.find(row => row.channel === 'telegram')?.status).toBe('duplicate');
    expect(sent).toHaveLength(1);
    expect(readOwnerThread(options).messages).toHaveLength(1);
  });

  it.each([
    ['missing secret handle', { secretHandles: {} }],
    ['missing owner id', { owners: {} }],
    ['unconfirmed owner', { confirmed: false }],
  ])('does not deliver with %s', async (_name, settings) => {
    const { options, sent } = fixture(settings as Partial<OwnerThreadSettings>);
    const result = await sendOwnerHello(options);
    expect(sent.filter(row => row.channel === 'telegram')).toHaveLength(0);
    const row = result.deliveries.find(entry => entry.channel === 'telegram')!;
    expect(row.status).not.toBe('sent');
    expect(row.reason.length).toBeGreaterThan(0);
  });

  it('skips a disabled imessage bridge with the reason', async () => {
    const { options, sent } = fixture();
    const result = await sendOwnerHello(options);
    const row = result.deliveries.find(entry => entry.channel === 'imessage')!;
    expect(row.status).toBe('disabled');
    expect(row.reason).toMatch(/loopback/i);
    expect(sent.some(entry => entry.channel === 'imessage')).toBe(false);
  });

  it.each([['halted'], ['paused']])('calls no transport when %s', async flag => {
    const { options, sent } = fixture({}, { [flag]: true });
    const result = await sendOwnerHello(options);
    expect(result).toEqual({ status: 'halted', deliveries: [] });
    expect(sent).toHaveLength(0);
  });

  it('refuses a throwing transport and still tries the other channels', async () => {
    const { options, sent, transport } = fixture({ imessageBridge: 'loopback' });
    options.transports = { telegram: transport('telegram', true), imessage: transport('imessage') };
    const result = await sendOwnerHello(options);
    expect(result.status).toBe('partial');
    expect(result.deliveries.find(row => row.channel === 'telegram')?.status).toBe('refused');
    expect(result.deliveries.find(row => row.channel === 'imessage')?.status).toBe('sent');
    expect(sent.map(row => row.channel)).toEqual(['imessage']);
    // The failed channel is retried next time; the sent one is not.
    options.transports.telegram = transport('telegram');
    await sendOwnerHello(options);
    expect(sent.map(row => row.channel)).toEqual(['imessage', 'telegram']);
  });

  it('mirrors imessage to the bus without text', async () => {
    const { options } = fixture({ imessageBridge: 'loopback' });
    await sendOwnerHello(options);
    const page = listBusInboxAfter(0, 50, { root: options.busRoot, now: options.now });
    if (page.status !== 'ok') throw new Error('bus unavailable');
    const mirrored = page.messages.filter(post => post.envelope.id === 'ot-hello-imessage-v1');
    expect(mirrored).toHaveLength(1);
    expect(JSON.stringify(mirrored[0])).not.toContain('Leader is live');
    expect(mirrored[0]!.envelope.body).toMatchObject({ redacted: true });
  });
});

describe('phm comms owner hello', () => {
  it('prints the deliveries as json', async () => {
    const { options } = fixture();
    const lines: string[] = [];
    vi.spyOn(console, 'log').mockImplementation((line: string) => { lines.push(line); });
    expect(await cmdCommsOwner(['hello', '--json'], options)).toBe(0);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.status).toBe('sent');
    expect(parsed.deliveries.find((row: { channel: string }) => row.channel === 'telegram').status).toBe('sent');
    lines.length = 0;
    expect(await cmdCommsOwner(['hello'], options)).toBe(0);
    expect(lines.join('\n')).toContain('telegram: already sent');
    expect(lines.join('\n')).toContain('imessage: skipped');
  });
});
