import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleSlashCommand, TELEGRAM_HELP_TEXT } from '../src/core/comms/telegram-channel.js';
import { runCommsCycle } from '../src/core/comms/dispatch.js';
import { setTelegramSendClockForTests, setTelegramTransportForTests, type InboundEvent } from '../src/core/integrations/telegram.js';
import type { AshlrConfig } from '../src/core/types.js';

const chat = 4242;
const cfg = { comms: { enabled: true, channel: 'telegram', telegram: { chatId: String(chat), botToken: '123456:FAKE' } } } as AshlrConfig;
const lanes = {
  'codex-personal': { target: 4, floor: 0, ceiling: 8, held: true, held_reason: 'autobackoff usage limit', held_by: 'autobackoff', held_until: '2026-11-01T00:00:00Z', last_change: 1793448000 },
  'claude-api': { target: 2, floor: 0, ceiling: 4, held: false, last_change: 1793448000 },
};
let root: string;
let slots: string;
let audit: string;
let previousHome: string | undefined;
let previousRuns: string | undefined;
let updates: unknown[];
let sent: Record<string, unknown>[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'telegram-target-'));
  previousHome = process.env['HOME'];
  previousRuns = process.env['ASHLR_RUNS_DIR'];
  process.env['HOME'] = root;
  process.env['ASHLR_RUNS_DIR'] = root;
  await mkdir(join(root, 'queue'));
  slots = join(root, 'queue', 'slots.json');
  audit = join(root, 'queue', 'lane-target-changes.log');
  await writeFile(slots, JSON.stringify(lanes));
  updates = [];
  sent = [];
  let now = 0;
  setTelegramSendClockForTests({ now: () => now, sleep: async ms => { now += ms; } });
  setTelegramTransportForTests(async (method, body) => {
    if (method === 'getUpdates') { const result = updates; updates = []; return { ok: true, result }; }
    if (method === 'sendMessage') { sent.push(body); return { ok: true, result: { message_id: 55 } }; }
    return { ok: true, result: true };
  });
});

afterEach(async () => {
  setTelegramTransportForTests(null);
  setTelegramSendClockForTests(null);
  if (previousHome === undefined) delete process.env['HOME']; else process.env['HOME'] = previousHome;
  if (previousRuns === undefined) delete process.env['ASHLR_RUNS_DIR']; else process.env['ASHLR_RUNS_DIR'] = previousRuns;
  await rm(root, { recursive: true, force: true });
});

const verifiedEvent = (messageId = 10): InboundEvent => ({
  kind: 'text', fromChatId: String(chat), senderUserId: chat, privateChat: true, messageId,
});
const slotsJson = async () => JSON.parse(await readFile(slots, 'utf8')) as Record<string, Record<string, unknown>>;
const lastReply = () => sent.at(-1);

