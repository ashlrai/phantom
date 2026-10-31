import { describe, expect, it } from 'vitest';

import { checkedCitation, citationLink, collectCitations, parseCitationHref, verifyCitations } from '../src/core/knowledge/wiki/citations.js';
import type { WikiCitation } from '../src/core/knowledge/wiki/types.js';

describe('citation href validation', () => {
  it.each([
    '../outside.ts', 'src/../outside.ts', './src/a.ts', 'src/./a.ts', '/src/a.ts',
    '%2e%2e/outside.ts', 'src/%2E%2e/outside.ts', 'src%2f..%2Foutside.ts',
    '%2fsrc/a.ts', 'src/%2e/a.ts',
    'C:/outside.ts', 'C:outside.ts', 'C%3A/outside.ts',
    'src\\a.ts', 'C:\\outside.ts', '\\\\server\\share.ts', '%5c%5cserver%5cshare.ts',
    'src/%00a.ts', 'src/%0Aa.ts', 'src/%1fa.ts', 'src/%7fa.ts', 'src/%C2%85a.ts',
    'src/\u0000a.ts', 'src/\ta.ts', 'src/\u007fa.ts',
    'src/%', 'src/%2', 'src/%GG', 'src/%C0%AF', 'src/%E2%82',
  ])('rejects unsafe or malformed path %j', (file) => {
    expect(parseCitationHref(`#cite:${file}:1`)).toBeNull();
  });

  it.each(['0', '0-1', '1-0', '10-9', '9999999-1', '10000000', '1-10000000'])(
    'rejects invalid explicit span %s', (span) => {
      expect(parseCitationHref(`#cite:src/a.ts:${span}`)).toBeNull();
    },
  );

  it.each([
    ['#cite:src/a.ts:1', { file: 'src/a.ts', line: 1 }],
    ['#cite:src/a.ts:2-4', { file: 'src/a.ts', line: 2, endLine: 4 }],
    ['#cite:src/a.ts:2-2', { file: 'src/a.ts', line: 2 }],
    ['#cite:src/a.ts:9999998-9999999', { file: 'src/a.ts', line: 9999998, endLine: 9999999 }],
    ['#cite:docs/a%20b%20%28draft%29.md:3', { file: 'docs/a b (draft).md', line: 3 }],
    ['#cite:docs/%e6%96%87%e6%a1%a3%2f%28x%29.md:1', { file: 'docs/文档/(x).md', line: 1 }],
  ])('parses a valid href %s', (href, citation) => {
    expect(parseCitationHref(href)).toEqual(citation);
  });

  it.each<WikiCitation>([
    { file: 'docs/a b (draft).md', line: 2 },
    { file: 'docs/文档 (résumé).md', line: 3, endLine: 5 },
    { file: 'docs/literal%2Fname.md', line: 1 },
    { file: 'src/a.ts', line: 9999999 },
  ])('round-trips a canonical link for $file', (citation) => {
    const link = citationLink(citation);
    const href = /\]\(([^)]+)\)$/.exec(link)?.[1];
    expect(href).toBeDefined();
    expect(parseCitationHref(href!)).toEqual(citation);
    expect(collectCitations(link)).toEqual([citation]);
  });

  it('uses the same decoded path restrictions as checked citations', () => {
    for (const file of ['C:/a.ts', 'src/./a.ts', 'src/../a.ts', 'src\\a.ts', 'src/\u0000a.ts', 'src/\u007fa.ts']) {
      expect(checkedCitation({ file, line: 1 }, 2)).toBeNull();
      expect(parseCitationHref(`#cite:${encodeURI(file)}:1`)).toBeNull();
    }
  });

  it('drops malformed canonical citations without consulting the resolver', async () => {
    const calls: string[] = [];
    const result = await verifyCitations('[bad](#cite:src%2f..%2foutside.ts:1) [range](#cite:src/a.ts:5-2)', {
      files: [], lines: (file) => { calls.push(file); return 10; },
    });
    expect(calls).toEqual([]);
    expect(result.citations).toEqual([]);
    expect(result.dropped).toBe(2);
  });
});
