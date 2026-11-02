import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { AshlrConfig } from '../src/core/types.js';
import { createFleetRunsApi, type FleetRunsApiDeps } from '../src/core/verse/fleet-runs-api.js';
import { VERSE_FLEET_RUNS_INBOX_PATH as INBOX } from '../src/core/verse/fleet-runs-types.js';
import type { ChannelDedupeStore, ChannelReceipt } from '../src/core/fleet/channel-dedupe-store.js';

const TOKEN = 'durable-dedupe-nov1-token';
const NOW = Date.parse('2026-11-01T00:13:00Z');

const dirs: string[] = [];
function tmp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
beforeEach(() => { vi.stubEnv('ASHLR_RUNS_DIR', tmp('durable-dedupe-env-')); });
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function deps(over: Partial<FleetRunsApiDeps> = {}): FleetRunsApiDeps {
  return {
    now: () => NOW,
    readRunsDir: async () => ({}),
    listWorkers: async () => ({}),
    readInbox: async () => [],
    appendInbox: async () => ({ ok: true, at: 'fake-at', bytes: 1 }),
    codexPersonal: async () => null,
    mergedLastHour: async () => ({ count: 0, items: [] }),
    ...over,
  };
}

interface Reply { status: number; wire: Record<string, unknown> | null }

async function post(api: ReturnType<typeof createFleetRunsApi>, body: unknown): Promise<Reply> {
  const req = Readable.from([JSON.stringify(body ?? {})]) as unknown as IncomingMessage;
  req.url = INBOX;
  req.method = 'POST';
  req.headers = { 'content-type': 'application/json', 'x-ashlr-token': TOKEN };
  let status = 0;
  let wire: Record<string, unknown> | null = null;
  const res = {
    headersSent: false,
    writeHead(code: number) { status = code; this.headersSent = true; },
    end(text: string) { try { wire = JSON.parse(text); } catch { wire = null; } },
  } as unknown as ServerResponse;
  const ctx = { cfg: {} as AshlrConfig, token: TOKEN, allowDispatch: true } as VerseApiContext;
  await api(ctx, req, res, INBOX, 'POST');
  return { status, wire };
}

describe('hub inbox durable dedupe (RQ-PHX-HUBINBOXDURABLEDEDUPE31)', () => {
  it('dedupes the same text across two API instances sharing one runsDir', async () => {
    const runsDir = tmp('durable-dedupe-runs-');
    const appendInbox = vi.fn(async () => ({ ok: true, at: 'fake-at', bytes: 1 }));
    const first = createFleetRunsApi(deps({ appendInbox, runsDir }));
    const firstReply = await post(first, { text: 'hold the merge queue' });
    expect(firstReply.status).toBe(201);
    expect(firstReply.wire).toMatchObject({ ok: true, accepted: true, duplicate: false });
    expect(firstReply.wire?.dedupeKey).toMatch(/^sha256:[a-f0-9]{24}$/);

    // A second instance is a Hub restart: no shared memory, only the runsDir.
    const second = createFleetRunsApi(deps({ appendInbox, runsDir }));
    const retry = await post(second, { text: 'hold the merge queue' });
    expect(retry.status).toBe(200);
    expect(retry.wire).toMatchObject({ ok: true, accepted: false, duplicate: true });
    expect(retry.wire?.dedupeKey).toBe(firstReply.wire?.dedupeKey);
    expect(appendInbox).toHaveBeenCalledTimes(1);
    expect(appendInbox).toHaveBeenCalledWith('hold the merge queue', 'Phantom desktop');
    expect(existsSync(join(runsDir, 'channel-receipts', 'receipts.json'))).toBe(true);
  });

  it('appends a different text on the second instance', async () => {
    const runsDir = tmp('durable-dedupe-runs-');
    const appendInbox = vi.fn(async () => ({ ok: true, at: 'fake-at', bytes: 1 }));
    await post(createFleetRunsApi(deps({ appendInbox, runsDir })), { text: 'first order' });
    const second = await post(createFleetRunsApi(deps({ appendInbox, runsDir })), { text: 'second order' });
    expect(second.status).toBe(201);
    expect(second.wire).toMatchObject({ accepted: true, duplicate: false });
    expect(appendInbox).toHaveBeenCalledTimes(2);
    expect(appendInbox).toHaveBeenLastCalledWith('second order', 'Phantom desktop');
  });

  it('answers 503 INBOX_RECEIPTS_UNREADABLE on corrupt receipts and never writes', async () => {
    const runsDir = tmp('durable-dedupe-runs-');
    const appendInbox = vi.fn(async () => ({ ok: true, at: 'fake-at', bytes: 1 }));
    await post(createFleetRunsApi(deps({ appendInbox, runsDir })), { text: 'seed a receipt file' });
    writeFileSync(join(runsDir, 'channel-receipts', 'receipts.json'), 'not json');
    appendInbox.mockClear();
    const reply = await post(createFleetRunsApi(deps({ appendInbox, runsDir })), { text: 'anything new' });
    expect(reply.status).toBe(503);
    expect(reply.wire?.code).toBe('INBOX_RECEIPTS_UNREADABLE');
    expect(appendInbox).not.toHaveBeenCalled();
  });

  it('uses an injected receiptStore instead of the local one', async () => {
    const runsDir = tmp('durable-dedupe-runs-');
    const calls: string[] = [];
    const receipts = new Map<string, ChannelReceipt>();
    const stub: ChannelDedupeStore = {
      transaction: (work) => work(new Proxy(receipts, {
        get(target, prop) {
          const value = Reflect.get(target, prop) as unknown;
          if (prop === 'get') calls.push('has');
          if (prop === 'set') calls.push('record');
          return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
        },
      }), () => { calls.push('commit'); }),
    };
    const appendInbox = vi.fn(async () => ({ ok: true, at: 'fake-at', bytes: 1 }));
    const first = createFleetRunsApi(deps({ appendInbox, runsDir, receiptStore: stub }));
    expect((await post(first, { text: 'stubbed store' })).status).toBe(201);
    const second = createFleetRunsApi(deps({ appendInbox, runsDir, receiptStore: stub }));
    const retry = await post(second, { text: 'stubbed store' });
    expect(retry.status).toBe(200);
    expect(retry.wire?.duplicate).toBe(true);
    expect(appendInbox).toHaveBeenCalledTimes(1);
    expect(calls).toContain('has');
    expect(calls).toContain('record');
    // The injected store replaced the local one: no receipt file was created.
    expect(existsSync(join(runsDir, 'channel-receipts', 'receipts.json'))).toBe(false);
  });
});
