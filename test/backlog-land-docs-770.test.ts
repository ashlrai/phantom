import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error Standalone documentation checker has no declaration output.
import { checkDocumentation } from '../scripts/check-documentation.mjs';

const root = resolve(__dirname, '..');
const read = (path: string) => readFileSync(resolve(root, path), 'utf8');

describe('PR #7289 contributor update guidance preservation', () => {
  it('keeps document regeneration and conflicting-PR recovery in the contributor guide', () => {
    expect(existsSync(resolve(root, 'CONTRIBUTING.md'))).toBe(true);
    const section = read('CONTRIBUTING.md').split('### Updating a pull request\n')[1]?.split('\n---\n')[0] ?? '';
    expect(section).toContain('exact checks you ran and any checks you could not complete');
    expect(section).toContain('add or rename a document under `docs/`');
    expect(section).toContain('`node scripts/generate-docs-llms.mjs` and include its output');
    expect(section).toContain('rebase onto `origin/master`');
    expect(section).toContain('rerun the local checks and update the pull request from your fork');
  });

  it('resolves contributor links and retains package-safe source links in the docs index', () => {
    const result = checkDocumentation({ root, mode: 'source', entrypoints: ['CONTRIBUTING.md', 'docs/README.md'] });
    expect(result.errors).toEqual([]);
    expect(result.sourceLinks).toBeGreaterThan(0);
    // Existing packaged local guides may be relative. Source-only guides,
    // including any future index additions, must use absolute GitHub links.
    const links = [...read('docs/README.md').matchAll(/\[[^\]]+\]\(([^)]+)\)/g)].map((match) => match[1]);
    const sourceLinks = links.filter((link) => link.includes('/blob/master/docs/'));
    expect(sourceLinks.length).toBeGreaterThan(0);
    for (const link of sourceLinks) expect(link).toMatch(/^https:\/\/github\.com\/ashlrai\/phantom\/blob\/master\/docs\//);
    expect(read('llms.txt').startsWith('# Phantom\n')).toBe(true);
  });
});
