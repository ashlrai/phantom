import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PHANTOM_PAIR_INVITE_TEXT, isPhantomOutboundEcho } from '../src/core/comms/phantom-outbound-echo.js';
import { PAIR_TEXT } from '../src/core/comms/owner-pair.js';
import { formatChannelAck } from '../src/core/fleet/channel-ack-text.js';
import { ingestIMessages } from '../src/core/comms/imessage-inbox-bridge.js';
import { sendIMessageOutbox } from '../src/core/comms/imessage-outbox.js';
import { readCursor, writeCursor } from '../src/core/integrations/imessage.js';
import { QueueStore } from '../src/core/queue/store.js';
import type { AshlrConfig } from '../src/core/types.js';

vi.mock('../src/core/comms/imessage-outbox.js', () => ({
  sendIMessageOutbox: vi.fn().mockResolvedValue({ ok: true }),
}));

const ackTexts = [
  formatChannelAck({ channel: 'imessage', status: 'accepted', dedupeKey: 'receipt-1' }),
  formatChannelAck({ channel: 'imessage', status: 'duplicate', dedupeKey: 'receipt-2' }),
  formatChannelAck({ channel: 'imessage', status: 'duplicate', dedupeKey: 'receipt-3', entryId: 'entry_1.a:b-c' }),
];

describe('Phantom outbound echo recognition', () => {
  it('pins the pairing payload to the sender', () => {
    expect(PHANTOM_PAIR_INVITE_TEXT).toBe(PAIR_TEXT);
  });
  it.each([PHANTOM_PAIR_INVITE_TEXT, ...ackTexts])('matches the complete payload %s', text => {
    expect(isPhantomOutboundEcho(text)).toBe(true);
    expect(isPhantomOutboundEcho(` \n${text}\t `)).toBe(true);
    expect(isPhantomOutboundEcho(`order ${text}`)).toBe(false);
    expect(isPhantomOutboundEcho(`${text} extra words`)).toBe(false);
  });
  it.each(['', 'YES', 'pause devin', 'Phantom: pause devin', 'Phantom:',
    'Received by PhantomX Receipt: key', 'Received by Phantom. Receipt: two keys',
    ...ackTexts.flatMap(text => [text.replace(/receipt-\d$/, ''), text.replace(/receipt-\d$/, 'x'.repeat(201))]),
    ackTexts[2]!.replace('entry_1.a:b-c', 'bad/id'), ackTexts[2]!.replace('entry_1.a:b-c', ''),
    ackTexts[2]!.replace('entry_1.a:b-c', 'x'.repeat(65)),
  ])('keeps ordinary input or malformed protocol text: %s', text => {
    expect(isPhantomOutboundEcho(text)).toBe(false);
  });
  it.each(ackTexts)('accepts receipt length boundaries for %s', text => {
    for (const key of ['x', 'x'.repeat(200)]) {
      expect(isPhantomOutboundEcho(text.replace(/receipt-\d$/, key))).toBe(true);
    }
  });
  it('accepts entry id length boundaries', () => {
    for (const entryId of ['x', 'x'.repeat(64)]) {
      expect(isPhantomOutboundEcho(ackTexts[2]!.replace('entry_1.a:b-c', entryId))).toBe(true);
    }
  });
});

let root: string | undefined;
afterEach(() => { if (root) rmSync(root, { recursive: true, force: true }); root = undefined; });

describe('iMessage self-chat echo intake', () => {
  it.each([false, true])('skips echoes without receipts or acks (real order: %s)', async realOrder => {
    root = mkdtempSync(join(tmpdir(), 'imessage-echo-'));
    const runsDir = join(root, 'runs');
    const handle = '+15550000001';
    const cfg = { comms: { enabled: true, imessageHandle: handle } } as AshlrConfig;
    writeCursor(10, runsDir);
    const texts = [PHANTOM_PAIR_INVITE_TEXT, ackTexts[0]!, ...(realOrder ? ['pause devin'] : [])];
    const result = await ingestIMessages(cfg, {
      runsDir, busRoot: join(root, 'bus'), platform: 'darwin',
      poll: async () => ({ ok: true, state: 'ok', messages: texts.map((text, i) => ({ rowid: 11 + i, text, handle, ts: 1 })) }),
    });
    expect(result).toMatchObject({ ok: true, state: 'ingested', echo: 2, accepted: Number(realOrder),
      scanned: texts.length, duplicate: 0, refused: 0, deferred: false, cursor: 10 + texts.length });
    expect(readCursor(runsDir)).toBe(10 + texts.length);
    expect(sendIMessageOutbox).toHaveBeenCalledTimes(Number(realOrder));
    const inboxPath = join(runsDir, 'leader', 'MASON-INBOX.md');
    const ackPath = join(runsDir, 'imessage', 'acks.jsonl');
    const receiptsPath = join(runsDir, 'channel-receipts', 'receipts.json');
    if (realOrder) {
      const inbox = readFileSync(inboxPath, 'utf8');
      expect(inbox.match(/\[src:imessage id:/g)).toHaveLength(1);
      expect(inbox).toContain('pause devin');
      for (const echo of texts.slice(0, 2)) expect(inbox).not.toContain(echo);
      const acks = readFileSync(ackPath, 'utf8').trim().split('\n').map(line => JSON.parse(line));
      expect(acks).toHaveLength(1);
      expect(acks[0]).toMatchObject({ rowid: 13, status: 'accepted' });
      expect(sendIMessageOutbox).toHaveBeenCalledWith(acks[0].text, cfg, handle);
      expect(JSON.parse(readFileSync(receiptsPath, 'utf8'))).toHaveLength(1);
      const jobs = (await new QueueStore(join(runsDir, 'queue'), 250).read()).jobs;
      expect(jobs.map(job => job.scope)).toEqual(['pause devin']);
    } else {
      for (const path of [inboxPath, ackPath, receiptsPath, join(runsDir, 'queue')]) {
        expect(existsSync(path)).toBe(false);
      }
    }
  });
});
