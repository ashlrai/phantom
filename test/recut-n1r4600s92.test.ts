import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { readReceipts, recordDelivery } from '../src/core/leader/delivery-receipts.js';

it('returns the latest delivery state for each requested message', () => {
  const dir = mkdtempSync(join(tmpdir(), 'recut-receipts-'));
  try {
    recordDelivery(dir, 'reply', 'desktop', 'pending');
    recordDelivery(dir, 'reply', 'desktop', 'delivered');
    expect(readReceipts(dir, ['reply', 'missing'])).toEqual({ reply: { desktop: { state: 'delivered' } } });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
