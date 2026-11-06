/**
 * docs/SELF-HOSTING.md — the self-hosting guide must stay navigable:
 * every relative link in it resolves (file exists; a #fragment names a real
 * heading or anchor when the target is Markdown), and docs/README.md links
 * to it. One direction only: this does not require every doc to be indexed.
 *
 * Link extraction reuses scripts/check-documentation.mjs's inspectMarkdown so
 * fenced examples and inline HTML are treated exactly as `npm run check:docs`
 * treats them.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// @ts-expect-error Standalone Node documentation checker has no declaration output.
import { inspectMarkdown } from '../scripts/check-documentation.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOC = join(root, 'docs', 'SELF-HOSTING.md');
const INDEX = join(root, 'docs', 'README.md');

interface DocLinks { path: string; fragment: string; href: string }

function relativeLinks(file: string): DocLinks[] {
  const out: DocLinks[] = [];
  const inspected = inspectMarkdown(readFileSync(file, 'utf8')) as {
    links: string[];
    anchors: Set<string>;
    errors: string[];
  };
  expect(inspected.errors).toEqual([]);
  for (const href of inspected.links) {
    if (/^[a-z][a-z\d+.-]*:/iu.test(href) || href.startsWith('//')) continue;
    const hash = href.indexOf('#');
    const path = hash < 0 ? href : href.slice(0, hash);
    out.push({
      path: decodeURIComponent(path.split('?')[0] ?? ''),
      fragment: hash < 0 ? '' : decodeURIComponent(href.slice(hash + 1)),
      href,
    });
  }
  return out;
}

describe('docs/SELF-HOSTING.md', () => {
  const links = relativeLinks(DOC);

  it('stays under the 150-line budget', () => {
    const text = readFileSync(DOC, 'utf8');
    const lines = text.split('\n').length - (text.endsWith('\n') ? 1 : 0);
    expect(lines).toBeLessThan(150);
  });

  it('has at least one relative link', () => {
    expect(links.length).toBeGreaterThan(0);
  });

  it.each(links.map((l) => [l.href, l] as const))('resolves %s', (_href, link) => {
    const target = resolve(dirname(DOC), link.path === '' ? '.' : link.path);
    expect(existsSync(target), `${link.href} does not resolve`).toBe(true);
    if (link.fragment && statSync(target).isFile() && target.endsWith('.md')) {
      const anchors = (inspectMarkdown(readFileSync(target, 'utf8')) as { anchors: Set<string> }).anchors;
      expect(anchors.has(link.fragment), `#${link.fragment} missing in ${link.path}`).toBe(true);
    }
  });

  it('is linked from docs/README.md', () => {
    const links = relativeLinks(INDEX).map((l) => l.path);
    expect(links).toContain('SELF-HOSTING.md');
  });
});
