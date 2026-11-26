/**
 * RQ-PHX-REDDESKFIXCL211 — regression pin for PR #5272's /api/ideas module
 * and its Tier-1 authority closure status.
 *
 * PR #5272 added src/core/fleet/ideas.ts (the reader behind GET /api/ideas)
 * while src/core/web/api.ts was still in the Tier-1 closure. PR #6737 later
 * decoupled HTTP API handlers from Tier-1 roots, removing src/core/web/api.ts
 * and src/core/fleet/ideas.ts from test/fixtures/authority/tier1-closure.json.
 * Pin that ideas.ts exists and stays out of the Tier-1 closure alongside api.ts.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';

const SNAPSHOT = 'test/fixtures/authority/tier1-closure.json';
const MODULE = 'src/core/fleet/ideas.ts';
const WEB_API = 'src/core/web/api.ts';

it('keeps /api/ideas and the HTTP API module out of the Tier-1 closure snapshot', () => {
  const root = process.cwd();
  expect(existsSync(resolve(root, MODULE))).toBe(true);
  const snapshot = JSON.parse(readFileSync(resolve(root, SNAPSHOT), 'utf8')) as { closure: string[] };
  expect(snapshot.closure).not.toContain(WEB_API);
  expect(snapshot.closure).not.toContain(MODULE);
});
