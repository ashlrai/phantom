import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const readJson = (path: string): unknown =>
  JSON.parse(readFileSync(new URL(`../${path}`, import.meta.url), 'utf8'));

describe('minimatch audit override', () => {
  it('pins minimatch to an exact 11.x version', () => {
    const manifest = readJson('package.json') as { overrides: { minimatch: string } };
    expect(manifest.overrides.minimatch).toMatch(/^11\.\d+\.\d+$/);
  });

  it('locks every minimatch installation to at least 11.0.1', () => {
    const lock = readJson('package-lock.json') as { packages: Record<string, { version?: string }> };
    const entries = Object.entries(lock.packages).filter(([key]) => key.endsWith('node_modules/minimatch'));
    expect(entries.length).toBeGreaterThan(0);

    for (const [key, { version }] of entries) {
      const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? '');
      expect(match, `${key} has an invalid minimatch version: ${version}`).not.toBeNull();
      if (!match) continue;
      const [, major, minor, patch] = match.map(Number);
      const safe = major > 11 || (major === 11 && (minor > 0 || (minor === 0 && patch >= 1)));
      expect(safe, `${key} has vulnerable minimatch version ${version}`).toBe(true);
    }
  });
});
