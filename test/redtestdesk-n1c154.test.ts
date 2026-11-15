/**
 * RQ-PHX-REDTESTDESKN1C154: regression for the #5067 recut.
 *
 * #5067 adds src/core/usage/spend.ts and a `GET /api/usage/spend` route in
 * src/core/web/api.ts (a Tier-1 closure member) plus `phm usage spend` in
 * src/cli/usage.ts. The literal `await import('../usage/spend.js')` in api.ts
 * pulls spend.ts — and through its `import { PACE_POOLS } from './pace.js'`
 * also pace.ts — into the Tier-1 authority runtime import closure. Until the
 * snapshot is regenerated, test/authority-tier1-closure-310b.test.ts fails in
 * the Quick typecheck "Check authority drift (hermetic)" step — the only real
 * red check on the PR. This pins the regenerated members so the growth stays
 * reviewed and visible.
 *
 * This file deliberately avoids importing Tier-1 source and Tier-1 name
 * stems so it stays outside the owner lane itself.
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

const JOINED = ['src/core/usage/pace.ts', 'src/core/usage/spend.ts'] as const;

describe('Tier-1 closure snapshot covers the #5067 usage-spend edge', () => {
  it.each([...JOINED])('lists %s in the reviewed closure', (file) => {
    expect(SNAPSHOT.closure).toContain(file);
  });

  it('keeps the closure sorted and unique so the diff stays reviewable', () => {
    expect([...SNAPSHOT.closure].sort()).toEqual(SNAPSHOT.closure);
    expect(new Set(SNAPSHOT.closure).size).toBe(SNAPSHOT.closure.length);
  });
});
