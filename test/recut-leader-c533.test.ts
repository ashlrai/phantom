import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readReceipts, recordDelivery } from '../src/core/leader/delivery-receipts.js';

it('recovers receipt reads after an oversized incomplete tail without rewriting the ledger', () => {
  const runsDir = mkdtempSync(join(tmpdir(), 'recut-leader-c533-'));
  const file = join(runsDir, 'leader', 'delivery-receipts.jsonl');
  try {
    expect(readReceipts(runsDir, ['synthetic-old'])).toEqual({});
    expect(existsSync(join(runsDir, 'leader'))).toBe(false);

    recordDelivery(runsDir, 'synthetic-old', 'desktop', 'delivered');
    // Exceed the byte cap with a torn line, while staying below the row cap.
    // The older delivered receipt must become unknown when outside the tail.
    appendFileSync(file, 'x'.repeat(300 * 1024));
    const tornBytes = readFileSync(file);
    expect(readReceipts(runsDir, ['synthetic-old'])).toEqual({});
    expect(readFileSync(file)).toEqual(tornBytes);

    appendFileSync(file, '\n');
    recordDelivery(runsDir, 'synthetic-current', 'desktop', 'pending');
    recordDelivery(runsDir, 'synthetic-current', 'imessage', 'failed', 'synthetic outage');
    const recoveredBytes = readFileSync(file);
    expect(readReceipts(runsDir, ['synthetic-old', 'synthetic-current'])).toEqual({
      'synthetic-current': {
        desktop: { state: 'pending' },
        imessage: { state: 'failed', reason: 'synthetic outage' },
      },
    });
    expect(readFileSync(file)).toEqual(recoveredBytes);
  } finally {
    rmSync(runsDir, { recursive: true, force: true });
  }
});
