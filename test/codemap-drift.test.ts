import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { CODEMAP_SECTIONS, codemapInventory } from '../scripts/codemap.mjs';

const ROOT = join(__dirname, '..');
const map = readFileSync(join(ROOT, 'docs/CODEMAP.md'), 'utf8');

describe('source code map', () => {
  for (const [section, directory] of CODEMAP_SECTIONS) {
    it(`tracks ${directory} directories`, () => {
      const start = `<!-- codemap:${section}:start -->`;
      const end = `<!-- codemap:${section}:end -->`;
      expect(map.split(start)).toHaveLength(2);
      expect(map.split(end)).toHaveLength(2);
      const inventory = map.split(start)[1]!.split(end)[0]!.trim();
      expect(
        inventory.split('\n'),
        `docs/CODEMAP.md ${section} inventory drifted; run \`node scripts/docs-sync.mjs\` or \`node scripts/codemap.mjs\``,
      ).toEqual(codemapInventory(ROOT, directory));
    });
  }
});
