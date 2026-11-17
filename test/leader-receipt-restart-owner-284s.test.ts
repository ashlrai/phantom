/** RQ-PHX-RECEIPTRETRYOWNERQUALIFY284S — owner-support qualification of
 * PR #5343 (RQ-PHX-LEADERRECEIPTRETRY253S) at the persistence boundary the
 * owner's suite does not reach: the SAME logical reply retried after the
 * process is reconstructed. Options, transports, settings and the read API
 * are rebuilt from the persisted temp state between attempts, so dedupe can
 * only come from owner-thread.json + delivery-receipts.jsonl on disk.
 *
 * Attempt 1 (process A): iMessage refuses, desktop delivers -> partial.
 * Attempt 2 (process B, iMessage still down): retry stays partial — desktop
 * transport is a NEW instance that must see ZERO calls, iMessage exactly one;
 * receipts still read failed/delivered, never falsely delivered.
 * Attempt 3 (process C, iMessage recovered): retry converges — one outbound
 * message with the stable id, only iMessage called, receipts delivered.
 * A final read-only reopen (process D) confirms the GET receipts agree.
 *
 * Synthetic identities, temp dirs, in-memory counting transports; the send
 * path (acceptOwnerInbound -> sendOwnerReply) and the read path
 * (createOwnerThreadApi GET) are the real modules. No runtime network. */
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

const REPLY_TEXT = 'Synthetic answer 284s';

function setup() {
  const root = mkdtempSync(join(tmpdir(), 'leader-receipt-restart-'));
  roots.push(root);
  const configDir = join(root, 'config');
  mkdirSync(join(configDir, 'comms'), { recursive: true, mode: 0o700 });
  const ids = '[{ channel = "bus", id = "local-owner" }, { channel = "imessage", id = "+15550000000" }]';
  writeFileSync(join(configDir, 'agent-network.toml'), `[mason]\nidentities = ${ids}\n[team]\nidentities = [{ channel = "bus", id = "leader" }, ${ids.slice(1)}\n`);
  writeFileSync(join(configDir, 'comms.toml'), 'confirmedByMason = true\n');
  writeFileSync(join(configDir, 'comms', 'owner-adapters.toml'), '[imessage]\nbridge = "loopback"\n');
  const runsDir = join(root, 'runs');
  return { configDir, runsDir, busRoot: join(root, 'bus') };
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

/** One "process": fresh options, fresh transports, fresh settings load and a
 * fresh read API — nothing in memory survives a restart. */
function open(configDir: string, runsDir: string, busRoot: string, imessageUp: () => boolean) {
  const imessage = countingSender(imessageUp);
  const desktop = countingSender(() => true);
  const opts: OwnerThreadOptions = {
    runsDir, busRoot, settings: loadOwnerThreadSettings(configDir),
    halted: false, paused: false, transports: { imessage: imessage.transport, desktop: desktop.transport },
  };
  const api = createOwnerThreadApi({ runsDir, configDir });
  return { opts, api, imessage, desktop };
}

async function getThread(api: ReturnType<typeof createOwnerThreadApi>) {
  const url = PATH;
  let status = 0, text = '';
  const req = Object.assign(new PassThrough(), { url, method: 'GET' }) as IncomingMessage;
  const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  const handled = await api({ cfg: {}, allowDispatch: true } as VerseApiContext, req, res, PATH, 'GET');
  return { handled, status, body: text ? JSON.parse(text) : null };
}

const outboundMessages = (opts: OwnerThreadOptions) =>
  readOwnerThread(opts).messages.filter(m => m.direction === 'outbound');

describe('leader delivery receipts across a process restart (284s)', () => {
  it('retry after reconstruction resends only the failed channel and receipts converge', async () => {
    const { configDir, runsDir, busRoot } = setup();
    let imessageUp = false;

    // Process A: first attempt, iMessage refuses, desktop delivers -> partial.
    const a = open(configDir, runsDir, busRoot, () => imessageUp);
    await acceptOwnerInbound({
      channel: 'imessage', senderId: '+15550000000', text: 'Synthetic hello 284s',
      idempotencyKey: 'in-key-284s01', at: Date.now(),
    }, a.opts);
    const first: OwnerThreadResult = await sendOwnerReply({ text: REPLY_TEXT }, a.opts);
    expect(first.status).toBe('partial');
    expect(a.imessage.calls).toHaveLength(1);
    expect(a.desktop.calls).toHaveLength(1);
    const replyId = outboundMessages(a.opts)[0]!.id;

    const firstRead = await getThread(a.api);
    expect(firstRead.status).toBe(200);
    expect(firstRead.body.receipts[replyId]).toMatchObject({
      desktop: { state: 'delivered' },
      imessage: { state: 'failed' },
    });

    // Process B: full reconstruction, iMessage still down. The retry must be
    // driven by persisted state: desktop transport is a new instance and must
    // see zero calls; iMessage exactly one refused call; receipt stays failed.
    const b = open(configDir, runsDir, busRoot, () => imessageUp);
    const second: OwnerThreadResult = await sendOwnerReply({ text: REPLY_TEXT }, b.opts);
    expect(second.status).toBe('partial');
    expect(b.desktop.calls).toHaveLength(0);
    expect(b.imessage.calls).toHaveLength(1);
    expect(b.imessage.calls[0]!.idempotencyKey).toBe(`${first.idempotencyKey}:imessage`);
    const outboundB = outboundMessages(b.opts);
    expect(outboundB).toHaveLength(1);
    expect(outboundB[0]!.id).toBe(replyId);

    const secondRead = await getThread(b.api);
    expect(secondRead.status).toBe(200);
    // The retried failure stays 'failed' (with its reason), never delivered.
    expect(secondRead.body.receipts[replyId]).toMatchObject({
      desktop: { state: 'delivered' },
      imessage: { state: 'failed' },
    });
    expect(secondRead.body.receipts[replyId].imessage.state).toBe('failed');

    // Process C: reconstruct again with iMessage recovered. The identical
    // logical reply converges: only iMessage is retried, one outbound message.
    imessageUp = true;
    const c = open(configDir, runsDir, busRoot, () => imessageUp);
    const third: OwnerThreadResult = await sendOwnerReply({ text: REPLY_TEXT }, c.opts);
    expect(third.status).toBe('sent');
    expect(third.deliveries).toEqual(expect.arrayContaining([
      expect.objectContaining({ channel: 'imessage', status: 'sent' }),
      expect.objectContaining({ channel: 'desktop', status: 'duplicate' }),
    ]));
    expect(c.desktop.calls).toHaveLength(0);
    expect(c.imessage.calls).toHaveLength(1);
    const outboundC = outboundMessages(c.opts);
    expect(outboundC).toHaveLength(1);
    expect(outboundC[0]!.id).toBe(replyId);

    const thirdRead = await getThread(c.api);
    expect(thirdRead.status).toBe(200);
    expect(thirdRead.body.receipts[replyId]).toEqual({
      desktop: { state: 'delivered' },
      imessage: { state: 'delivered' },
    });

    // Process D: read-only reopen — receipts still agree, no extra outbound.
    const d = open(configDir, runsDir, busRoot, () => imessageUp);
    const fourthRead = await getThread(d.api);
    expect(fourthRead.status).toBe(200);
    expect(fourthRead.body.receipts[replyId]).toEqual({
      desktop: { state: 'delivered' },
      imessage: { state: 'delivered' },
    });
    expect(outboundMessages(d.opts)).toHaveLength(1);
    expect(outboundMessages(d.opts)[0]!.id).toBe(replyId);
  });
});
