import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error Standalone documentation checker has no declaration output.
import { checkDocumentation } from '../scripts/check-documentation.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const documents = ['CONTRIBUTING.md', 'docs/CONTRIBUTE-WITH-AN-AGENT.md'];
const read = (path: string): string => readFileSync(resolve(root, path), 'utf8');

describe('PR #7404 changelog guidance preservation', () => {
  it('explains omitted subjects and links the short guide to commit conventions', () => {
    expect(read('CONTRIBUTING.md')).toContain('A subject without a recognized type is left out of the changelog.');
    expect(read('docs/CONTRIBUTE-WITH-AN-AGENT.md')).toContain(
      '[Commit style](https://github.com/ashlrai/phantom/blob/master/CONTRIBUTING.md#commit-style)',
    );
    const config = JSON.parse(read('release-please-config.json')) as {
      'changelog-sections': Array<{ type: string; hidden: boolean }>;
    };
    for (const section of config['changelog-sections'].filter((section) => !section.hidden)) {
      expect(read('CONTRIBUTING.md')).toContain('`' + section.type + '`');
    }
  });

  it('keeps both carried documents and resolves every relative Markdown link', () => {
    for (const document of documents) {
      const path = resolve(root, document);
      expect(existsSync(path), document).toBe(true);
      const links = [...read(document).matchAll(/\[[^\]]*\]\(([^)]+)\)/g)]
        .map((match) => match[1]!)
        .filter((link) => !/^[a-z][a-z\d+.-]*:/i.test(link));
      expect(links.length, document).toBeGreaterThan(0);
      for (const link of links) {
        const target = decodeURIComponent(link.split('#')[0]!);
        expect(existsSync(resolve(dirname(path), target)), document + ': ' + link).toBe(true);
      }
    }
    const report = checkDocumentation({ root, mode: 'source', entrypoints: documents });
    expect(report.errors).toEqual([]);
  });
});
