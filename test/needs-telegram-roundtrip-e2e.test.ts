/**
 * Full loop, real modules: an agent's NEEDS-MASON ask -> Telegram /needs list ->
 * Mason's /resolve reply -> the waiting agent's await returns the answer.
 * Only the Telegram transport and the clocks are injected; no network.
 */
import { afterEach, beforeEach, expect, it } from 'vitest';
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCommsCycle } from '../src/core/comms/dispatch.js';
import { setTelegramSendClockForTests, setTelegramTransportForTests } from '../src/core/integrations/telegram.js';
import { readNeedsMason } from '../src/core/fleet/needs-mason-resolve.js';
import { readNeedsMasonAnswer } from '../src/core/fleet/needs-mason-answer.js';
import { awaitNeedsMasonAnswer } from '../src/core/fleet/needs-mason-answer-await.js';
import type { AshlrConfig } from '../src/core/types.js';

const mason = 1001;
const stranger = 2002;
const cfg = { comms: { enabled: true, channel: 'telegram', telegram: { chatId: String(mason), botToken: '123456:FAKE-token' } } } as AshlrConfig;
const ASK = 'Which fake database should the migration target?';
const ENV_KEYS = ['HOME', 'ASHLR_HOME', 'ASHLR_RUNS_DIR'] as const;

let root: string;
let runsDir: string;
let busRoot: string;
let saved: Record<string, string | undefined>;
let inbound: unknown[];
let outbound: Record<string, unknown>[];
let nextUpdate: number;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'needs-tg-e2e-'));
  runsDir = join(root, 'runs');
  busRoot = join(root, 'home', '.ashlr', 'fleet');
  await mkdir(runsDir, { recursive: true });
  saved = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));
  process.env['HOME'] = join(root, 'home');
  process.env['ASHLR_HOME'] = join(root, 'home', '.ashlr');
  process.env['ASHLR_RUNS_DIR'] = runsDir;
  await mkdir(process.env['ASHLR_HOME'], { recursive: true, mode: 0o700 });
  // Mason's private chat is already paired. Pairing state is read from
  // ~/.ashlr-runs (not ASHLR_RUNS_DIR), so it is written under the temp HOME.
  await mkdir(join(root, 'home', '.ashlr-runs', 'queue'), { recursive: true });
  await writeFile(join(root, 'home', '.ashlr-runs', 'queue', 'telegram-pair.json'), `${JSON.stringify({ v: 1, userId: mason })}\n`);
  inbound = []; outbound = []; nextUpdate = 1;
  let clock = 1_800_000_000_000;
  setTelegramSendClockForTests({ now: () => clock, sleep: async ms => { clock += ms; } });
  setTelegramTransportForTests(async (method, body) => {
    if (method === 'getUpdates') { const result = inbound; inbound = []; return { ok: true, result }; }
    if (method === 'sendMessage') { outbound.push(body); return { ok: true, result: { message_id: 500 + outbound.length } }; }
    return { ok: true, result: true };
  });
});

afterEach(async () => {
  setTelegramTransportForTests(null);
  setTelegramSendClockForTests(null);
  for (const key of ENV_KEYS) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
  await rm(root, { recursive: true, force: true });
});

/** Deliver one Telegram message from `chat` and run a comms cycle over it. */
async function say(chat: number, text: string): Promise<string | undefined> {
  const id = nextUpdate++;
  inbound = [{ update_id: id, message: { message_id: id, chat: { id: chat, type: 'private' }, from: { id: chat, is_bot: false }, text } }];
  const before = outbound.length;
  await runCommsCycle(cfg, { sendGapMs: 0, sleep: async () => {} });
  return outbound.length > before ? String(outbound.at(-1)?.['text']) : undefined;
}

it('carries an agent question to Mason on Telegram and his answer back to the waiting agent', async () => {
  // a. The agent records the ask the way agents do: a line in NEEDS-MASON.md.
  await writeFile(join(runsDir, 'NEEDS-MASON.md'), '# Needs Mason\n');
  await appendFile(join(runsDir, 'NEEDS-MASON.md'), `- [ ] ${ASK}\n`);
  const open = readNeedsMason({ runsDir });
  expect(open.status).toBe('available');
  expect(open.items).toHaveLength(1);
  const id = open.items[0]!.id;
  expect(id).toMatch(/^nm-[0-9a-f]{12}$/);

  // d (start). The agent waits on the same id; nothing is answered yet.
  let release!: () => void;
  let polled!: () => void;
  const firstPoll = new Promise<void>(resolve => { polled = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  let ticks = 0;
  const waiting = awaitNeedsMasonAnswer(id, { timeoutMs: 60_000, pollMs: 1000, root: busRoot }, {
    now: () => ticks * 1000,
    sleep: async () => { ticks++; polled(); await gate; },
  });
  await firstPoll;
  expect(readNeedsMasonAnswer(id, { root: busRoot })).toEqual({ status: 'unknown' });

  // b. Mason's chat lists the ask with its id.
  const listing = await say(mason, '/needs');
  expect(listing).toContain(id);
  expect(listing).toContain(ASK);
  expect(outbound.at(-1)).toMatchObject({ chat_id: String(mason) });

  // f. A chat that is not Mason's is refused and resolves nothing.
  expect(await say(stranger, `/resolve ${id} use fake-mysql`)).toBeUndefined();
  expect(readNeedsMasonAnswer(id, { root: busRoot })).toEqual({ status: 'unknown' });
  expect(readNeedsMason({ runsDir }).items.map(item => item.id)).toEqual([id]);

  // c. Mason answers through the Telegram command.
  expect(await say(mason, `/resolve ${id} use fake-postgres`)).toContain(`Resolved ${id}`);
  release();

  // d. The waiting agent gets his text, attributed to telegram.
  const result = await waiting;
  expect(result).toMatchObject({ status: 'found', answer: { itemId: id, item: ASK, reply: 'use fake-postgres', source: 'telegram' } });
  expect(readNeedsMason({ runsDir }).items).toEqual([]);

  // e. An identical second reply is refused as already resolved and changes nothing.
  const ledger = await readFile(join(runsDir, 'NEEDS-MASON.md'), 'utf8');
  const first = readNeedsMasonAnswer(id, { root: busRoot });
  expect(await say(mason, `/resolve ${id} use fake-postgres`)).toContain('already resolved');
  expect(await readFile(join(runsDir, 'NEEDS-MASON.md'), 'utf8')).toBe(ledger);
  expect(ledger.match(new RegExp(`resolved ${id}`, 'g'))).toHaveLength(1);
  expect(readNeedsMasonAnswer(id, { root: busRoot })).toEqual(first);
});
