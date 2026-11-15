/**
 * Preservation of original PR #4303's test/verse-owner-thread-route.test.ts
 * (owner-thread route regression suite; added in ce6ab907ada70b6571a618c22a79905a0ace97ce,
 * PR head 5b6ae761369b8efa6bdfe57a11cdb6df537f2a9f) through TODAY's real API:
 *
 *   - module level: createOwnerThreadApi({ runsDir, settings, now }) is the
 *     current factory the original's handleOwnerThreadApi(req, res, path,
 *     method, deps) became; VERSE_OWNER_THREAD_PATH is the renamed
 *     OWNER_THREAD_PATH (same value).
 *   - router level: handleVerseApi → dispatchWorkbenchModules → workbench
 *     family 'owner-thread' → the mounted handleOwnerThreadApi singleton.
 *     Its fixed owner dirs follow the relocated HOME (the repo's own test
 *     isolation), so the real loadOwnerThreadSettings config read and the
 *     real persisted thread file are exercised end to end.
 *
 * Original scenarios kept: ordered real persisted inbound messages, the
 * newest-message limit, invalid-limit 400s, read-only 405 with unchanged
 * bytes, corrupt-state 200-unavailable, Leader-pane consumer parsing, and
 * unknown-child 404 through the dispatcher. Newer access restrictions added
 * since the original (ctx.allowDispatch 404 on reads, the mutation gate on
 * writes, secret-handle-free adapter projection) are asserted, not weakened.
 * No function under test is mocked; no transport is built or called.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  fixedOwnerConfigDir,
  fixedOwnerRunsDir,
  loadOwnerThreadSettings,
  type OwnerThreadSettings,
} from '../src/core/comms/owner-channel.js';
import { acceptOwnerInbound, type OwnerThreadOptions } from '../src/core/comms/owner-thread.js';
import {
  createOwnerThreadApi,
  handleOwnerThreadApi,
  VERSE_OWNER_THREAD_PATH as PATH,
} from '../src/core/verse/owner-thread-api.js';
import { handleVerseApi, workbenchApiModules, type VerseApiContext } from '../src/core/verse/verse-api.js';
import { workbenchFamilyFor } from '../src/core/verse/workbench-types.js';
import type { AshlrConfig } from '../src/core/types.js';
import { parseOwnerThreadRead } from '../src/web-ui/routes/verse/leader-thread/owner-thread-queries.js';

const NOW = 1_700_000_000_000;
const TOKEN = 'x'.repeat(64);
const MUTATE = { 'x-ashlr-token': TOKEN, 'content-type': 'application/json' };

/** The original fixture verbatim: plainly fake identities, one named secret handle. */
const settings: OwnerThreadSettings = {
  owners: { telegram: 'owner-test-1', desktop: 'local-owner' },
  secretHandles: { telegram: 'phm_TELEGRAM_BOT_TOKEN' },
  imessageBridge: 'off',
  confirmed: true,
  team: [{ channel: 'bus', id: 'local-owner' }, { channel: 'telegram', id: 'owner-test-1' }],
};
const mailbox = { async accept() { return { status: 'accepted' as const, requestId: 'req-test-1' }; } };

let home: string;
let prevHome: string | undefined;
let runsDir: string;
let file: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'owner-thread-route-248s-'));
  prevHome = process.env.HOME;
  process.env.HOME = home;
  // Module-level runs root, injected explicitly like the original deps arg.
  runsDir = join(home, 'runs');
  file = join(runsDir, 'leader', 'owner-thread.json');
});
afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  rmSync(home, { recursive: true, force: true });
});

function fakeReq(method: string, url: string, headers: Record<string, string> = {}): IncomingMessage {
  const req = new PassThrough();
  req.end();
  return Object.assign(req, { url, method, headers: { host: '127.0.0.1:9', ...headers } }) as unknown as IncomingMessage;
}

function fakeRes() {
  const state = { status: 0, body: '', headersSent: false, writableEnded: false };
  const res = {
    get headersSent() { return state.headersSent; },
    get writableEnded() { return state.writableEnded; },
    writeHead(code: number) { state.status = code; state.headersSent = true; return this; },
    setHeader() { return this; },
    write() { return true; },
    end(body?: unknown) { state.body = typeof body === 'string' ? body : ''; state.writableEnded = true; return this; },
    on() { return this; },
    once() { return this; },
  };
  return { res: res as unknown as ServerResponse, state };
}

