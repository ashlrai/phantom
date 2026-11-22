import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyChangedTests } from '../scripts/verify-changed.mjs';

/** Path-aware reader over an in-memory repo snapshot; unknown paths throw like a missing file. */
function reader(files: Record<string, string>) {
  return (path: string) => {
    for (const [name, text] of Object.entries(files)) {
      if (path === resolve(name)) return text;
    }
    throw new Error(`unexpected read: ${path}`);
  };
}

describe('emptyChangedTests', () => {
  it.each(['', '  \n\t', '// it("ignored")\n/* describe("ignored") */'])('rejects empty or comment-only text', (text) => {
    const path = 'test/empty.test.ts';
    expect(emptyChangedTests([path], (actual: string) => {
      expect(actual).toBe(resolve(path));
      return text;
    })).toEqual([path]);
  });

  it.each(['it("works", () => {})', 'describe.skip("later", () => {})'])('accepts a declaration', (text) => {
    expect(emptyChangedTests(['test/real.test.ts'], () => text)).toEqual([]);
  });

  it('ignores non-test files without reading them', () => {
    expect(emptyChangedTests(['src/example.ts'], () => { throw new Error('unexpected read'); })).toEqual([]);
  });

  it('does not report read errors as empty', () => {
    expect(emptyChangedTests(['test/unreadable.test.ts'], () => { throw new Error('unreadable'); })).toEqual([]);
  });

  it('accepts an import-only wrapper whose target declares tests', () => {
    const files = {
      'test/wrapper.test.ts': "import '../src/suite.test.js';\n",
      'src/suite.test.ts': 'it("works", () => {});\n',
    };
    expect(emptyChangedTests(['test/wrapper.test.ts'], reader(files))).toEqual([]);
  });

  it('accepts a wrapper chain and re-export or dynamic registration', () => {
    const files = {
      'test/outer.test.ts': "import './inner.test.js';\n",
      'test/inner.test.ts': "export * from '../src/suite.test.js';\n",
      'src/suite.test.ts': 'describe("s", () => { it("w", () => {}); });\n',
      'test/dynamic.test.ts': "await import('../src/suite.test.js');\n",
    };
    expect(emptyChangedTests(['test/outer.test.ts', 'test/dynamic.test.ts'], reader(files))).toEqual([]);
  });

  it('rejects a wrapper whose imports never reach a declaration', () => {
    const files = {
      'test/wrapper.test.ts': "import '../src/helper.js';\nimport './missing.test.js';\n",
      'src/helper.ts': 'export const value = 1;\n',
    };
    expect(emptyChangedTests(['test/wrapper.test.ts'], reader(files))).toEqual(['test/wrapper.test.ts']);
  });

  it('rejects type-only and cyclic imports that cannot register tests', () => {
    const files = {
      'test/typed.test.ts': "import type { T } from '../src/typed.test.js';\n",
      'src/typed.test.ts': 'it("works", () => {});\nexport type T = number;\n',
      'test/a.test.ts': "import './b.test.js';\n",
      'test/b.test.ts': "import './a.test.js';\n",
    };
    expect(emptyChangedTests(['test/typed.test.ts', 'test/a.test.ts'], reader(files)))
      .toEqual(['test/typed.test.ts', 'test/a.test.ts']);
  });
});
