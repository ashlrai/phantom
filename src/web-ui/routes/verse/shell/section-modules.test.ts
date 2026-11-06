import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REST_SECTION_MODULES } from './section-modules-rest.js';
import { SECTION_MODULE_NAMES, SECTION_MODULES, sectionImporter } from './section-modules.js';

const onDisk = readdirSync(resolve(process.cwd(), 'src/web-ui/routes/verse/sections'))
  .filter((file) => /Section\.tsx$/.test(file))
  .map((file) => file.replace(/\.tsx$/, ''))
  .sort();

describe('section modules', () => {
  it('names exactly the sections on disk (a section outside this list is unreachable)', () => {
    expect([...SECTION_MODULE_NAMES].sort()).toEqual(onDisk);
  });

  it('the lazy glob holds every named section', () => {
    expect(Object.keys(REST_SECTION_MODULES).sort()).toEqual(Object.keys(SECTION_MODULES).sort());
  });

  it('resolves a named module and nothing else', () => {
    expect(sectionImporter('ChatSection')).toBeTypeOf('function');
    expect(sectionImporter('NoSuchSection')).toBeUndefined();
  });
});
