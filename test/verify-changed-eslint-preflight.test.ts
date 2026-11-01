import { describe, expect, it } from 'vitest';
import { eslintPreflight } from '../scripts/verify-changed.mjs';

describe('eslintPreflight preflight check', () => {
  it('returns ok false when only bin/eslint.js is present, naming lib/cli.js', () => {
    const stubExists = (path: string) => path.includes('node_modules/eslint/bin/eslint.js');
    const result = eslintPreflight('/fake/root', stubExists as unknown as typeof import('node:fs').existsSync);
    expect(result.ok).toBe(false);
    expect(result).toHaveProperty('reason');
    expect(result.reason).toContain('node_modules/eslint/lib/cli.js');
  });

  it('returns ok true when both bin/eslint.js and lib/cli.js are present', () => {
    const stubExists = () => true;
    const result = eslintPreflight('/fake/root', stubExists as unknown as typeof import('node:fs').existsSync);
    expect(result.ok).toBe(true);
  });

  it('returns ok false when bin/eslint.js is absent, naming node_modules/eslint/bin/eslint.js', () => {
    const stubExists = (path: string) => path.includes('node_modules/eslint/lib/cli.js');
    const result = eslintPreflight('/fake/root', stubExists as unknown as typeof import('node:fs').existsSync);
    expect(result.ok).toBe(false);
    expect(result).toHaveProperty('reason');
    expect(result.reason).toContain('node_modules/eslint/bin/eslint.js');
  });
});
