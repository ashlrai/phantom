/**
 * Preservation evidence for PR #4372 (RQ-PHX-OWNERTHREADSERVE16): the unified
 * owner-thread read contract through the real local API handler. Synthetic
 * channel identities, synthetic messages, isolated temp runs/config/bus tree.
 * Proves the original read path still answers one ordered private thread to
 * the desktop parser, with the newer /status brief and inbox mirror kept
 * intact. No readOwnerThread/readOwnerCommsStatus mocks, no transports.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { liveOwnerTransports } from '../src/core/comms/owner-live-transport.js';
import type { OwnerChannel } from '../src/core/comms/leader-mailbox.js';
import { loadOwnerThreadSettings } from '../src/core/comms/owner-channel.js';
import { acceptOwnerInbound, type OwnerThreadOptions } from '../src/core/comms/owner-thread.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import {
  createOwnerThreadApi,
  VERSE_OWNER_STATUS_PATH,
  VERSE_OWNER_THREAD_PATH as PATH,
  type OwnerThreadApiDeps,
} from '../src/core/verse/owner-thread-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { parseOwnerThreadRead } from '../src/web-ui/routes/verse/leader-thread/owner-thread-queries.js';

const transport = vi.hoisted(() => ({ pull: vi.fn(), deliver: vi.fn() }));
vi.mock('../src/core/comms/owner-live-transport.js', () => ({
  liveOwnerTransports: vi.fn(() => ({ telegram: transport, email: transport, slack: transport, imessage: transport })),
}));

const NOW = 1_700_000_000_000;
/** Plainly fake owner identities; `bus` is the desktop channel's bus spelling. */
const OWNERS = [
  { channel: 'bus', id: 'fake-owner-desk', owner: 'desktop' },
  { channel: 'telegram', id: 'fake-owner-tg', owner: 'telegram' },
  { channel: 'email', id: 'fake-owner-mail', owner: 'email' },
  { channel: 'slack', id: 'fake-owner-slack', owner: 'slack' },
  { channel: 'imessage', id: 'fake-owner-imsg', owner: 'imessage' },
] as const;
const OWNER_ID = Object.fromEntries(OWNERS.map(row => [row.owner, row.id])) as Record<(typeof OWNERS)[number]['owner'], string>;

let runsDir: string;
let configDir: string;
beforeEach(() => {
  runsDir = mkdtempSync(join(tmpdir(), 'owner-thread-preserve-runs-'));
  configDir = mkdtempSync(join(tmpdir(), 'owner-thread-preserve-cfg-'));
  // The real config load path: mason/team identities, comms confirmation and
  // adapter secret-handle names, all synthetic.
  mkdirSync(join(configDir, 'comms'), { recursive: true, mode: 0o700 });
  const identities = OWNERS.map(row => `{ channel = "${row.channel}", id = "${row.id}" }`).join(', ');
  writeFileSync(join(configDir, 'agent-network.toml'),
    `[mason]\nidentities = [${identities}]\n[team]\nidentities = [${identities}]\n`, { mode: 0o600 });
  writeFileSync(join(configDir, 'comms.toml'), 'confirmedByMason = true\n', { mode: 0o600 });
  writeFileSync(join(configDir, 'comms', 'owner-adapters.toml'),
    '[telegram]\nsecretHandle = "phm_TELEGRAM_BOT_TOKEN"\n[email]\nsecretHandle = "phm_EMAIL_CREDENTIAL"\n' +
    '[slack]\nsecretHandle = "phm_SLACK_BOT_TOKEN"\n[imessage]\nbridge = "loopback"\n', { mode: 0o600 });
});
afterEach(() => {
  rmSync(runsDir, { recursive: true, force: true });
  rmSync(configDir, { recursive: true, force: true });
});

function apiFor(extra: Partial<OwnerThreadApiDeps> = {}): ApiModule {
  return createOwnerThreadApi({ runsDir, configDir, now: () => NOW, ...extra });
}

interface CallResult {
  handled: boolean;
  status: number;
  text: string;
  body: Record<string, any> | null;
}

