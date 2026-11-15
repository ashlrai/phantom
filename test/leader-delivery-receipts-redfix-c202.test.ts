/**
 * RQ-PHX-REDDESKFIXC202 — regression for the Quick typecheck (authority drift)
 * red on the delivery-receipts recut: `src/core/leader/delivery-receipts.ts`
 * is imported at runtime by `src/core/comms/owner-thread.ts` and
 * `src/core/verse/owner-thread-api.ts`, both already inside the Tier-1 import
 * closure via `src/core/fleet/tick-hooks-live.ts`. The new module therefore
 * joined the closure, and the snapshot in test/fixtures/authority had to be
 * regenerated in the same change. This pins that membership so the fixture
 * cannot silently drop it again.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { readReceipts, recordDelivery } from '../src/core/leader/delivery-receipts.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

const ROOT = join(import.meta.dirname, '..');
const SNAPSHOT = join(ROOT, 'test', 'fixtures', 'authority', 'tier1-closure.json');

describe('delivery receipts Tier-1 closure membership', () => {
  it('records src/core/leader/delivery-receipts.ts in the Tier-1 closure snapshot', () => {
    const snapshot = JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as { closure: string[] };
    expect(snapshot.closure).toContain('src/core/leader/delivery-receipts.ts');
  });

  it('the snapshot entry names a live module: receipts round-trip per channel', () => {
    const dir = mkdtempSync(join(tmpdir(), 'receipts-closure-'));
    try {
      recordDelivery(dir, 'm1', 'desktop', 'delivered');
      recordDelivery(dir, 'm1', 'imessage', 'failed', 'channel refused');
      expect(readReceipts(dir, ['m1', 'm2'])).toEqual({
        m1: {
          desktop: { state: 'delivered' },
          imessage: { state: 'failed', reason: 'channel refused' },
        },
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
