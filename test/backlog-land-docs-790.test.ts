import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error Standalone documentation scripts have no declaration output.
import { checkDocumentation } from '../scripts/check-documentation.mjs';
import { docsSync } from '../scripts/docs-sync.mjs';

const root = resolve(import.meta.dirname, '..');
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');

describe('PR #7566 shared type documentation preservation', () => {
  it('distinguishes the public entry point from the owning declarations', () => {
    const contract = read('CONTRACT.md');
    expect(contract).toContain('The canonical types are exported from **`src/core/types.ts`**');
    expect(contract).toContain('the declarations live by domain in `src/core/types/`');
    expect(contract).toContain('read `src/core/types/config.ts` and');
    expect(read('docs/CODEMAP.md')).toContain('`src/core/types.ts` (entry point) and `src/core/types/` (declarations)');
    for (const [domain, name] of [['config', 'AshlrConfig'], ['engines', 'EngineSpec']]) {
      expect(read(`src/core/types/${domain}.ts`)).toContain(`export interface ${name}`);
      expect(read('src/core/types.ts')).toContain(`export type * from './types/${domain}.js'`);
    }
    expect(existsSync(resolve(root, 'src/core/types/run.ts'))).toBe(true);
    expect(read('CONTRIBUTING.md')).toContain('Edit the domain module, not the barrel.');
    expect(read('docs/ARCHITECTURE.md')).toContain('re-exports the shared types declared by domain');
    expect(read('llms.txt')).toMatch(/^# Phantom\n/);
    expect(checkDocumentation({
      root, mode: 'source', entrypoints: ['CONTRACT.md', 'docs/CODEMAP.md'],
    }).errors).toEqual([]);
  });

  it('keeps the generated documentation clean after the hand merge', () => {
    const report = docsSync(root, { check: true, external: false });
    expect(report.surfaces.filter((surface) => surface.status !== 'clean')).toEqual([]);
    expect(report.ok).toBe(true);
  }, 60_000);
});