const ctx = (allowDispatch: boolean): VerseApiContext =>
  ({ cfg: {} as AshlrConfig, token: TOKEN, allowDispatch });

interface CallResult {
  handled: boolean;
  status: number;
  text: string;
  body: Record<string, any> | null;
}

function parse(state: { status: number; body: string }, handled: boolean): CallResult {
  return { handled, status: state.status, text: state.body, body: state.body ? JSON.parse(state.body) : null };
}

/** The original's direct-handler call, on the current factory signature. */
async function callApi(method: string, query = '', allowDispatch = true): Promise<CallResult> {
  const api = createOwnerThreadApi({ runsDir, settings, now: () => NOW });
  const { res, state } = fakeRes();
  const handled = await api(ctx(allowDispatch), fakeReq(method, PATH + query), res, PATH, method);
  return parse(state, handled);
}

/** The current server entry point, exactly as handleApi calls it. */
async function callRoute(method: string, url: string, opts: { allowDispatch?: boolean; headers?: Record<string, string> } = {}): Promise<CallResult> {
  const path = url.split('?')[0]!;
  const { res, state } = fakeRes();
  const handled = await handleVerseApi(ctx(opts.allowDispatch ?? true), fakeReq(method, url, opts.headers), res, path, method);
  return parse(state, handled);
}

/** The original beforeEach: two real persisted inbound owner messages. */
async function seedModuleThread(): Promise<void> {
  const options: OwnerThreadOptions = {
    runsDir, busRoot: join(runsDir, 'bus'), now: () => NOW,
    settings, halted: false, paused: false, mailbox,
  };
  const first = await acceptOwnerInbound(
    { channel: 'telegram', senderId: 'owner-test-1', text: 'first fake line', idempotencyKey: 'telegram-test-0001', at: NOW }, options);
  const second = await acceptOwnerInbound(
    { channel: 'telegram', senderId: 'owner-test-1', text: 'second fake line', idempotencyKey: 'telegram-test-0002', at: NOW + 1_000 }, options);
  expect(first.status).toBe('accepted');
  expect(second.status).toBe('accepted');
}

describe('GET /api/verse/comms/owner-thread — original route contract on the current factory', () => {
  beforeEach(seedModuleThread);

  it('returns the schema, messages in seq order and adapter status', async () => {
    const r = await callApi('GET');
    expect(r.handled).toBe(true);
    expect(r.status).toBe(200);
    expect(r.body!.schema).toBe('comms.owner-thread.v1');
    expect(r.body!.threadId).toBe('owner');
    expect(r.body!.messages.map((m: { seq: number }) => m.seq)).toEqual([1, 2]);
    expect(r.body!.status.kill).toBe(false);
    expect(r.body!.status.paused).toBe(false);
    expect(Array.isArray(r.body!.status.adapters)).toBe(true);
  });

  it('limit=1 returns only the newest message', async () => {
    const r = await callApi('GET', '?limit=1');
    expect(r.body!.messages.map((m: { seq: number }) => m.seq)).toEqual([2]);
  });

  it.each(['0', '201', 'abc', '-1', '1.5'])('rejects limit=%s with 400', async limit => {
    expect((await callApi('GET', `?limit=${limit}`)).status).toBe(400);
  });

  it('answers POST with 405 and leaves the thread bytes unchanged', async () => {
    const before = readFileSync(file);
    const r = await callApi('POST');
    expect(r.status).toBe(405);
    expect(readFileSync(file).equals(before)).toBe(true);
  });

  it('serves a corrupt thread as 200 unavailable with no messages', async () => {
    writeFileSync(file, '{not json');
    const r = await callApi('GET');
    expect(r.status).toBe(200);
    expect(r.body!.unavailable).toBe(true);
    expect(r.body!.messages).toEqual([]);
  });

  it('is parsed by the Leader pane reader', async () => {
    const read = parseOwnerThreadRead((await callApi('GET')).body);
    expect(read.lines).toHaveLength(2);
    expect(read.paused).toBe(false);
  });

  it('answers 404 without a dispatch session — the newer read gate', async () => {
    const r = await callApi('GET', '', false);
    expect(r.status).toBe(404);
    expect(r.text).not.toContain('first fake line');
    // The method gate still precedes the dispatch gate: 405, not 404.
    expect((await callApi('POST', '', false)).status).toBe(405);
  });
});

