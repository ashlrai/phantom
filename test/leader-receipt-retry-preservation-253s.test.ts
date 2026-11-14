/** RQ-PHX-LEADERRECEIPTRETRY253S — retry convergence for Leader delivery
 * receipts (preserves the receipt slice of PR #4817 / RQ-PHX-LEADERDELIVERYRECEIPT95).
 *
 * One logical reply fans out to iMessage + desktop. The first attempt refuses
 * on iMessage and delivers on desktop (`partial`). Retrying the SAME reply after
 * the failed transport recovers must: not resend to desktop, send exactly once
 * more to iMessage, keep ONE outbound thread message with a stable id, and move
 * the GET receipts from failed -> delivered for iMessage while desktop stays
 * delivered. A third identical call is a pure duplicate: zero transport calls.
 *
 * Synthetic identities, temp dirs, in-memory counting transports; the send path
 * (acceptOwnerInbound -> sendOwnerReply) and the read path (createOwnerThreadApi
 * GET) are the real modules. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { loadOwnerThreadSettings, type OwnerChannelTransport, type OwnerDelivery } from '../src/core/comms/owner-channel.js';
import { acceptOwnerInbound, readOwnerThread, sendOwnerReply, type OwnerThreadOptions, type OwnerThreadResult } from '../src/core/comms/owner-thread.js';
import { createOwnerThreadApi, VERSE_OWNER_THREAD_PATH as PATH } from '../src/core/verse/owner-thread-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })); });

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'leader-receipt-retry-'));
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

/** In-memory transport that counts deliver() calls; `up` flips the refusal off. */
function countingSender(up: () => boolean) {
  const calls: OwnerDelivery[] = [];
  const transport: OwnerChannelTransport = {
    async pull() { return []; },
    async deliver(input: OwnerDelivery) {
      calls.push(input);
      return up() ? { status: 'sent' as const, reason: 'delivered' } : { status: 'refused' as const, reason: 'transport down' };
    },
  };
  return { calls, transport };
}

async function getThread(configDir: string, runsDir: string) {
  const url = PATH;
  let status = 0, text = '';
  const req = Object.assign(new PassThrough(), { url, method: 'GET' }) as IncomingMessage;
  const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  const api = createOwnerThreadApi({ runsDir, configDir });
  const handled = await api({ cfg: {}, allowDispatch: true } as VerseApiContext, req, res, PATH, 'GET');
  return { handled, status, body: text ? JSON.parse(text) : null };
}

const outboundMessages = (opts: OwnerThreadOptions) =>
  readOwnerThread(opts).messages.filter(m => m.direction === 'outbound');

describe('leader delivery receipts across a partial-send retry (253s)', () => {
  it('resends only the failed channel, keeps one outbound message, and receipts converge', async () => {
    const { configDir, runsDir, options } = setup();
    let imessageUp = false;
    const imessage = countingSender(() => imessageUp);
    const desktop = countingSender(() => true);
    const opts = options({ imessage: imessage.transport, desktop: desktop.transport });

    await acceptOwnerInbound({
      channel: 'imessage', senderId: '+15550000000', text: 'Synthetic hello 253s',
      idempotencyKey: 'in-key-253s01', at: Date.now(),
    }, opts);

    // Attempt 1: iMessage refuses, desktop delivers -> partial.
    const first: OwnerThreadResult = await sendOwnerReply({ text: 'Synthetic answer 253s' }, opts);
    expect(first.status).toBe('partial');
    expect(first.deliveries).toEqual(expect.arrayContaining([
      expect.objectContaining({ channel: 'imessage', status: 'refused' }),
      expect.objectContaining({ channel: 'desktop', status: 'sent' }),
    ]));
    expect(imessage.calls).toHaveLength(1);
    expect(desktop.calls).toHaveLength(1);

    const replyId = outboundMessages(opts)[0]!.id;
    const firstRead = await getThread(configDir, runsDir);
    expect(firstRead.handled).toBe(true);
    expect(firstRead.status).toBe(200);
    expect(firstRead.body.receipts[replyId]).toMatchObject({
      desktop: { state: 'delivered' },
      imessage: { state: 'failed' },
    });

    // Transport recovers; retry the SAME logical reply (same derived key).
    imessageUp = true;
    const second: OwnerThreadResult = await sendOwnerReply({ text: 'Synthetic answer 253s' }, opts);
    expect(second.status).toBe('sent');
    expect(second.deliveries).toEqual(expect.arrayContaining([
      expect.objectContaining({ channel: 'imessage', status: 'sent' }),
      expect.objectContaining({ channel: 'desktop', status: 'duplicate' }),
    ]));
    // No resend to the channel that already succeeded; exactly one retry to iMessage.
    expect(desktop.calls).toHaveLength(1);
    expect(imessage.calls).toHaveLength(2);
    // Still exactly one outbound message, same stable id.
    const outbound = outboundMessages(opts);
    expect(outbound).toHaveLength(1);
    expect(outbound[0]!.id).toBe(replyId);

    const secondRead = await getThread(configDir, runsDir);
    expect(secondRead.status).toBe(200);
    expect(secondRead.body.receipts[replyId]).toEqual({
      desktop: { state: 'delivered' },
      imessage: { state: 'delivered' },
    });

    // Third identical call: pure duplicate — no transport calls, no new message.
    const third: OwnerThreadResult = await sendOwnerReply({ text: 'Synthetic answer 253s' }, opts);
    expect(third.status).toBe('duplicate');
    expect(third.deliveries?.every(row => row.status === 'duplicate')).toBe(true);
    expect(imessage.calls).toHaveLength(2);
    expect(desktop.calls).toHaveLength(1);
    expect(outboundMessages(opts)).toHaveLength(1);
    expect(outboundMessages(opts)[0]!.id).toBe(replyId);

    const thirdRead = await getThread(configDir, runsDir);
    expect(thirdRead.body.receipts[replyId]).toEqual({
      desktop: { state: 'delivered' },
      imessage: { state: 'delivered' },
    });
  });
});
