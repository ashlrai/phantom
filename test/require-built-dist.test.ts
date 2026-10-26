import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { requiresBuiltDist } from '../.github/scripts/select-docs-markdown-tests.mjs';
import { requireBuiltDist } from './helpers/require-built-dist.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('requireBuiltDist', () => {
  it('names every missing build path and says to run npm run build first', () => {
    const root = mkdtempSync(join(tmpdir(), 'ashlr-require-dist-'));
    roots.push(root);
    expect(() => requireBuiltDist(['dist/cli/index.js', 'dist/core/web/public/app.js'], root)).toThrow(
      /^missing dist\/cli\/index\.js, dist\/core\/web\/public\/app\.js; run npm run build first$/,
    );
  });

  it('returns when every requested build path exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'ashlr-require-dist-'));
    roots.push(root);
    mkdirSync(join(root, 'dist', 'cli'), { recursive: true });
    expect(() => requireBuiltDist(['dist', 'dist/cli'], root)).not.toThrow();
  });
});

describe('docs lane built-dist marker', () => {
  it('matches an import of the helper and ignores a bare call', () => {
    const imported = "import { requireBuiltDist } from './helpers/require-built-dist.js';";
    expect(requiresBuiltDist(imported)).toBe(true);
    expect(requiresBuiltDist('requireBuiltDist(["dist"])')).toBe(false);
  });
});