async function call(api: ApiModule, path: string, query = '', method = 'GET', allowDispatch = true): Promise<CallResult> {
  const url = path + query;
  let status = 0;
  let text = '';
  const req = Object.assign(new PassThrough(), { url, method }) as IncomingMessage;
  const res = {
    headersSent: false,
    writeHead(code: number) { status = code; this.headersSent = true; return this; },
    end(body?: string) { text = body ?? ''; },
  } as unknown as ServerResponse;
  const handled = await api({ cfg: {}, allowDispatch } as VerseApiContext, req, res, path, method);
  return { handled, status, text, body: text ? JSON.parse(text) : null };
}

function recordingMailbox() {
  return { accept: vi.fn(async () => ({ status: 'accepted' as const, requestId: 'req-fake-0001' })) };
}

function seedOptions(): OwnerThreadOptions {
  return {
    runsDir,
    busRoot: join(runsDir, 'bus'),
    now: () => NOW,
    settings: loadOwnerThreadSettings(configDir),
    mailbox: recordingMailbox(),
    halted: false,
    paused: false,
  };
}

async function seedInbound(entries: ReadonlyArray<{ channel: OwnerChannel; text: string; key: string }>): Promise<void> {
  const options = seedOptions();
  for (const [index, entry] of entries.entries()) {
    const result = await acceptOwnerInbound({
      channel: entry.channel,
      senderId: OWNER_ID[entry.channel],
      text: entry.text,
      idempotencyKey: entry.key,
      at: NOW + index + 1,
    }, options);
    expect(result.status).toBe('accepted');
  }
}

/** sha256 of every regular file under root, keyed by relative path. */
function treeHashes(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!existsSync(root)) return out;
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else out[relative(root, path)] = createHash('sha256').update(readFileSync(path)).digest('hex');
    }
  };
  walk(root);
  return out;
}

