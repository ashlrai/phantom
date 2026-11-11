/**
 * RQ-PHX-RECUTCOREO1S142 recovers RQ-DRAIN-phantom-1019 (#2831): docs/VISION.md,
 * the product-direction page, and the packaged-guide links that keep it
 * reachable. These tests exercise the real documentation checker
 * (scripts/check-documentation.mjs) against this checkout — no fixture copies.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error Standalone Node documentation checker has no declaration output.
import { checkDocumentation, inspectMarkdown } from '../scripts/check-documentation.mjs';

const SOURCE_VISION_URL = 'https://github.com/ashlrai/phantom/blob/master/docs/VISION.md';
const root = process.cwd();

describe('docs/VISION.md product-direction page (recovered #2831)', () => {
  it('exists in the checkout with its stable anchor and is not shipped in the package', () => {
    const page = join(root, 'docs/VISION.md');
    expect(existsSync(page)).toBe(true);
    const inspected = inspectMarkdown(readFileSync(page, 'utf8')) as {
      anchors: Set<string>;
      errors: { message: string }[];
    };
    expect(inspected.errors).toEqual([]);
    expect(inspected.anchors.has('phantom-vision')).toBe(true);
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { files: string[] };
    expect(manifest.files).not.toContain('docs/VISION.md');
  });

  it('is linked from at least one packaged guide through a source URL', () => {
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { files: string[] };
    const visionLinks = manifest.files
      .filter((file) => file.endsWith('.md'))
      .flatMap((file) => {
        const { links } = inspectMarkdown(readFileSync(join(root, file), 'utf8')) as { links: string[] };
        return links.filter((href) => /(?:^|\/)VISION\.md(?:#|$)/.test(href));
      });
    expect(visionLinks.length).toBeGreaterThan(0);
    for (const href of visionLinks) expect(href).toBe(SOURCE_VISION_URL);
  });

  it('passes the real documentation check as its own entrypoint', () => {
    expect(checkDocumentation({ root, entrypoints: ['docs/VISION.md'] }))
      .toMatchObject({ ok: true, errors: [], externalRequests: 0 });
  });

  it('resolves the packaged-guide vision links to the page in source mode and skips them in package mode', () => {
    const guides = [
      'docs/ARCHITECTURE.md',
      'docs/ASHLR-UNIVERSE.md',
      'docs/DEMO.md',
      'docs/PROACTIVE-COORDINATION.md',
      'docs/PROACTIVE-COORDINATION-BACKLOG.md',
      'docs/UNIVERSE-AUTONOMY-RESEARCH.md',
    ].filter((file) => {
      const { links } = inspectMarkdown(readFileSync(join(root, file), 'utf8')) as { links: string[] };
      return links.includes(SOURCE_VISION_URL);
    });
    expect(guides.length).toBeGreaterThan(0);
    // Source mode follows the GitHub blob URL back into the checkout; it fails
    // loudly if docs/VISION.md is missing or unreadable.
    expect(checkDocumentation({ root, entrypoints: guides })).toMatchObject({ ok: true, errors: [] });
    // Package mode treats the same links as source-only and never requests them.
    expect(checkDocumentation({ root, mode: 'package', entrypoints: guides }))
      .toMatchObject({ ok: true, errors: [], externalRequests: 0 });
  });
});
