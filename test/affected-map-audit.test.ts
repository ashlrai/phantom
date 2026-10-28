import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { audit, compare } from '../scripts/audit-affected-map.mjs';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(entries: Record<string, string>) {
  const root = mkdtempSync(join(tmpdir(), 'affected-map-'));
  roots.push(root);
  for (const [name, content] of Object.entries(entries)) {
    const file = join(root, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return root;
}

describe('affected map audit', () => {
  it('finds direct static imports and reports unmapped sources and orphan tests', () => {
    const root = fixture({
      'src/a.ts': 'export const a = 1;',
      'src/nested/index.ts': 'export const b = 2;',
      'src/missing.ts': '',
      'test/a.test.ts': "import { a } from '../src/a.js'; export { b } from '../src/nested'; void a;",
      'test/orphan.test.ts': "import 'node:fs'; // import '../src/missing.js'",
      'src/web/example.test.tsx': "const load = () => import('../a.js'); void load;",
    });
    expect(audit(root)).toEqual({ unmappedSources: ['src/missing.ts'], orphanTests: ['test/orphan.test.ts'] });
  });

  it('reports gaps and exits nonzero only for new ones', () => {
    const root = fixture({
      'src/a.ts': '',
      'ci/affected-map.json': JSON.stringify({ unmappedSources: [], orphanTests: [] }),
    });
    const command = () => spawnSync(process.execPath, ['scripts/audit-affected-map.mjs', root], { encoding: 'utf8' });
    const first = command();
    expect(first.status).toBe(1);
    expect(first.stdout).toContain('+ src/a.ts');
    writeFileSync(join(root, 'ci/affected-map.json'), JSON.stringify({ unmappedSources: ['src/a.ts'], orphanTests: [] }));
    const second = command();
    expect(second.status).toBe(0);
    expect(second.stdout).toContain('src/a.ts');
  });

  it('fails only on gaps absent from the baseline and rejects malformed baselines', () => {
    const current = { unmappedSources: ['src/a.ts', 'src/new.ts'], orphanTests: ['test/a.test.ts'] };
    expect(compare(current, { unmappedSources: ['src/a.ts', 'src/deleted.ts'], orphanTests: ['test/a.test.ts'] }))
      .toEqual({ unmappedSources: ['src/new.ts'], orphanTests: [] });
    expect(() => compare(current, { unmappedSources: [], orphanTests: 'bad' })).toThrow('Invalid baseline');
  });
});
