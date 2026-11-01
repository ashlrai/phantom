import { afterEach, beforeEach, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { handleSlashCommand } from './telegram-channel.js';
import { runCommsCycle } from './dispatch.js';
import { setTelegramSendClockForTests, setTelegramTransportForTests } from '../integrations/telegram.js';
import type { AshlrConfig } from '../types.js';

const chat = 4242;
const cfg = { comms: { enabled: true, channel: 'telegram', telegram: { chatId: String(chat), botToken: '123456:FAKE' } } } as AshlrConfig;
let root: string;
let slots: string;
let previousHome: string | undefined;
let previousRuns: string | undefined;
let updates: unknown[];
let sent: Record<string, unknown>[];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'telegram-release-'));
  previousHome = process.env['HOME'];
  previousRuns = process.env['ASHLR_RUNS_DIR'];
  process.env['HOME'] = root;
  process.env['ASHLR_RUNS_DIR'] = root;
  await mkdir(join(root, 'queue'));
  slots = join(root, 'queue', 'slots.json');
  await writeFile(slots, JSON.stringify({ 'codex-personal': { target: 4, floor: 0, ceiling: 8, held: true, held_reason: 'autobackoff usage limit', held_by: 'autobackoff', held_until: '2026-11-01T00:00:00Z', last_change: 1793448000 } }));
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

it('keeps injected unverified events on the existing unknown-command path', async () => {
  const original = await readFile(slots, 'utf8');
  for (const evidence of [
    { fromChatId: '9999', senderUserId: 9999, privateChat: true },
    { fromChatId: String(chat), senderUserId: 9999, privateChat: true },
    { fromChatId: String(chat), senderUserId: chat, privateChat: false },
    { fromChatId: String(chat) },
  ]) {
    await handleSlashCommand({ kind: 'text', ...evidence }, '/release codex-personal', cfg);
    expect(sent.at(-1)?.['text']).toContain('Unknown command <code>/release</code>.');
  }
  expect(await readFile(slots, 'utf8')).toBe(original);
});

it('uses transport sender verification and replies in the verified chat, including a repeated release', async () => {
  const update = (id: number, sender: number, chatId = chat) => ({ update_id: id, message: { message_id: id, chat: { id: chatId, type: 'private' }, from: { id: sender, is_bot: false }, text: '/release codex-personal' } });
  const original = await readFile(slots, 'utf8');
  updates = [update(1, 9999), update(2, 9999, 9999)];
  await runCommsCycle(cfg, { sendGapMs: 0, sleep: async () => {} });
  expect(await readFile(slots, 'utf8')).toBe(original);
  expect(sent).toEqual([]); // Foreign updates are discarded before any command, including unknown commands.

  updates = [update(3, chat)];
  await runCommsCycle(cfg, { sendGapMs: 0, sleep: async () => {} });
  expect(JSON.parse(await readFile(slots, 'utf8'))['codex-personal']).toMatchObject({ held: false, target: 4 });
  expect(sent.at(-1)).toMatchObject({ chat_id: String(chat), text: 'codex-personal released. Target 4.', reply_parameters: { message_id: 3 } });
  expect(await readFile(slots, 'utf8')).toContain('(telegram)');

  updates = [update(4, chat)];
  await runCommsCycle(cfg, { sendGapMs: 0, sleep: async () => {} });
  expect(sent.at(-1)).toMatchObject({ chat_id: String(chat), text: 'codex-personal is not held.', reply_parameters: { message_id: 4 } });
});
