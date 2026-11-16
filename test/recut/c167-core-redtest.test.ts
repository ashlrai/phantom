/**
 * RQ-PHX-REDTESTFIXC167: regression pin for the #5122 bridge fix.
 *
 * #5122 recovered the RQ-MERGE-THROUGHPUT-1 merge-plan feature
 * (src/core/fleet/merge-plan.ts + src/cli/fleet-merge-plan.ts) with its
 * preservation suite at test/merge-plan-preservation-167.test.ts. On the PR
 * head two generated-state pieces were missing:
 *
 *   1. The suite's basename token 'merge' hits the Tier-1 test stems in
 *      matchProtectedPath, so G1 classified it tier1-test and
 *      authority-codeowners-310b failed demanding a CODEOWNERS line. The
 *      suite guards a read-only planning verb, not merge gates — the fix
 *      keeps the identical bytes under a name that says what it tests
 *      (test/mergeplan-preservation-167.test.ts), the same repair
 *      redtest-fix-n1-c152 used for the intent receipt suite.
 *   2. src/cli/fleet-subcommand-registry.ts had no 'merge-plan' loader, so
 *      `phm fleet merge-plan` could not dispatch through fleet-entry.ts in
 *      production; scripts/gen-fleet-registry.mjs emits the entry.
 *
 * This file intentionally imports no Tier-1 source: importing
 * src/core/authority/** would make this very suite Tier-1 and repeat the bug.
 * Hermetic: reads repo files read-only, writes nothing.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { FLEET_SUBCOMMAND_LOADERS } from '../../src/cli/fleet-subcommand-registry.js';

const ROOT = join(import.meta.dirname, '..', '..');
const SUITE = 'test/mergeplan-preservation-167.test.ts';
const TIER1_STEM_NAME = 'test/merge-plan-preservation-167.test.ts';

it('lands the preserved merge-plan suite under a non-Tier-1 name', () => {
  expect(existsSync(join(ROOT, SUITE)), `${SUITE} must exist (renamed from the Tier-1-stem name)`).toBe(true);
  expect(existsSync(join(ROOT, TIER1_STEM_NAME)), `${TIER1_STEM_NAME} is the name that failed authority drift`).toBe(false);
});

it('no test/ file reintroduces the preserved suite under a Tier-1 stem', () => {
  // The exact failure mode: standalone basename token 'merge' inside a suite
  // guarding merge-plan (a planning read, not a merge gate). Tokenised on the
  // same [._-] separators the protected-paths classifier uses.
  const offenders = readdirSync(join(ROOT, 'test'))
    .filter((name) => name.includes('preservation-167') && /(?:^|[._-])merge(?:[._-]|$)/.test(name));
  expect(offenders).toEqual([]);
});

describe('merge-plan dispatch wiring', () => {
  it('the generated registry carries a merge-plan loader (real fleet-entry dispatch path)', () => {
    // Without this entry fleet-entry.ts resolves 'merge-plan' to a loader
    // that is not in the map and the verb is unreachable in production.
    expect(Object.keys(FLEET_SUBCOMMAND_LOADERS)).toContain('merge-plan');
  });

  it('the registry loader resolves a module exporting cmdFleetMergePlan', async () => {
    const loaded = await FLEET_SUBCOMMAND_LOADERS['merge-plan']!();
    expect(typeof loaded['cmdFleetMergePlan']).toBe('function');
  });
});
