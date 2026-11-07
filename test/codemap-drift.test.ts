import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const map = readFileSync('docs/CODEMAP.md', 'utf8');

describe('source code map', () => {
  for (const [section, directory] of [['src', 'src'], ['core', 'src/core']] as const) {
    it(`tracks ${directory} directories`, () => {
      const start = `<!-- codemap:${section}:start -->`;
      const end = `<!-- codemap:${section}:end -->`;
      expect(map.split(start)).toHaveLength(2);
      expect(map.split(end)).toHaveLength(2);
      const inventory = map.split(start)[1]!.split(end)[0]!.trim();
      const directories = readdirSync(directory, { withFileTypes: true })
        .filter(entry => entry.isDirectory())
        .map(entry => entry.name)
        .sort()
        .map(name => `- \`${directory}/${name}/\``);
      expect(inventory.split('\n')).toEqual(directories);
    });
  }
});
