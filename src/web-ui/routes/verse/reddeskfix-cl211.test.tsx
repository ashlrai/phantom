/**
 * RQ-PHX-REDDESKFIXCL211 — regression pin for PR #5272's red Quick typecheck.
 *
 * The PR added src/core/fleet/ideas.ts — the reader behind GET /api/ideas,
 * which feeds the new NextIdeas card in the Ideas pane — but did not
 * regenerate the Tier-1 authority closure snapshot. src/core/web/api.ts is
 * already inside the closure, so its literal dynamic import made ideas.ts a
 * new authority member and test/authority-tier1-closure-310b.test.ts failed
 * with "These files joined the Tier-1 authority import closure:
 * src/core/fleet/ideas.ts".
 *
 * Fails on the PR's original code (snapshot lacks the module); passes once
 * the reviewed snapshot update travels with the feature.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

const SNAPSHOT = 'test/fixtures/authority/tier1-closure.json';
const MODULE = 'src/core/fleet/ideas.ts';

it('ships the Tier-1 closure snapshot update for the /api/ideas module', () => {
  const root = process.cwd();
  expect(existsSync(resolve(root, MODULE))).toBe(true);
  const snapshot = JSON.parse(readFileSync(resolve(root, SNAPSHOT), 'utf8')) as { closure: string[] };
  expect(snapshot.closure).toContain(MODULE);
});
