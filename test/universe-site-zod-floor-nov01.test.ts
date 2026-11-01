/**
 * test/universe-site-zod-floor-nov01.test.ts — Dependabot floor sentinel for
 * zod in examples/universe-site/package-lock.json.
 *
 * Reads the lockfile and asserts every installed instance of zod — including
 * copies nested under another package's node_modules — meets the patched
 * floor for Dependabot alert 93:
 *   zod >= 4.6.6  (vulnerable range <4.6.6)
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const LOCKFILE = resolve(__dirname, '../examples/universe-site/package-lock.json');

const FLOOR = '4.6.6';

function versionParts(version: string): number[] {
  const parts = version.split('-')[0]!.split('.').map((segment) => Number.parseInt(segment, 10));
  if (parts.some((part) => Number.isNaN(part))) {
    throw new Error(`Unparseable version: ${version}`);
  }
  return parts;
}

function compareVersions(a: string, b: string): number {
  const pa = versionParts(a);
  const pb = versionParts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

describe('universe-site-zod-floor-nov01', () => {
  const lock = JSON.parse(readFileSync(LOCKFILE, 'utf8')) as {
    packages: Record<string, { version?: string }>;
  };

  it(`zod resolves at or above ${FLOOR} everywhere it is installed`, () => {
    const entries = Object.entries(lock.packages).filter(([key]) =>
      key.endsWith('node_modules/zod'),
    );
    expect(entries.length, 'zod should appear in the lockfile').toBeGreaterThan(0);
    for (const [key, pkg] of entries) {
      expect(
        pkg.version !== undefined && compareVersions(pkg.version, FLOOR) >= 0,
        `${key} resolves zod@${pkg.version ?? 'unknown'}, below floor ${FLOOR}`,
      ).toBe(true);
    }
  });
});
