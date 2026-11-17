/** RQ-PHX-RECUTLEADERC458 — recut regression coverage for the LEADER bucket.
 * Exercises the real exported entry points of src/core/leader/delivery-receipts.ts
 * (recordDelivery / readReceipts) against temp runs dirs: latest receipt per
 * channel wins, unrecorded ids stay absent (never "delivered"), and malformed
 * jsonl lines are skipped rather than failing the read. */
import { mkdtempSync, rmSync, appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readReceipts, recordDelivery } from '../src/core/leader/delivery-receipts.js';

const roots: string[] = [];
afterEach(() => { roots.splice(0).forEach(r => rmSync(r, { recursive: true, force: true })); });

function runsDir() {
  const root = mkdtempSync(join(tmpdir(), 'leader-receipts-'));
  roots.push(root);
  return root;
}

describe('leader delivery receipts (recut c458)', () => {
  it('returns the latest receipt per channel for asked ids only', () => {
    const dir = runsDir();
    recordDelivery(dir, 'msg-1', 'desktop', 'pending');
    recordDelivery(dir, 'msg-1', 'desktop', 'delivered');
    recordDelivery(dir, 'msg-1', 'imessage', 'failed', 'transport refused');
    recordDelivery(dir, 'msg-2', 'slack', 'delivered');

    const out = readReceipts(dir, ['msg-1', 'msg-absent']);
    expect(out['msg-1']).toEqual({
      desktop: { state: 'delivered' },
      imessage: { state: 'failed', reason: 'transport refused' },
    });
    expect(out['msg-2']).toBeUndefined();
    expect(out['msg-absent']).toBeUndefined();
  });

  it('skips malformed lines and unknown states instead of throwing', () => {
    const dir = runsDir();
    const file = join(dir, 'leader', 'delivery-receipts.jsonl');
    mkdirSync(join(dir, 'leader'), { recursive: true });
    writeFileSync(file, [
      'not json',
      JSON.stringify({ messageId: 'msg-1', channel: 'desktop', state: 'bogus' }),
      JSON.stringify({ messageId: 'msg-1', channel: 'desktop', state: 'pending' }),
      '',
    ].join('\n'));
    appendFileSync(file, `${JSON.stringify({ messageId: 'msg-1', channel: 'imessage', state: 'delivered' })}\n`);

    expect(readReceipts(dir, ['msg-1'])).toEqual({
      'msg-1': { desktop: { state: 'pending' }, imessage: { state: 'delivered' } },
    });
    expect(readReceipts(dir, [])).toEqual({});
  });
});