describe('GET /api/verse/comms/owner-thread through handleVerseApi', () => {
  beforeEach(() => {
    // The mounted singleton loads settings from the fixed owner config dir;
    // write the real TOML files it parses, all synthetic.
    const configDir = fixedOwnerConfigDir();
    mkdirSync(join(configDir, 'comms'), { recursive: true, mode: 0o700 });
    const identities = '{ channel = "bus", id = "fake-owner-desk" }, { channel = "telegram", id = "fake-owner-tg" }';
    writeFileSync(join(configDir, 'agent-network.toml'),
      `[mason]\nidentities = [${identities}]\n[team]\nidentities = [${identities}]\n`, { mode: 0o600 });
    writeFileSync(join(configDir, 'comms.toml'), 'confirmedByMason = true\n', { mode: 0o600 });
    writeFileSync(join(configDir, 'comms', 'owner-adapters.toml'),
      '[telegram]\nsecretHandle = "phm_TELEGRAM_BOT_TOKEN"\n', { mode: 0o600 });
  });

  async function seedRoutedThread(): Promise<void> {
    const options: OwnerThreadOptions = {
      runsDir: fixedOwnerRunsDir(),
      busRoot: join(fixedOwnerRunsDir(), 'bus'),
      now: () => NOW,
      settings: loadOwnerThreadSettings(fixedOwnerConfigDir()),
      halted: false, paused: false, mailbox,
    };
    for (const [index, text] of ['first fake line', 'second fake line'].entries()) {
      const result = await acceptOwnerInbound(
        { channel: 'telegram', senderId: 'fake-owner-tg', text, idempotencyKey: `telegram-route-${String(index + 1).padStart(4, '0')}`, at: NOW + index * 1_000 }, options);
      expect(result.status).toBe('accepted');
    }
  }

  it('is claimed by exactly one workbench family resolving to the real mounted handler', async () => {
    expect(workbenchFamilyFor(PATH)?.id).toBe('owner-thread');
    expect(workbenchFamilyFor(`${PATH}/x`)?.id).toBe('owner-thread');
    expect(workbenchFamilyFor(`${PATH}X`)).toBeNull();
    const mounts = workbenchApiModules().filter(module => module.id === 'owner-thread');
    expect(mounts).toHaveLength(1);
    expect(await mounts[0]!.load()).toBe(handleOwnerThreadApi);
  });

  it('serves the persisted thread end to end through the router', async () => {
    await seedRoutedThread();
    const r = await callRoute('GET', PATH);
    expect(r.handled).toBe(true);
    expect(r.status).toBe(200);
    expect(r.body!.schema).toBe('comms.owner-thread.v1');
    expect(r.body!.messages.map((m: { seq: number }) => m.seq)).toEqual([1, 2]);
    expect(r.body!.messages.map((m: { text: string }) => m.text)).toEqual(['first fake line', 'second fake line']);
    const read = parseOwnerThreadRead(r.body);
    expect(read.lines).toHaveLength(2);
    expect(read.paused).toBe(false);
  });

  it('404s unknown children through handleVerseApi', async () => {
    const r = await callRoute('GET', `${PATH}/x`);
    expect(r.handled).toBe(true);
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ error: `not found: GET ${PATH}/x` });
  });

  it('keeps the newer access boundary through the router', async () => {
    await seedRoutedThread();
    // GET is a read but still owner-private: no dispatch session, no bodies.
    const denied = await callRoute('GET', PATH, { allowDispatch: false });
    expect(denied.status).toBe(404);
    expect(denied.text).not.toContain('first fake line');
    // Non-GET dies at the family gate before any module loads.
    const off = await callRoute('POST', PATH, { allowDispatch: false, headers: MUTATE });
    expect(off.status).toBe(404);
    expect(off.body).toMatchObject({ error: `not found: POST ${PATH}` });
    // Past the gate but without the mutation token: 401, still not 405.
    expect((await callRoute('POST', PATH)).status).toBe(401);
    // With dispatch + a valid mutation credential the module's own read-only
    // answer stands: 405.
    const post = await callRoute('POST', PATH, { headers: MUTATE });
    expect(post.status).toBe(405);
    expect(post.body).toEqual({ error: 'The owner thread is read only here.' });
  });
});
