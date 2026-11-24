/** RQ-PHX-RECUTLEADERC479 — recut coverage for the leader delivery-receipt
 * store that #5372 (RQ-PHX-RECEIPTRETRYOWNERQUALIFY284S) exercises end-to-end.
 * Where the carried test proves restart dedupe through the send path and GET
 * API, this file proves the store contract at its real exported entry points:
 * recordDelivery/readReceipts in src/core/leader/delivery-receipts.ts.
 *
 * A message with no record is "unknown", never "delivered"; the latest row per
 * channel wins; corrupt or out-of-contract rows are skipped; reads are bounded
 * to the last MAX_READ_LINES rows so stale history cannot resurrect a state.
 * Plainly fake ids and temp dirs only; no network, no real home. */
import { appendFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_READ_LINES, readReceipts, recordDelivery } from '../src/core/leader/delivery-receipts.js';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })); });

function runsDir() {
  const dir = mkdtempSync(join(tmpdir(), 'recut-leader-c479-'));
  roots.push(dir);
  return dir;
}

const receiptsFile = (dir: string) => join(dir, 'leader', 'delivery-receipts.jsonl');

describe('leader delivery-receipt store (recut c479)', () => {
  it('keeps latest-per-channel and never reports unrecorded or unasked ids', () => {
    const dir = runsDir();
    recordDelivery(dir, 'msg-a', 'imessage', 'failed', 'transport down');
    recordDelivery(dir, 'msg-a', 'desktop', 'delivered');
    recordDelivery(dir, 'msg-a', 'imessage', 'delivered');
    recordDelivery(dir, 'msg-b', 'desktop', 'failed', 'offline');

    const res = readReceipts(dir, ['msg-a', 'msg-c']);
    // The earlier imessage 'failed' row is superseded by the 'delivered' row.
    expect(res['msg-a']).toEqual({
      imessage: { state: 'delivered' },
      desktop: { state: 'delivered' },
    });
    // No record -> absent (unknown), never falsely delivered.
    expect(res['msg-c']).toBeUndefined();
    // Recorded but not asked -> absent.
    expect(res['msg-b']).toBeUndefined();
  });

  it('reports the failure reason while a channel stays failed', () => {
    const dir = runsDir();
    recordDelivery(dir, 'msg-a', 'imessage', 'failed', 'transport down');
    const res = readReceipts(dir, ['msg-a']);
    expect(res['msg-a']).toEqual({ imessage: { state: 'failed', reason: 'transport down' } });
  });

  it('skips corrupt and out-of-contract rows instead of trusting them', () => {
    const dir = runsDir();
    recordDelivery(dir, 'msg-a', 'desktop', 'delivered');
    const file = receiptsFile(dir);
    appendFileSync(file, 'not-json\n');
    appendFileSync(file, `${JSON.stringify({ messageId: 'msg-a', channel: 'desktop', state: 'bogus' })}\n`);
    appendFileSync(file, `${JSON.stringify({ messageId: 'msg-a', channel: 'imessage', state: 'pending' })}\n`);
    appendFileSync(file, `${JSON.stringify({ messageId: 42, channel: 'slack', state: 'delivered' })}\n`);

    const res = readReceipts(dir, ['msg-a']);
    // 'bogus' is not a receipt state and must not overwrite the real row;
    // 'pending' is a valid state and is reported.
    expect(res['msg-a']).toEqual({
      desktop: { state: 'delivered' },
      imessage: { state: 'pending' },
    });
  });

  it('bounds reads to the MAX_READ_LINES tail so old rows fall out of scope', () => {
    const dir = runsDir();
    for (let i = 0; i < MAX_READ_LINES + 10; i++) recordDelivery(dir, `old-${i}`, 'desktop', 'delivered');
    recordDelivery(dir, 'msg-tail', 'desktop', 'delivered');

    const res = readReceipts(dir, ['old-0', 'msg-tail']);
    expect(res['msg-tail']).toEqual({ desktop: { state: 'delivered' } });
    // old-0 scrolled past the bounded tail read.
    expect(res['old-0']).toBeUndefined();
  });
});
