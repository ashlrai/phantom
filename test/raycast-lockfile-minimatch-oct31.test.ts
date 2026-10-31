import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

describe('Raycast minimatch override', () => {
  it('pins an exact 11.x version and locks only patched minimatch versions', () => {
    const manifest = JSON.parse(readFileSync('src/raycast/package.json', 'utf8')) as {
      overrides: { minimatch: string };
    };
    expect(manifest.overrides.minimatch).toMatch(/^11\.\d+\.\d+$/);

    const lock = JSON.parse(readFileSync('src/raycast/package-lock.json', 'utf8')) as {
      packages: Record<string, { version?: string }>;
    };
    const entries = Object.entries(lock.packages).filter(([key]) => key.endsWith('node_modules/minimatch'));
    expect(entries.length).toBeGreaterThan(0);
    for (const [key, pkg] of entries) {
      const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(pkg.version ?? '');
      expect(match, `Invalid minimatch version at ${key}: ${pkg.version}`).not.toBeNull();
      if (!match) continue;
      const [major, minor, patch] = match.slice(1).map(Number);
      expect(
        major > 11 || (major === 11 && (minor > 0 || (minor === 0 && patch >= 1))),
        `Unpatched minimatch at ${key}: ${pkg.version}`,
      ).toBe(true);
    }
  });
});
