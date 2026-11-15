import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { emptyChangedTests } from '../scripts/verify-changed.mjs';

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
});
