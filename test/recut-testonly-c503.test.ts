import { appendFileSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readReceipts, recordDelivery } from '../src/core/leader/delivery-receipts.js';

it('reads recent receipts beyond a partial oversized row without reviving old delivery evidence', () => {
  const runsDir = mkdtempSync(join(tmpdir(), 'recut-testonly-c503-'));
  try {
    recordDelivery(runsDir, 'synthetic-old', 'desktop', 'delivered');
    const file = join(runsDir, 'leader', 'delivery-receipts.jsonl');
    // Fewer than MAX_READ_LINES rows, but more than the reader's byte limit.
    // The bounded read starts inside this row and must discard its fragment.
    appendFileSync(file, `${JSON.stringify({
      messageId: 'synthetic-padding', channel: 'desktop', state: 'delivered',
      padding: 'x'.repeat(300 * 1024),
    })}\n`);
    recordDelivery(runsDir, 'synthetic-current', 'desktop', 'delivered');
    recordDelivery(runsDir, 'synthetic-current', 'imessage', 'failed', 'synthetic outage');
    const before = readFileSync(file);

    expect(readReceipts(runsDir, [
      'synthetic-old', 'synthetic-padding', 'synthetic-current', 'synthetic-unknown',
    ])).toEqual({
      'synthetic-current': {
        desktop: { state: 'delivered' },
        imessage: { state: 'failed', reason: 'synthetic outage' },
      },
    });
    expect(readReceipts(runsDir, [])).toEqual({});
    expect(readFileSync(file)).toEqual(before);

    recordDelivery(runsDir, 'synthetic-current', 'imessage', 'delivered');
    expect(readReceipts(runsDir, ['synthetic-current'])).toEqual({
      'synthetic-current': {
        desktop: { state: 'delivered' },
        imessage: { state: 'delivered' },
      },
    });
  } finally {
    rmSync(runsDir, { recursive: true, force: true });
  }
});
