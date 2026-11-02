import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error Standalone Node documentation checker has no declaration output.
import { inspectMarkdown } from '../scripts/check-documentation.mjs';

const FLEET_DOCS = join('docs', 'fleet');
const fleetMarkdownFiles = () => readdirSync(FLEET_DOCS).filter(name => name.endsWith('.md'));

describe('fleet documentation links', () => {
  it('finds the docs/fleet markdown files it guards', () => {
    expect(fleetMarkdownFiles().length).toBeGreaterThan(0);
  });

  it('only allows absolute https URLs and same-document #anchors as link targets', () => {
    const offenders = fleetMarkdownFiles().flatMap((file) => {
      const markdown = readFileSync(join(FLEET_DOCS, file), 'utf8');
      const { links } = inspectMarkdown(markdown) as { links: string[] };
      return links
        .filter(href => !/^(?:https:\/\/|#)/u.test(href))
        .map(href => `${file} -> ${href}`);
    });
    expect(offenders).toEqual([]);
  });
});
