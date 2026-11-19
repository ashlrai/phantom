/**
 * RQ-PHX-REDTESTDESKN1C154: regression for the #5067 recut.
 *
 * #5067 adds src/core/usage/spend.ts and a `GET /api/usage/spend` route in
 * src/core/web/api.ts plus `phm usage spend` in src/cli/usage.ts. The literal
 * `await import('../usage/spend.js')` in api.ts pulled spend.ts — and through
 * its `import { PACE_POOLS } from './pace.js'` also pace.ts — into the Tier-1
 * authority runtime import closure, and the snapshot was regenerated to pin
 * them as reviewed members.
 *
 * That edge has since been reviewed OUT: src/core/web/api.ts left the closure
 * (it is not a Tier-1 source path and nothing in the closure imports it), so
 * later regenerations dropped spend.ts and pace.ts from the snapshot. This
 * file now pins the reviewed removal instead:
 * if either file rejoins the snapshot the test fails and the growth must be
 * reviewed again — the same tripwire, inverted. It deliberately avoids
 * importing Tier-1 source and Tier-1 name stems so it stays outside the
 * owner lane itself.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

interface ClosureSnapshot {
  v: 1;
  note: string;
  roots: string[];
  closure: string[];
}

const SNAPSHOT = JSON.parse(
  readFileSync(join(import.meta.dirname, 'fixtures', 'authority', 'tier1-closure.json'), 'utf8'),
) as ClosureSnapshot;

const REMOVED = ['src/core/usage/pace.ts', 'src/core/usage/spend.ts'] as const;

describe('Tier-1 closure snapshot covers the reviewed-out #5067 usage-spend edge', () => {
  it.each([...REMOVED])('does not list %s in the reviewed closure', (file) => {
    expect(SNAPSHOT.closure).not.toContain(file);
  });

  it('keeps the closure sorted and unique so the diff stays reviewable', () => {
    expect([...SNAPSHOT.closure].sort()).toEqual(SNAPSHOT.closure);
    expect(new Set(SNAPSHOT.closure).size).toBe(SNAPSHOT.closure.length);
  });
});
