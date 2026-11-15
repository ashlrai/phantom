/** GET /api/verse/comms/owner-thread `receipts`: the API surface the Leader pane
 * reads. Sends go through the real guarded sendOwnerReply; the answer goes
 * through the real parseOwnerThreadRead the desktop uses. Synthetic ids, temp
 * dirs, fake transports.
 *
 * RQ-PHX-RECUTCOMMSC206 recut of PR #5197 (RECUTDESKS0C186): the receipt store
 * itself already landed on master as src/core/leader/delivery-receipts.ts, so
 * this file keeps only the API-surface coverage that master still lacks — a
 * channel message in, a guarded reply out, receipts read back through the real
 * route and the real desktop parser. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { loadOwnerThreadSettings, type OwnerChannelTransport } from '../src/core/comms/owner-channel.js';
import { acceptOwnerInbound, readOwnerThread, sendOwnerReply, type OwnerThreadOptions } from '../src/core/comms/owner-thread.js';
import { createOwnerThreadApi, VERSE_OWNER_THREAD_PATH as PATH } from '../src/core/verse/owner-thread-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { ownerThreadLines } from '../src/web-ui/routes/verse/leader-thread/owner-thread-lines.js';
import { parseOwnerThreadRead } from '../src/web-ui/routes/verse/leader-thread/owner-thread-queries.js';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })); });

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'receipts-api-'));
  roots.push(root);
  const configDir = join(root, 'config');
  mkdirSync(join(configDir, 'comms'), { recursive: true, mode: 0o700 });
  const ids = '[{ channel = "bus", id = "local-owner" }, { channel = "imessage", id = "+15550000000" }]';
  writeFileSync(join(configDir, 'agent-network.toml'), `[mason]\nidentities = ${ids}\n[team]\nidentities = [{ channel = "bus", id = "leader" }, ${ids.slice(1)}\n`);
  writeFileSync(join(configDir, 'comms.toml'), 'confirmedByMason = true\n');
  writeFileSync(join(configDir, 'comms', 'owner-adapters.toml'), '[imessage]\nbridge = "loopback"\n');
  const runsDir = join(root, 'runs');
  const options = (transports: OwnerThreadOptions['transports']): OwnerThreadOptions => ({
    runsDir, busRoot: join(root, 'bus'), settings: loadOwnerThreadSettings(configDir), halted: false, paused: false, transports,
  });
  return { configDir, runsDir, options };
}

const sender = (status: 'sent' | 'refused'): OwnerChannelTransport => ({ async pull() { return []; }, async deliver() { return { status, reason: 'fake' }; } });

async function getThread(configDir: string, runsDir: string) {
  const url = PATH;
  let status = 0, text = '';
  const req = Object.assign(new PassThrough(), { url, method: 'GET' }) as IncomingMessage;
  const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  const api = createOwnerThreadApi({ runsDir, configDir });
  const handled = await api({ cfg: {}, allowDispatch: true } as VerseApiContext, req, res, PATH, 'GET');
  return { handled, status, body: text ? JSON.parse(text) : null };
}

describe('owner-thread read receipts (c206 recut)', () => {
  it('answers per-channel receipts written by the real send path, parsed by the desktop reader', async () => {
    const { configDir, runsDir, options } = setup();
    const opts = options({ imessage: sender('refused'), desktop: sender('sent') });
    await acceptOwnerInbound({ channel: 'imessage', senderId: '+15550000000', text: 'Synthetic hello', idempotencyKey: 'in-key-c20601', at: Date.now() }, opts);
    const result = await sendOwnerReply({ text: 'Synthetic answer' }, opts);
    expect(result.status).toBe('partial');
    const reply = readOwnerThread(opts).messages.find(m => m.direction === 'outbound')!;

    const r = await getThread(configDir, runsDir);
    expect(r.handled).toBe(true);
    expect(r.status).toBe(200);
    expect(r.body.receipts[reply.id]).toMatchObject({ desktop: { state: 'delivered' }, imessage: { state: 'failed' } });
    expect(r.body.receipts[reply.id].imessage.reason).toMatch(/refused/i);

    const read = parseOwnerThreadRead(r.body);
    const receipt = ownerThreadLines(read.lines, [], read.receipts ?? {}).find(l => l.id === `owner-${reply.id}`)?.receipt;
    expect(receipt).toEqual(expect.arrayContaining([
      { channel: 'desktop', state: 'delivered' },
      expect.objectContaining({ channel: 'imessage', state: 'failed' }),
    ]));
  });

  it('omits inbound ids and never invents a record', async () => {
    const { configDir, runsDir, options } = setup();
    const opts = options({ desktop: sender('sent') });
    await acceptOwnerInbound({ channel: 'imessage', senderId: '+15550000000', text: 'Synthetic hello', idempotencyKey: 'in-key-c20602', at: Date.now() }, opts);
    const inbound = readOwnerThread(opts).messages.find(m => m.direction === 'inbound')!;

    const r = await getThread(configDir, runsDir);
    expect(r.status).toBe(200);
    expect(r.body.receipts[inbound.id]).toBeUndefined();
    const read = parseOwnerThreadRead(r.body);
    const line = ownerThreadLines(read.lines, [], read.receipts ?? {}).find(l => l.id === `owner-${inbound.id}`);
    expect(line?.receipt).toBeUndefined();
  });
});
