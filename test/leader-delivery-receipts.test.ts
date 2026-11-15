import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { loadOwnerThreadSettings, type OwnerChannelTransport } from '../src/core/comms/owner-channel.js';
import { acceptOwnerInbound, readOwnerThread, sendOwnerReply, type OwnerThreadOptions } from '../src/core/comms/owner-thread.js';
import { MAX_READ_LINES, readReceipts, recordDelivery } from '../src/core/leader/delivery-receipts.js';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })); });
const tmp = () => { const r = mkdtempSync(join(tmpdir(), 'leader-receipts-')); roots.push(r); return r; };

describe('delivery receipts store', () => {
  it('records and reads per channel, latest wins, and keeps a failed reason', () => {
    const dir = tmp();
    recordDelivery(dir, 'm1', 'desktop', 'delivered');
    recordDelivery(dir, 'm1', 'slack', 'pending');
    recordDelivery(dir, 'm1', 'slack', 'failed', 'Channel transport refused the owner reply.');
    expect(readReceipts(dir, ['m1'])).toEqual({ m1: {
      desktop: { state: 'delivered' },
      slack: { state: 'failed', reason: 'Channel transport refused the owner reply.' },
    } });
  });

  it('has no entry (unknown) for a message with no record or no file', () => {
    const dir = tmp();
    expect(readReceipts(dir, ['m9'])).toEqual({});
    recordDelivery(dir, 'm1', 'desktop', 'delivered');
    expect(readReceipts(dir, ['m9']).m9).toBeUndefined();
  });

  it('reads only the last 500 lines and skips junk lines', () => {
    const dir = tmp();
    recordDelivery(dir, 'old', 'desktop', 'delivered');
    const file = join(dir, 'leader', 'delivery-receipts.jsonl');
    appendFileSync(file, 'not json\n');
    for (let i = 0; i < MAX_READ_LINES; i++) appendFileSync(file, `${JSON.stringify({ messageId: 'new', channel: 'desktop', state: 'delivered' })}\n`);
    const read = readReceipts(dir, ['old', 'new']);
    expect(read.old).toBeUndefined();
    expect(read.new?.desktop?.state).toBe('delivered');
  });
});

describe('real owner reply fan-out with fake senders', () => {
  function setup() {
    const root = tmp();
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
    return { runsDir, options };
  }
  const sender = (status: 'sent' | 'refused'): OwnerChannelTransport => ({ async pull() { return []; }, async deliver() { return { status, reason: 'fake' }; } });

  it('writes one receipt per channel: delivered and failed', async () => {
    const { runsDir, options } = setup();
    const opts = options({ imessage: sender('refused'), desktop: sender('sent') });
    await acceptOwnerInbound({ channel: 'imessage', senderId: '+15550000000', text: 'Synthetic hello', idempotencyKey: 'in-key-00001', at: Date.now() }, opts);
    const result = await sendOwnerReply({ text: 'Synthetic answer' }, opts);
    expect(result.status).toBe('partial');
    const reply = readOwnerThread(opts).messages.find(m => m.direction === 'outbound')!;
    const receipts = readReceipts(runsDir, [reply.id])[reply.id]!;
    expect(Object.keys(receipts).sort()).toEqual(['desktop', 'imessage']);
    expect(receipts.desktop).toEqual({ state: 'delivered' });
    expect(receipts.imessage?.state).toBe('failed');
    expect(receipts.imessage?.reason).toMatch(/refused/i);
  });
});
