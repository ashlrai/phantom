import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const read = (name: string) => readFileSync(resolve(process.cwd(), 'docs', name), 'utf8');

describe('package history in operator guides', () => {
  for (const name of ['ASHLR-UNIVERSE.md', 'VERSE.md']) {
    it(`${name} distinguishes the historical rename from release evidence`, () => {
      const intro = read(name).split('\n\n').slice(0, 6).join('\n\n');
      expect(intro).toMatch(/canonical 3\.26\.0[\s\S]*@ashlr\/phantom|@ashlr\/phantom[\s\S]*canonical 3\.26\.0/);
      expect(intro).toContain('@ashlr/phantom/universe');
      expect(intro).toMatch(/(?:3\.25\.3 compatibility release|compatibility release is 3\.25\.3)[\s\S]*@ashlr\/hub/);
      expect(intro).toMatch(/source\s+version in `package\.json`[\s\S]*changelog/i);
      expect(intro).toMatch(/neither proves npm promotion, desktop signing, or the installed version/i);
      expect(intro).not.toMatch(/published canonical 3\.26\.0 release|source\s+package is the published `@ashlr\/phantom@3\.26\.0`/i);
    });
  }

  it('keeps the universe SDK examples tied to the compatibility package', () => {
    expect(read('ASHLR-UNIVERSE.md')).toMatch(/`@ashlr\/hub\/universe` SDK examples explicitly target that published compatibility\s+package/);
  });
});
