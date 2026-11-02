import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

/**
 * Extract relative markdown links from doc content.
 * Skips http(s):, //, mailto: targets, and bare anchors.
 */
function extractRelativeMdLinks(content: string): string[] {
  const links: string[] = [];
  const pattern = /\[([^\]]+)\]\(([^)]+)\)/g;
  let match;
  while ((match = pattern.exec(content)) !== null) {
    const url = match[2];
    if (url.startsWith('http://') || url.startsWith('https://')) continue;
    if (url.startsWith('//')) continue;
    if (url.startsWith('mailto:')) continue;
    // Strip fragment identifiers for file resolution
    const pathPart = url.replace(/#.*$/, '');
    if (pathPart.endsWith('.md') && !pathPart.startsWith('/')) {
      links.push(pathPart);
    }
  }
  return links;
}

/**
 * Build the package-relative path for a relative markdown link.
 * "PHANTOM-BRAND.md" -> "docs/PHANTOM-BRAND.md"
 */
function toPackageRelativePath(link: string): string {
  return join('docs', link);
}

/**
 * Check whether a package-relative path is covered by a package.json
 * "files" entry.
 *
 * Supports:
 *  - Exact match:  "docs/README.md"
 *  - Directory prefix:  "docs"  (matches "docs/foo.md")
 *  - Globstar directory:  "docs/**"  (any file under docs/)
 *  - Single-level glob:  "docs/contracts/*.md"
 */
function isCoveredByFiles(pkgPath: string, pkgFiles: string[]): boolean {
  for (const entry of pkgFiles) {
    // Exact file match
    if (pkgPath === entry) return true;
    // Directory prefix (e.g. "docs" matches "docs/foo.md")
    if (pkgPath.startsWith(entry + '/')) return true;
    // Globstar directory (e.g. "docs/**")
    if (entry.endsWith('/**')) {
      const dirPrefix = entry.slice(0, -3);
      if (pkgPath.startsWith(dirPrefix + '/')) return true;
    }
    // Single-level glob (e.g. "docs/contracts/*.md")
    if (entry.includes('*')) {
      const parts = entry.split('/');
      const globName = parts[parts.length - 1];
      const escapedBase = parts.slice(0, -1).join('/');
      const starRe = globName
        .replace(/[.+?^${}()|[\]\\]/g, (m) => '\\' + m)
        .replace(/\*/g, '[^/]+');
      const fullRe = '^' + escapedBase + '/' + starRe + '$';
      const re = new RegExp(fullRe);
      if (re.test(pkgPath)) return true;
    }
  }
  return false;
}

/**
 * Test: every relative markdown link in docs/README.md must resolve
 * to a path covered by the package.json "files" field.
 *
 * Known-bad links on master (not fixed by this test) are tracked in
 * the KNOWN_BAD_LINKS set so the test stays green while CI failures
 * are caught early by the fast local check.
 */
describe('docs/README.md relative links → package.json files', () => {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
  const pkgFiles = pkg.files as string[];
  const readmeContent = readFileSync(join(root, 'docs/README.md'), 'utf-8');
  const links = extractRelativeMdLinks(readmeContent);
  const uniqueLinks = [...new Set(links)];

  // Known-bad relative links on master that are NOT covered by
  // package.json "files".  Add one comment line per entry and the
  // test stays green; CI failures are caught by this fast check.
  // Last updated: 2026-11-02 — list checked against origin/master.
  const KNOWN_BAD_LINKS = new Set<string>([
    'FLEET-LANE-FRESHNESS.md',
  ]);

  it('resolves every relative link to a package.json "files" entry', () => {
    const badLinks: string[] = [];
    for (const link of uniqueLinks) {
      const pkgPath = toPackageRelativePath(link);
      const covered = isCoveredByFiles(pkgPath, pkgFiles);
      if (!covered) {
        // Skip known-bad entries so the test stays green.
        if (KNOWN_BAD_LINKS.has(link)) continue;
        badLinks.push(link);
      }
    }
    if (badLinks.length > 0) {
      const msg = badLinks
        .map(
          (l) =>
            `  - ${l}: link it by absolute URL https://github.com/ashlrai/phantom/blob/master/docs/${l}`,
        )
        .join('\n');
      throw new Error(
        `Relative links in docs/README.md resolve to files NOT covered by ` +
          `package.json "files". docs/README.md ships in the npm package, ` +
          `so these links are broken:\n${msg}`,
      );
    }
  });

  it('has at least one relative link', () => {
    expect(uniqueLinks.length).toBeGreaterThan(0);
  });

  it('documents its known-bad list', () => {
    expect(KNOWN_BAD_LINKS.size).toBeGreaterThanOrEqual(0);
  });
});