describe('GET /api/verse/comms/owner-thread — PR #4372 read contract', () => {
  it('serves one ordered thread across every configured channel', async () => {
    const api = apiFor({ mailbox: recordingMailbox() });
    await seedInbound([
      { channel: 'telegram', text: 'fake line telegram one', key: 'seed-tg-0001' },
      { channel: 'desktop', text: 'fake line desktop one', key: 'seed-desk-0001' },
      { channel: 'email', text: 'fake line email one', key: 'seed-mail-0001' },
      { channel: 'slack', text: 'fake line slack one', key: 'seed-slack-0001' },
      { channel: 'imessage', text: 'fake line imessage one', key: 'seed-imsg-0001' },
    ]);
    const r = await call(api, PATH);
    expect(r.handled).toBe(true);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ schema: 'comms.owner-thread.v1', threadId: 'owner' });
    expect(r.body!.messages.map((m: { seq: number }) => m.seq)).toEqual([1, 2, 3, 4, 5]);
    expect(r.body!.messages.map((m: { channel: string }) => m.channel))
      .toEqual(['telegram', 'desktop', 'email', 'slack', 'imessage']);
    expect(r.body!.messages.map((m: { text: string }) => m.text))
      .toEqual(['fake line telegram one', 'fake line desktop one', 'fake line email one', 'fake line slack one', 'fake line imessage one']);
    expect(r.body!.messages.map((m: { senderId: string }) => m.senderId))
      .toEqual([OWNER_ID.telegram, OWNER_ID.desktop, OWNER_ID.email, OWNER_ID.slack, OWNER_ID.imessage]);
    expect(r.body!.messages.every((m: { direction: string }) => m.direction === 'inbound')).toBe(true);
    // The desktop parser reads the same body as ordered lines plus channel state.
    const read = parseOwnerThreadRead(r.body);
    expect(read.lines.map(line => line.text)).toEqual([
      'fake line telegram one', 'fake line desktop one', 'fake line email one',
      'fake line slack one', 'fake line imessage one',
    ]);
    expect(read.lines[0]).toMatchObject({ channel: 'telegram', direction: 'inbound', senderId: OWNER_ID.telegram });
    expect(read.channels).toHaveLength(5);
    expect(read.paused).toBe(false);
  });

  it('defaults to the newest 100 messages and honors bounded limits', async () => {
    // 105 ordered synthetic inbound rows, written in the exact on-disk shape
    // acceptOwnerInbound produces (readState validates every row on read).
    const dir = join(runsDir, 'leader');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const messages = Array.from({ length: 105 }, (_, i) => ({
      seq: i + 1,
      id: `m${i + 1}`,
      idempotencyKey: `bulk-tg-${String(i + 1).padStart(5, '0')}`,
      channel: 'telegram',
      senderId: OWNER_ID.telegram,
      direction: 'inbound',
      at: new Date(NOW + i).toISOString(),
      text: `bulk fake line ${i + 1}`,
    }));
    writeFileSync(join(dir, 'owner-thread.json'),
      JSON.stringify({ v: 1, threadId: 'owner', messages, deliveries: {} }), { mode: 0o600 });
    const api = apiFor();
    const all = await call(api, PATH);
    expect(all.status).toBe(200);
    expect(all.body!.messages).toHaveLength(100);
    expect(all.body!.messages[0].seq).toBe(6);
    expect(all.body!.messages[99].seq).toBe(105);
    const max = await call(api, PATH, '?limit=200');
    expect(max.status).toBe(200);
    expect(max.body!.messages).toHaveLength(105);
    const few = await call(api, PATH, '?limit=3');
    expect(few.body!.messages.map((m: { seq: number }) => m.seq)).toEqual([103, 104, 105]);
  });

  it('rejects malformed limit values with 400 before any read', async () => {
    const api = apiFor();
    for (const bad of ['0', '201', '-1', '1.5', 'abc', '', '1e2', '9999', ' 5', '+5', '0x10']) {
      const r = await call(api, PATH, `?limit=${bad}`);
      expect(r.status, `limit=${JSON.stringify(bad)}`).toBe(400);
      expect(r.body).toEqual({ error: 'limit must be an integer from 1 to 200.' });
    }
    expect((await call(api, PATH, '?limit=1')).status).toBe(200);
    expect((await call(api, PATH, '?limit=200')).status).toBe(200);
  });

  it('projects adapter status without exposing secret handles', async () => {
    await seedInbound([{ channel: 'telegram', text: 'fake line for status', key: 'seed-status-01' }]);
    const api = apiFor({ mailbox: recordingMailbox() });
    const r = await call(api, PATH);
    expect(r.status).toBe(200);
    expect(r.body!.status).toMatchObject({ kill: false, paused: false });
    const adapters = r.body!.status.adapters as Array<Record<string, unknown>>;
    expect(adapters.map(a => a.id)).toEqual(['desktop', 'telegram', 'email', 'imessage', 'slack']);
    for (const adapter of adapters) {
      expect(Object.keys(adapter).sort()).toEqual(['configured', 'enabled', 'halted', 'id', 'nextStep', 'reason']);
      expect(adapter).toMatchObject({ configured: true, enabled: true, halted: false });
    }
    expect(r.text).not.toContain('secretHandle');
    expect(r.text).not.toContain('phm_');
  });

  it('fails closed on adapter status when no owner config exists', async () => {
    const emptyCfg = mkdtempSync(join(tmpdir(), 'owner-thread-empty-cfg-'));
    try {
      const api = createOwnerThreadApi({ runsDir, configDir: emptyCfg, now: () => NOW });
      const r = await call(api, PATH);
      expect(r.status).toBe(200);
      expect(r.body!.messages).toEqual([]);
      const adapters = r.body!.status.adapters as Array<Record<string, unknown>>;
      expect(adapters).toHaveLength(5);
      for (const adapter of adapters) {
        expect(adapter.configured).toBe(false);
        expect(adapter.enabled).toBe(false);
      }
    } finally {
      rmSync(emptyCfg, { recursive: true, force: true });
    }
  });

  it('answers the unavailable contract with 200 when thread state is unreadable', async () => {
    const api = apiFor();
    // Missing state file: a valid empty thread, not an unavailable one.
    const empty = await call(api, PATH);
    expect(empty.status).toBe(200);
    expect(empty.body).toMatchObject({ schema: 'comms.owner-thread.v1', threadId: 'owner', messages: [] });
    expect(empty.body!.unavailable).toBeUndefined();
    // Corrupt state: the current supported contract is still HTTP 200 with
    // schema comms.owner-thread.v1, empty messages and unavailable: true.
    const dir = join(runsDir, 'leader');
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(join(dir, 'owner-thread.json'), '{ this is not json', { mode: 0o600 });
    const r = await call(api, PATH);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ schema: 'comms.owner-thread.v1', threadId: 'owner', messages: [], unavailable: true });
    expect(r.body!.status).toMatchObject({ kill: false, paused: false });
    expect((r.body!.status.adapters as unknown[])).toHaveLength(5);
  });

  it('denies callers without a dispatch session and leaks no bodies', async () => {
    await seedInbound([
      { channel: 'telegram', text: 'fake leakcheck line one', key: 'seed-leak-0001' },
      { channel: 'desktop', text: 'fake leakcheck line two', key: 'seed-leak-0002' },
    ]);
    const api = apiFor({ mailbox: recordingMailbox() });
    const r = await call(api, PATH, '', 'GET', false);
    expect(r.handled).toBe(true);
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: 'not found' });
    expect(r.text).not.toContain('fake leakcheck');
    expect(r.text).not.toContain('fake-owner');
    // The method gate still precedes the dispatch gate: 405, not 404.
    expect((await call(api, PATH, '', 'POST', false)).status).toBe(405);
  });

  it('answers non-GET with 405 and ignores unrelated paths', async () => {
    const api = apiFor();
    for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
      const r = await call(api, PATH, '', method);
      expect(r.status, method).toBe(405);
      expect(r.body).toEqual({ error: 'The owner thread is read only here.' });
    }
    const res = { writeHead() { return this; }, end() {} } as unknown as ServerResponse;
    const ctx = { cfg: {}, allowDispatch: true } as VerseApiContext;
    for (const path of ['/api/verse/other', '/api/verse/comms/owner-thread/extra', '/api/verse/comms']) {
      const req = { url: path } as IncomingMessage;
      expect(await api(ctx, req, res, path, 'GET'), path).toBe(false);
    }
  });

  it('leaves thread files untouched and never builds or calls a transport', async () => {
    await seedInbound([
      { channel: 'telegram', text: 'fake line stable one', key: 'seed-stable-01' },
      { channel: 'desktop', text: 'fake line stable two', key: 'seed-stable-02' },
      { channel: 'email', text: 'fake line stable three', key: 'seed-stable-03' },
    ]);
    const mailbox = recordingMailbox();
    const api = apiFor({ mailbox, statusBrief: async () => 'fake brief' });
    const before = treeHashes(runsDir);
    expect(before['leader/owner-thread.json']).toBeTruthy();
    await call(api, PATH);
    await call(api, PATH, '?limit=2');
    await call(api, PATH, '?limit=bad');
    await call(api, VERSE_OWNER_STATUS_PATH);
    expect(treeHashes(runsDir)).toEqual(before);
    expect(mailbox.accept).not.toHaveBeenCalled();
    expect(liveOwnerTransports).not.toHaveBeenCalled();
    expect(transport.pull).not.toHaveBeenCalled();
    expect(transport.deliver).not.toHaveBeenCalled();
  });

  it('keeps the newer owner-status brief endpoint behind the same gate', async () => {
    const brief = vi.fn(async () => 'fake leader brief');
    const api = apiFor({ statusBrief: brief });
    const r = await call(api, VERSE_OWNER_STATUS_PATH);
    expect(r.handled).toBe(true);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ schema: 'comms.owner-status.v1', text: 'fake leader brief', at: new Date(NOW).toISOString() });
    expect(brief).toHaveBeenCalledTimes(1);
    // Same dispatch gate as the thread read: 404 without it, brief not invoked.
    const denied = await call(api, VERSE_OWNER_STATUS_PATH, '', 'GET', false);
    expect(denied.status).toBe(404);
    expect(brief).toHaveBeenCalledTimes(1);
    // The status path ignores the thread limit parameter entirely.
    expect((await call(api, VERSE_OWNER_STATUS_PATH, '?limit=abc')).status).toBe(200);
    expect(brief).toHaveBeenCalledTimes(2);
    expect((await call(api, VERSE_OWNER_STATUS_PATH, '', 'POST')).status).toBe(405);
    // A failing brief composer is a 200 unavailable body, not an error status.
    const failing = apiFor({ statusBrief: async () => { throw new Error('fake brief failure'); } });
    const u = await call(failing, VERSE_OWNER_STATUS_PATH);
    expect(u.status).toBe(200);
    expect(u.body).toEqual({ schema: 'comms.owner-status.v1', unavailable: true });
  });
});
