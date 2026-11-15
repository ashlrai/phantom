/**
 * RQ-PHX-REDDESKFIXC206 — pins the two CI fixes that make #5303
 * (bridge: RQ-PHX-RECUTDESKS0C219, merge-wait card) mergeable:
 *
 * 1. Secret scan (diff): gitleaks' generic-api-key rule flagged the query
 *    cache key 'verse-fleet-merge-latency-24h' in MergeWaitCard.tsx —
 *    a `key:` literal whose value is long enough and digit-bearing to look
 *    secret-shaped. The key is now 'verse-fleet-merge-wait'; this test keeps
 *    every `key: '<literal>'` in that file on the safe side of the observed
 *    trigger (>= 20 chars with an ASCII digit).
 * 2. Quick typecheck / authority drift: the PR adds the Tier-1 test
 *    test/verse-merge-latency-api.test.ts, which needs its generated
 *    CODEOWNERS owner-lane entry. This test pins that the entry stays.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const CARD = join(ROOT, 'src/web-ui/routes/verse/fleet-merges/MergeWaitCard.tsx');
const OWNERS = join(ROOT, '.github/CODEOWNERS');

/** `key: '<literal>'` assignments (QueryDef cache keys), not JSX `key={...}`. */
const KEY_LITERAL = /\bkey:\s*'([^']+)'/g;

/** Shape that tripped gitleaks generic-api-key on the old -24h key. */
function secretScanShaped(value: string): boolean {
  return value.length >= 20 && /[0-9]/.test(value);
}

describe('RQ-PHX-REDDESKFIXC206 merge-wait card CI fixes', () => {
  it('keeps MergeWaitCard query keys clear of the secret-scanner trigger', () => {
    const source = readFileSync(CARD, 'utf8');
    const keys = [...source.matchAll(KEY_LITERAL)].map((m) => m[1]!);
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(secretScanShaped(key), `query key ${JSON.stringify(key)} looks secret-shaped to the diff secret scan`).toBe(false);
    }
  });

  it('keeps the CODEOWNERS owner-lane entry for the new Tier-1 merge-latency test', () => {
    const owners = readFileSync(OWNERS, 'utf8');
    expect(owners).toContain('/test/verse-merge-latency-api.test.ts @masonwyatt23');
  });
});
