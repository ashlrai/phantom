import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseHoldCommand, renderHoldReply } from '../src/core/comms/telegram-hold-command.js';
import { handleSlashCommand, TELEGRAM_HELP_TEXT } from '../src/core/comms/telegram-channel.js';
import { setTelegramSendClockForTests, setTelegramTransportForTests, type InboundEvent } from '../src/core/integrations/telegram.js';
import type { AshlrConfig } from '../src/core/types.js';

const chat = 4242;
const cfg = { comms: { enabled: true, channel: 'telegram', telegram: { chatId: String(chat), botToken: 'fake' } } } as AshlrConfig;
const verified: InboundEvent = { kind: 'text', fromChatId: String(chat), senderUserId: chat, privateChat: true, messageId: 10 };

describe('Telegram hold command parsing and replies', () => {
  it.each([
    ['/hold codex-personal 1', { lane: 'codex-personal', minutes: 1, reason: 'held from Telegram' }],
    ['/hold@fleet_bot claude-api 1440 burning credentials', { lane: 'claude-api', minutes: 1440, reason: 'burning credentials' }],
    ['/HOLD codex-local 001 retry later', { lane: 'codex-local', minutes: 1, reason: 'retry later' }],
    [`/hold devin 5 ${'x'.repeat(120)}`, { lane: 'devin', minutes: 5, reason: 'x'.repeat(120) }],
  ])('parses %s', (text, expected) => expect(parseHoldCommand(text as string)).toEqual(expected));

  it.each([
    '/hold', '/hold 10', '/hold codex-personal', '/hold codex-personal 0', '/hold codex-personal 1441',
    '/hold codex-personal 1.5', '/hold codex-personal -1', '/hold codex-personal 1e2',
    '/hold codex-personal 999999999999999999999', '/hold CODEX-PERSONAL 1', '/hold codex_personal 1',
    '/hold ghost-lane 1', '/hold codex-personal 1 café', '/hold codex-personal 1 line\nbreak',
    `/hold codex-personal 1 ${'x'.repeat(121)}`,
  ])('rejects %s', text => expect(parseHoldCommand(text)).toBeNull());

  it('renders fixed, concise replies', () => {
    expect(renderHoldReply({ status: 'held', lane: 'devin', heldUntil: '2026-11-01T01:00:00Z' })).toBe('devin held until 2026-11-01T01:00:00Z.');
    expect(renderHoldReply({ status: 'failed', reason: 'manual-hold' })).toBe('Hold failed: a person’s hold remains in place.');
    expect(renderHoldReply({ status: 'failed', reason: 'unknown-lane' })).toBe('Hold failed: lane is unavailable.');
    expect(renderHoldReply({ status: 'failed', reason: 'unavailable' })).toBe('Hold failed: lane holds unavailable.');
    expect(renderHoldReply({ status: 'usage' })).toBe('Usage: /hold <lane> <minutes> [reason]');
  });
});

