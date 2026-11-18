import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readReceipts, recordDelivery } from '../src/core/leader/delivery-receipts.js';

it('reopens persisted channel retries without carrying an obsolete failure reason', () => {
  const runsDir = mkdtempSync(join(tmpdir(), 'recut-testonly-c485-'));
  try {
    recordDelivery(runsDir, 'synthetic-reply', 'desktop', 'delivered');
    recordDelivery(runsDir, 'synthetic-reply', 'imessage', 'pending');
    expect(readReceipts(runsDir, ['synthetic-reply'])).toEqual({
      'synthetic-reply': {
        desktop: { state: 'delivered' },
        imessage: { state: 'pending' },
      },
    });

    recordDelivery(runsDir, 'synthetic-reply', 'imessage', 'failed', 'synthetic outage');
    expect(readReceipts(runsDir, ['synthetic-reply'])['synthetic-reply']).toEqual({
      desktop: { state: 'delivered' },
      imessage: { state: 'failed', reason: 'synthetic outage' },
    });

    recordDelivery(runsDir, 'synthetic-reply', 'imessage', 'delivered');
    expect(readReceipts(runsDir, ['synthetic-reply', 'synthetic-unknown'])).toEqual({
      'synthetic-reply': {
        desktop: { state: 'delivered' },
        imessage: { state: 'delivered' },
      },
    });
  } finally {
    rmSync(runsDir, { recursive: true, force: true });
  }
});
