import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const read = (path: string) => readFileSync(path, 'utf8');

describe('type entry point documentation', () => {
  it('points to the real barrel and domain declarations', () => {
    const barrel = read('src/core/types.ts');
    for (const domain of ['config', 'engines', 'run']) {
      expect(barrel).toContain(`export type * from './types/${domain}.js'`);
      expect(read(`src/core/types/${domain}.ts`)).toMatch(/export (?:interface|type|enum) /);
    }
    expect(read('src/core/types/config.ts')).toMatch(/export interface AshlrConfig\b/);
    expect(barrel).not.toMatch(/(?:interface|type) AshlrConfig\b/);
    const contract = read('CONTRACT.md');
    expect(contract).toContain('canonical types are exported from **`src/core/types.ts`**');
    expect(contract).toContain('declarations live by domain in `src/core/types/`');
    expect(contract).toContain('(for example `config.ts`, `engines.ts`, `run.ts`)');
    expect(contract).toContain('read `src/core/types/config.ts` and');
    expect(contract).toContain('[`schema/config.schema.json`](schema/config.schema.json) for the full shape');
    expect(contract).toContain('Every module named below is implemented');
    expect(contract).toContain('`models` / `telemetry` gained optional keys');
    const row = read('docs/CODEMAP.md').split('\n').find(line => line.startsWith('| Configuration, shared types, disk state |'));
    expect(row).toContain('`src/core/types.ts` (entry point)');
    expect(row).toContain('`src/core/types/` (declarations)');
    expect(row).toContain('`src/core/config.ts`');
    expect(row).toContain('`schema/`');
    expect(row).toContain('ARCHITECTURE.md#the-ashlr-home-layout');
  });
});