describe('telegram /target', () => {
  it('sets a held lane target through setLaneTarget, preserves holds and unrelated rows, audits and replies on the same thread', async () => {
    await handleSlashCommand({ ...verifiedEvent(10), replyToMessageId: 40 }, '/target codex-personal 6', cfg);
    const rows = await slotsJson();
    // The persisted target is authoritative; the hold and its attribution stay.
    expect(rows['codex-personal']).toMatchObject({
      target: 6, floor: 0, ceiling: 8, held: true,
      held_reason: 'autobackoff usage limit', held_by: 'autobackoff', held_until: '2026-11-01T00:00:00Z',
    });
    expect(String(rows['codex-personal']!['changed_by'])).toMatch(/^telegram \d{4}-\d{2}-\d{2}T/);
    expect(rows['claude-api']).toEqual(lanes['claude-api']);
    expect(await readFile(audit, 'utf8')).toContain('\tcodex-personal\t4->6\ttelegram\n');
    // Plain (transport-escaped) reply on the command's own thread, not the message it replied to.
    expect(lastReply()).toMatchObject({
      chat_id: String(chat), parse_mode: 'HTML',
      text: 'codex-personal target set to 6. Its hold remains active — the target applies when it lifts.',
      reply_parameters: { message_id: 10 },
    });
  });

  it('sets an unheld lane target with a bot suffix and remembers the paused target', async () => {
    await handleSlashCommand(verifiedEvent(11), '/target@phantom_fleet_bot claude-api 0', cfg);
    const rows = await slotsJson();
    expect(rows['claude-api']).toMatchObject({ target: 0, floor: 0, ceiling: 4, held: false, paused_from: 2 });
    expect(rows['codex-personal']).toMatchObject({ target: 4, held: true });
    expect(await readFile(audit, 'utf8')).toContain('\tclaude-api\t2->0\ttelegram\n');
    expect(lastReply()).toMatchObject({ text: 'claude-api target set to 0.', reply_parameters: { message_id: 11 } });
  });

  it.each([
    { fromChatId: '9999', senderUserId: 9999, privateChat: true },
    { fromChatId: String(chat), senderUserId: 9999, privateChat: true },
    { fromChatId: '7777', senderUserId: chat, privateChat: true },
    { fromChatId: String(chat), senderUserId: chat, privateChat: false },
    { fromChatId: String(chat), senderUserId: chat },
    { fromChatId: String(chat) },
    { fromChatId: String(chat), senderUserId: String(chat), privateChat: true },
  ])('keeps injected or unverified events %j on the unknown-command path with no write', async evidence => {
    const original = await readFile(slots, 'utf8');
    await handleSlashCommand({ kind: 'text', messageId: 12, ...evidence } as InboundEvent, '/target codex-personal 3', cfg);
    expect(lastReply()?.['text']).toContain('Unknown command <code>/target</code>.');
    expect(await readFile(slots, 'utf8')).toBe(original);
    await expect(readFile(audit, 'utf8')).rejects.toThrow();
  });

  it.each([
    '/target codex-personal',
    '/target codex-personal ',
    '/target codex-personal -1',
    '/target codex-personal 1.5',
    '/target codex-personal +3',
    '/target codex-personal 4e0',
    '/target codex-personal 9007199254740993',
    '/target codex-personal 99999999999999999999',
    '/target codex-personal 3 extra',
    '/target CODEX-PERSONAL 3',
    '/target codex_personal 3',
    '/target 3',
  ])('refuses malformed target command %j with no write', async text => {
    const original = await readFile(slots, 'utf8');
    await handleSlashCommand(verifiedEvent(13), text, cfg);
    expect(lastReply()?.['text']).toContain('Unknown command <code>/target</code>.');
    expect(await readFile(slots, 'utf8')).toBe(original);
    await expect(readFile(audit, 'utf8')).rejects.toThrow();
  });

  it('rejects an unknown lane through the core with no write', async () => {
    const original = await readFile(slots, 'utf8');
    await handleSlashCommand(verifiedEvent(14), '/target ghost-lane 3', cfg);
    expect(lastReply()?.['text']).toBe('Target not set: lane is unavailable.');
    expect(await readFile(slots, 'utf8')).toBe(original);
    await expect(readFile(audit, 'utf8')).rejects.toThrow();
  });

  it('rejects a target above the lane ceiling and never clamps silently', async () => {
    const original = await readFile(slots, 'utf8');
    await handleSlashCommand(verifiedEvent(15), '/target codex-personal 9', cfg);
    expect(lastReply()?.['text']).toBe('Target not set: target is outside the lane bounds.');
    expect((await slotsJson())['codex-personal']!['target']).toBe(4);
    expect(await readFile(slots, 'utf8')).toBe(original);
    await expect(readFile(audit, 'utf8')).rejects.toThrow();
  });

  it('answers with a fixed safe reply and no path or error detail when lane targets are unavailable', async () => {
    await rm(slots);
    await handleSlashCommand(verifiedEvent(16), '/target codex-personal 3', cfg);
    expect(lastReply()?.['text']).toBe('Target not set: lane targets unavailable.');
    expect(lastReply()?.['text']).not.toContain(root);
  });

  it('advertises /target in help', async () => {
    expect(TELEGRAM_HELP_TEXT).toContain('/target <lane> <n>');
    await handleSlashCommand(verifiedEvent(17), '/help', cfg);
    expect(lastReply()?.['text']).toContain('/target &lt;lane&gt; &lt;n&gt;');
  });

  it('verifies transport sender identity end-to-end before any write', async () => {
    const update = (id: number, sender: number, chatId = chat) => ({
      update_id: id,
      message: { message_id: id, chat: { id: chatId, type: 'private' }, from: { id: sender, is_bot: false }, text: '/target codex-personal 5' },
    });
    const original = await readFile(slots, 'utf8');
    updates = [update(1, 9999), update(2, 9999, 9999)];
    await runCommsCycle(cfg, { sendGapMs: 0, sleep: async () => {} });
    expect(await readFile(slots, 'utf8')).toBe(original);
    expect(sent).toEqual([]); // Foreign updates are discarded before any command.

    updates = [update(3, chat)];
    await runCommsCycle(cfg, { sendGapMs: 0, sleep: async () => {} });
    expect((await slotsJson())['codex-personal']).toMatchObject({ target: 5, held: true });
    expect(await readFile(audit, 'utf8')).toContain('\tcodex-personal\t4->5\ttelegram\n');
    expect(lastReply()).toMatchObject({
      chat_id: String(chat),
      text: 'codex-personal target set to 5. Its hold remains active — the target applies when it lifts.',
      reply_parameters: { message_id: 3 },
    });
  });
});
