import { describe, expect, it } from 'vitest';
// @ts-expect-error Standalone audit script has no declaration output.
import { auditFleetImports } from '../scripts/audit-fleet-imports.mjs';

describe('fleet import audit', () => {
  it('counts static, type-only, re-export, dynamic and CommonJS production edges', () => {
    const files: Record<string, string> = {};
    const forms = [
      "import './fleet/static.js'", "import type { T } from './fleet/types.js'",
      "export * from './fleet/exported.js'", "import('./fleet/dynamic.js')",
      "require('./fleet/required.js')", "import x = require('./fleet/equals.js')",
      "import './fleet/directory'", "type T = import('./fleet/import-type.js').T",
    ];
    for (const name of ['static', 'types', 'exported', 'dynamic', 'required', 'equals', 'directory/index', 'import-type']) {
      files[`src/core/fleet/${name}.ts`] = 'export {}';
    }
    files['src/core/consumer.ts'] = forms.join(';\n');
    expect(auditFleetImports(files).candidates).toEqual([]);
  });

  it('reports test-only imports and prose/source-reading references without treating them as production', () => {
    expect(auditFleetImports({
      'src/core/fleet/unused.ts': 'export {}',
      'test/unused.test.ts': "import '../src/core/fleet/unused.js'",
      'test/source.test.ts': "readFileSync('src/core/fleet/unused.ts')",
      'docs/guide.md': 'Keep unused.ts for the documented workflow.',
      'src/core/consumer.ts': "// import './fleet/unused.js'",
    }).candidates).toEqual([{
      file: 'src/core/fleet/unused.ts', productionImporters: [],
      importers: ['test/unused.test.ts'],
      references: ['docs/guide.md', 'src/core/consumer.ts', 'test/source.test.ts', 'test/unused.test.ts'],
    }]);
  });

  it('surfaces computed imports for manual review and handles cycles conservatively', () => {
    const result = auditFleetImports({
      'src/core/fleet/a.ts': "import './b.js'",
      'src/core/fleet/b.ts': "import './a.js'",
      'src/core/consumer.ts': 'import(modulePath); require(modulePath)',
    });
    expect(result.candidates).toEqual([]);
    expect(result.unresolvedDynamicImports).toEqual(['src/core/consumer.ts']);
  });
});
