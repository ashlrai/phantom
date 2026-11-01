/**
 * test/universe-site-dep-floor-31.test.ts — Dependabot floor sentinel for
 * examples/universe-site/package-lock.json.
 *
 * Reads the lockfile and asserts every installed instance of the four
 * packages named in the high-severity Dependabot alerts meets its patched
 * floor:
 *   @modelcontextprotocol/sdk >= 1.32.0
 *     (GHSA-22jm-h49p-29qw, GHSA-46jr-4wx8-v453 high; GHSA-6prh-2h8m-c8cw,
 *     GHSA-rvq5-wwqv-78pq moderate — all range <1.32.0)
 *   body-parser >= 2.4.0          (GHSA-27r3-jxmh-p828, <2.4.0)
 *   systeminformation >= 5.33.16  (GHSA-3f7j-7jwc-fxfj high; GHSA-4vjg-vx72-qq4g,
 *     GHSA-7648-jmwf-vw7j — all <5.33.16)
 *   undici >= 7.30.1              (GHSA-4qv8-2p9j-2685, GHSA-f72v-6w45-q472,
 *     GHSA-xjj6-f33q-929c, GHSA-4w7w-5xrc-9h26, GHSA-2m5v-pch6-74hx,
 *     GHSA-qrxm-fqhp-jwvm, GHSA-9fm3-97px-rjf6, GHSA-55wc-3pg8-jfw6 —
 *     all range <7.30.1)
 *   vite >= 8.2.4                 (Dependabot alert 72, high; range <8.2.4)
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const LOCKFILE = resolve(__dirname, '../examples/universe-site/package-lock.json');

const FLOORS: ReadonlyArray<readonly [string, string]> = [
  ['@modelcontextprotocol/sdk', '1.32.0'],
  ['body-parser', '2.4.0'],
  ['systeminformation', '5.33.16'],
  ['undici', '7.30.1'],
  ['vite', '8.2.4'],
];

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

describe('universe-site-dep-floor-31', () => {
  const lock = JSON.parse(readFileSync(LOCKFILE, 'utf8')) as {
    packages: Record<string, { version?: string }>;
  };

  for (const [name, floor] of FLOORS) {
    it(`${name} resolves at or above ${floor} everywhere it is installed`, () => {
      const entries = Object.entries(lock.packages).filter(([key]) =>
        key.endsWith(`node_modules/${name}`),
      );
      expect(entries.length, `${name} should appear in the lockfile`).toBeGreaterThan(0);
      for (const [key, pkg] of entries) {
        expect(
          pkg.version !== undefined && compareVersions(pkg.version, floor) >= 0,
          `${key} resolves ${name}@${pkg.version ?? 'unknown'}, below floor ${floor}`,
        ).toBe(true);
      }
    });
  }
});
