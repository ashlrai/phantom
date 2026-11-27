import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error Standalone documentation checker has no declaration output.
import { checkDocumentation } from '../scripts/check-documentation.mjs';

const root = resolve(import.meta.dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('PR #9859 contributor welcome preservation', () => {
  it('keeps conduct, starter issue searches and community links alongside current setup', () => {
    const guide = read('CONTRIBUTING.md');
    expect(guide).toMatch(/^# Contributing to Phantom\n/);
    const welcome = guide.split('**New to the project?**')[1]?.split('\n---')[0] ?? '';
    expect(welcome).toContain('contributors and agents alike');
    expect(welcome).toContain('[Code of Conduct](CODE_OF_CONDUCT.md)');
    expect(existsSync(resolve(root, 'CODE_OF_CONDUCT.md'))).toBe(true);
    expect(read('CODE_OF_CONDUCT.md')).toMatch(/^# Code of Conduct\n/);
    for (const label of ['good first issue', 'help wanted']) {
      const match = [...welcome.matchAll(/\]\((https:\/\/github\.com\/[^)]+)\)/g)]
        .map((entry) => new URL(entry[1]))
        .find((url) => url.searchParams.get('q')?.includes(`label:"${label}"`));
      expect(match?.pathname).toBe('/ashlrai/phantom/issues');
      expect(match?.searchParams.get('q')).toBe(`is:issue is:open label:"${label}"`);
    }
    expect(welcome).toContain('[The Dev Shack](https://discord.gg/jBQrSU6XeD)');
    expect(guide).toContain('gh auth login');
    expect(guide).toContain('gh repo fork ashlrai/phantom --clone=false');
    expect(guide).toContain('JSONC-tolerant');
  });

  it('resolves the carried guide’s local links and retains the root agent index title', () => {
    const result = checkDocumentation({ root, mode: 'source', entrypoints: ['CONTRIBUTING.md'] });
    expect(result.errors).toEqual([]);
    expect(result.localLinks).toBeGreaterThan(0);
    expect(result.externalRequests).toBe(0);
    expect(read('llms.txt').startsWith('# Phantom\n')).toBe(true);
  });
});
