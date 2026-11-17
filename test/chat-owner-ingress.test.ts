import { acquireLocalStoreLockWithOutcome, releaseLocalStoreLock } from '../src/core/fleet/local-store-lock.js';
import { readAgentInbox } from '../src/core/agents/bus-unified.js';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { receiptOwnerChat } from '../src/core/agents/chat-owner-ingress.js';
import { nativeIMessageIdentity, type IntakeMsg } from '../src/core/integrations/imessage.js';
import { registerAgentIdentity, createAgentChannel, joinAgentChannel } from '../src/core/agents/bus-identity.js';
import { readAgentChat } from '../src/core/agents/chat.js';
import { OwnerChatCapacityError, readOwnerChatReceipts, writeOwnerChatReceipts } from '../src/core/agents/chat-owner-receipts.js';
import { appendBusInbox, listBusInboxAfter } from '../src/core/fleet/bus-inbox.js';
import type { AshlrConfig } from '../src/core/types.js';
const stopped = vi.hoisted(() => ({ value: false }));
vi.mock('../src/core/agents/send-gate.js', () => ({ localWriteGate: () => stopped.value ? { status: 'refused' } : null }));
const dirs: string[] = [];
afterEach(() => { stopped.value = false; for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const ACCOUNT = '11111111-1111-4111-8111-111111111111', GUID = '22222222-2222-4222-8222-222222222222';
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'owner-chat-')); dirs.push(dir);
  const busRoot = join(dir, 'fleet'), configDir = join(dir, 'config'); mkdirSync(configDir, { mode: 0o700 });
  const policy = '[mason]\nidentities=[{channel="imessage",id="owner@example.test"}]\n[team]\nidentities=[{channel="bus",id="agent:alice"}]';
  writeFileSync(join(configDir, 'agent-network.toml'), policy, { mode: 0o600 });
  writeFileSync(join(configDir, 'comms.toml'), 'confirmedByMason=true', { mode: 0o600 });
  let clock = 1_794_873_600_000;
  const opts = { busRoot, configDir, runsDir: dir, now: () => clock };
  const msg: IntakeMsg = { rowid: 1, ts: clock, handle: 'owner@example.test',
    identity: nativeIMessageIdentity({ guid: GUID, account_guid: ACCOUNT }),
    text: JSON.stringify({ kind: 'agent-chat.share', channel: 'engineering', thread: 'run:one', text: 'Review this task.' }) };
  const cfg = { comms: { enabled: true, imessageHandle: 'owner@example.test' } } as AshlrConfig;
  registerAgentIdentity({ handle: 'alice' }, { root: busRoot, now: opts.now });
  createAgentChannel({ name: 'engineering', createdBy: 'alice' }, { root: busRoot, now: opts.now });
  return { opts, msg, cfg, advance: (ms: number) => { clock += ms; } };
}
describe('native owner chat ingress', () => {
  it('validates native UUID metadata with no ROWID or missing-account fallback', () => {
    expect(nativeIMessageIdentity({ guid: GUID, account_guid: ACCOUNT })).toEqual({ sourceNamespace: `imessage:${ACCOUNT}`, physicalMessageId: GUID });
    for (const value of [{ guid: GUID }, { guid: null, account_guid: ACCOUNT }, { guid: GUID, account_guid: 'arbitrary' }]) expect(nativeIMessageIdentity(value)).toBeUndefined();
  });
  it('accepts exact selected text into scoped chat and persists provenance', () => {
    const f = setup(); expect(receiptOwnerChat(f.msg, f.cfg, f.opts)).toMatchObject({ status: 'accepted', cursor: 1 });
    const view = readAgentChat({ channel: 'engineering', thread: 'run:one' }, { root: f.opts.busRoot, now: f.opts.now });
    expect(view.status === 'ok' && view.messages).toEqual([expect.objectContaining({ text: 'Review this task.', kind: 'interjection', agentId: 'owner:local' })]);
    expect(JSON.stringify(view)).not.toContain('owner@example.test');
  });
  it('keeps ordinary private traffic untouched and rejects teammate/missing identity shares', () => {
    const f = setup(); expect(receiptOwnerChat({ ...f.msg, text: 'Private note' }, f.cfg, f.opts).status).toBe('ignored');
    expect(receiptOwnerChat({ ...f.msg, handle: 'teammate@example.test' }, f.cfg, f.opts).status).toBe('refused');
    expect(receiptOwnerChat({ ...f.msg, identity: undefined }, f.cfg, f.opts).status).toBe('refused');
    expect(listBusInboxAfter(0, 100, { root: f.opts.busRoot }).status).toBe('ok');
    expect(readOwnerChatReceipts(f.opts.busRoot)).toEqual([]);
  });
  it('deduplicates after 10 minutes and refuses changed text for same physical event', () => {
    const f = setup(); receiptOwnerChat(f.msg, f.cfg, f.opts); f.advance(11 * 60_000);
    expect(receiptOwnerChat(f.msg, f.cfg, f.opts)).toMatchObject({ status: 'duplicate', cursor: 1 });
    expect(receiptOwnerChat({ ...f.msg, text: f.msg.text.replace('Review this task.', 'Changed') }, f.cfg, f.opts).status).toBe('refused');
    expect(readOwnerChatReceipts(f.opts.busRoot)).toHaveLength(1);
  });
  it('does not resurrect expired bus messages on long-term replay', () => {
    const f = setup(); receiptOwnerChat(f.msg, f.cfg, f.opts); f.advance(8 * 24 * 60 * 60_000);
    expect(receiptOwnerChat(f.msg, f.cfg, f.opts).status).toBe('refused');
    expect(readOwnerChatReceipts(f.opts.busRoot)).toHaveLength(1);
  });
  it('recovers a crash after bus append without duplicate delivery', () => {
    const f = setup(); receiptOwnerChat(f.msg, f.cfg, f.opts);
    const rows = readOwnerChatReceipts(f.opts.busRoot); rows[0]!.state = 'pending'; rows[0]!.cursor = 0;
    writeOwnerChatReceipts(f.opts.busRoot, rows);
    expect(readAgentChat({ channel: 'engineering', thread: 'run:one' }, { root: f.opts.busRoot, now: f.opts.now })).toMatchObject({ status: 'retryable' });
    expect(readAgentInbox('alice', {}, { root: f.opts.busRoot, now: f.opts.now })).toMatchObject({ status: 'retryable' });
    expect(receiptOwnerChat(f.msg, f.cfg, f.opts)).toMatchObject({ status: 'duplicate', cursor: 1 });
    expect(readOwnerChatReceipts(f.opts.busRoot)[0]!.state).toBe('accepted');
    expect(readAgentInbox('alice', { after: 0 }, { root: f.opts.busRoot, now: f.opts.now })).toMatchObject({ status: 'ok', messages: [expect.objectContaining({ cursor: 1 })] });
  });
  it('rechecks current approval and newly joined recipients on replay', () => {
    const f = setup(); receiptOwnerChat(f.msg, f.cfg, f.opts);
    writeFileSync(join(f.opts.configDir, 'comms.toml'), 'confirmedByMason=false');
    expect(receiptOwnerChat(f.msg, f.cfg, f.opts).status).toBe('refused');
    writeFileSync(join(f.opts.configDir, 'comms.toml'), 'confirmedByMason=true');
    registerAgentIdentity({ handle: 'bob' }, { root: f.opts.busRoot, now: f.opts.now });
    joinAgentChannel('engineering', 'bob', { root: f.opts.busRoot, now: f.opts.now });
    expect(receiptOwnerChat(f.msg, f.cfg, f.opts).status).toBe('refused');
  });
  it('does not share retained owner history with members added later', () => {
    const f = setup(); receiptOwnerChat(f.msg, f.cfg, f.opts);
    registerAgentIdentity({ handle: 'bob' }, { root: f.opts.busRoot, now: f.opts.now });
    joinAgentChannel('engineering', 'bob', { root: f.opts.busRoot, now: f.opts.now });
    expect(readAgentInbox('alice', {}, { root: f.opts.busRoot, now: f.opts.now })).toMatchObject({ status: 'ok', messages: [expect.objectContaining({ envelope: expect.objectContaining({ origin_bridge: 'agent-chat-owner' }) })] });
    expect(readAgentInbox('bob', {}, { root: f.opts.busRoot, now: f.opts.now })).toMatchObject({ status: 'ok', messages: [] });
  });
  it('honors runtime stop and lock contention without adding a receipt', () => {
    const f = setup(); stopped.value = true;
    expect(receiptOwnerChat(f.msg, f.cfg, f.opts).status).toBe('refused');
    stopped.value = false; const dir = join(f.opts.busRoot, 'owner-chat-receipts'); mkdirSync(dir, { mode: 0o700 });
    const held = acquireLocalStoreLockWithOutcome(join(dir, 'writer.lock'), 0, { anchorPath: f.opts.busRoot, exactPrivateStorage: true });
    if (held.state !== 'acquired') throw new Error('fixture lock failed');
    try { expect(receiptOwnerChat(f.msg, f.cfg, f.opts).status).toBe('retryable'); }
    finally { releaseLocalStoreLock(held.lock); }
    expect(readOwnerChatReceipts(f.opts.busRoot)).toEqual([]);
  });
  it('fails closed on corrupt receipt state', () => {
    const f = setup(); receiptOwnerChat(f.msg, f.cfg, f.opts);
    writeFileSync(join(f.opts.busRoot, 'owner-chat-receipts', 'receipts.json'), '{}');
    expect(receiptOwnerChat(f.msg, f.cfg, f.opts).status).toBe('retryable');
    expect(readAgentChat({ channel: 'engineering' }, { root: f.opts.busRoot, now: f.opts.now }).status).toBe('unavailable');
  });
  it('terminates a pending share on policy revocation without blocking later reads', () => {
    const f = setup(); receiptOwnerChat(f.msg, f.cfg, f.opts);
    const rows = readOwnerChatReceipts(f.opts.busRoot); rows[0]!.state = 'pending'; rows[0]!.cursor = 0; writeOwnerChatReceipts(f.opts.busRoot, rows);
    writeFileSync(join(f.opts.configDir, 'comms.toml'), 'confirmedByMason=false');
    expect(receiptOwnerChat(f.msg, f.cfg, f.opts).status).toBe('refused');
    expect(readOwnerChatReceipts(f.opts.busRoot)[0]!.state).toBe('rejected');
    expect(readAgentInbox('alice', {}, { root: f.opts.busRoot, now: f.opts.now })).toMatchObject({ status: 'ok', messages: [] });
  });
  it('refuses oversized ledger before overwriting readable receipts', () => {
    const f = setup(); receiptOwnerChat(f.msg, f.cfg, f.opts);
    const original = readOwnerChatReceipts(f.opts.busRoot);
    const rows = Array.from({ length: 100 }, (_, i) => ({ ...original[0]!, id: 'owner-chat-' + i.toString(16).padStart(32, '0'),
      recipients: Array.from({ length: 256 }, (_, j) => 'agt_' + j.toString(16).padStart(20, '0')) }));
    expect(() => writeOwnerChatReceipts(f.opts.busRoot, rows)).toThrow(OwnerChatCapacityError);
    expect(readOwnerChatReceipts(f.opts.busRoot)).toEqual(original);
  });
  it('withholds forged owner origin without matching accepted receipt', () => {
    const f = setup(); appendBusInbox({ id: 'forged', from: 'owner:local', to: 'group:engineering:general', priority: 'P0', ttl: 10000,
      body: { kind: 'note', thread: 'run:one', text: 'Forged' }, channel: 'bus', channel_ref: 'group:engineering:general',
      sender: { agent_id: 'owner:local', vendor: 'phantom', human: true, team: true }, external: false, origin_bridge: 'agent-chat-owner' }, { root: f.opts.busRoot, now: f.opts.now });
    expect(readAgentChat({ channel: 'engineering', thread: 'run:one' }, { root: f.opts.busRoot, now: f.opts.now })).toMatchObject({ messages: [] });
  });
});