describe('Telegram hold channel', () => {
  let root: string;
  let slots: string;
  let previousRuns: string | undefined;
  let sent: Record<string, unknown>[];
  let sendOk: boolean;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'telegram-hold-'));
    previousRuns = process.env['ASHLR_RUNS_DIR'];
    process.env['ASHLR_RUNS_DIR'] = root;
    await mkdir(join(root, 'queue'));
    slots = join(root, 'queue', 'slots.json');
    await writeFile(slots, JSON.stringify({ 'codex-personal': { target: 4, floor: 0, ceiling: 8, held: false }, 'claude-api': { target: 2, floor: 0, ceiling: 4, held: true, held_by: 'Mason', held_reason: 'manual' } }));
    sent = [];
    sendOk = true;
    let now = 0;
    setTelegramSendClockForTests({ now: () => now, sleep: async ms => { now += ms; } });
    setTelegramTransportForTests(async (method, body) => {
      if (method === 'sendMessage') { sent.push(body); return sendOk ? { ok: true, result: { message_id: 55 } } : { ok: false }; }
      return { ok: true, result: true };
    });
  });

  afterEach(async () => {
    setTelegramTransportForTests(null);
    setTelegramSendClockForTests(null);
    if (previousRuns === undefined) delete process.env['ASHLR_RUNS_DIR']; else process.env['ASHLR_RUNS_DIR'] = previousRuns;
    await rm(root, { recursive: true, force: true });
  });

  it('places a real hold with Telegram attribution and acknowledges the expiry', async () => {
    await handleSlashCommand(verified, '/hold codex-personal 30 burning jobs', cfg);
    const rows = JSON.parse(await readFile(slots, 'utf8')) as Record<string, Record<string, unknown>>;
    const row = rows['codex-personal']!;
    expect(row).toMatchObject({ held: true, held_reason: 'burning jobs' });
    expect(row['held_by']).toMatch(/^phantom telegram /);
    expect(row['held_until']).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    expect(sent.at(-1)).toMatchObject({ chat_id: String(chat), text: `codex-personal held until ${row['held_until']}.`, reply_parameters: { message_id: 10 } });
    expect(await readFile(join(root, 'queue', 'lane-target-changes.log'), 'utf8')).toContain('\tcodex-personal\thold 30m\ttelegram: burning jobs\n');
  });

  it.each([
    { senderUserId: 9876 }, { privateChat: false }, { privateChat: undefined }, { senderUserId: undefined }, { fromChatId: undefined }, { fromChatId: '9876' },
  ])('rejects missing or wrong identity evidence %j without writing', async evidence => {
    const original = await readFile(slots, 'utf8');
    await handleSlashCommand({ ...verified, ...evidence }, '/hold codex-personal 10', cfg);
    expect(await readFile(slots, 'utf8')).toBe(original);
  });

  it('does not write without a configured chat ID', async () => {
    const original = await readFile(slots, 'utf8');
    const noChat = { comms: { enabled: true, channel: 'telegram', telegram: { botToken: 'fake' } } } as AshlrConfig;
    await handleSlashCommand(verified, '/hold codex-personal 10', noChat);
    expect(await readFile(slots, 'utf8')).toBe(original);
  });

  it('answers malformed commands with usage and does not write', async () => {
    const original = await readFile(slots, 'utf8');
    await handleSlashCommand(verified, '/hold codex-personal 0', cfg);
    expect(sent.at(-1)?.['text']).toBe('Usage: /hold &lt;lane&gt; &lt;minutes&gt; [reason]');
    expect(await readFile(slots, 'utf8')).toBe(original);
  });

  it('keeps a person’s existing hold unchanged', async () => {
    const original = await readFile(slots, 'utf8');
    await handleSlashCommand(verified, '/hold claude-api 10', cfg);
    expect(sent.at(-1)?.['text']).toBe('Hold failed: a person’s hold remains in place.');
    expect(await readFile(slots, 'utf8')).toBe(original);
  });

  it('reports an absent known lane and unavailable storage without exposing errors', async () => {
    const original = await readFile(slots, 'utf8');
    await handleSlashCommand(verified, '/hold devin 10', cfg);
    expect(sent.at(-1)?.['text']).toBe('Hold failed: lane is unavailable.');
    expect(await readFile(slots, 'utf8')).toBe(original);
    await rm(slots);
    await handleSlashCommand(verified, '/hold codex-personal 10', cfg);
    expect(sent.at(-1)?.['text']).toBe('Hold failed: lane holds unavailable.');
  });

  it('throws if the acknowledgement fails after a hold', async () => {
    sendOk = false;
    await expect(handleSlashCommand(verified, '/hold codex-personal 10', cfg)).rejects.toThrow('Telegram acknowledgement failed');
    expect(JSON.parse(await readFile(slots, 'utf8'))['codex-personal']['held']).toBe(true);
  });

  it('advertises the command in help', () => {
    expect(TELEGRAM_HELP_TEXT).toContain('/hold <lane> <minutes> [reason]');
  });
});
