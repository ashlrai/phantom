import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';
import { buildSiteLlmsFiles } from '../scripts/generate-site-llms.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const site = resolve(root, 'site');
const read = (path: string) => readFileSync(resolve(site, path), 'utf8');

function htmlPages(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) return htmlPages(path);
    return entry.isFile() && /\.html$/i.test(entry.name) ? [relative(site, path)] : [];
  });
}
const pages = htmlPages(site).sort();
const doms = new Map(
  pages.map((page) => [page, new JSDOM(read(page)).window.document]),
);

const canonicalFor = (page: string) =>
  `https://verse.ashlr.ai/${page === 'index.html' ? '' : page.replace(/\.html$/i, '')}`;

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
function compareSemver(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pa[i]! - pb[i]!;
  return 0;
}

function jsonLdNodes(value: unknown, seen = new Set<unknown>()): Array<Record<string, unknown>> {
  if (!value || typeof value !== 'object' || seen.has(value)) return [];
  seen.add(value);
  if (Array.isArray(value)) return value.flatMap((v) => jsonLdNodes(v, seen));
  const row = value as Record<string, unknown>;
  const nested = [row['@graph'], row['mainEntity'], row['itemListElement']]
    .flatMap((v) => (Array.isArray(v) ? v : v ? [v] : []));
  return [row, ...nested.flatMap((v) => jsonLdNodes(v, seen))];
}

function jsonLdOf(document: Document): Array<Record<string, unknown>> {
  return [...document.querySelectorAll('script[type="application/ld+json"]')].flatMap((script) =>
    jsonLdNodes(JSON.parse(script.textContent ?? '')),
  );
}

const applicationNodes = pages.flatMap((page) =>
  jsonLdOf(doms.get(page)!).filter((node) =>
    ['SoftwareApplication', 'WebApplication', 'MobileApplication'].includes(String(node['@type'])),
  ),
);
const app = applicationNodes.find((node) => node['@id'] === 'https://verse.ashlr.ai/#application');
const capabilities = JSON.parse(read('capabilities.json')) as Record<string, unknown>;
const mcpServer = JSON.parse(read('.well-known/mcp/server.json')) as Record<string, unknown>;
const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')) as { version: string };

describe('site agent discoverability', () => {
  it('parses every JSON-LD block and describes the application', () => {
    expect(pages.length).toBeGreaterThanOrEqual(3);
    for (const page of pages) {
      const scripts = doms.get(page)!.querySelectorAll('script[type="application/ld+json"]');
      expect(scripts.length, `${page} carries JSON-LD`).toBeGreaterThanOrEqual(1);
      for (const script of scripts) expect(() => JSON.parse(script.textContent ?? ''), page).not.toThrow();
    }
    expect(app, 'a SoftwareApplication node with the canonical @id').toBeTruthy();
    expect(app!['name']).toBe('Phantom');
    expect(app!['softwareVersion']).toMatch(SEMVER);
    expect(app!['operatingSystem']).toContain('macOS');
    expect(app!['license']).toBe('https://github.com/ashlrai/phantom/blob/master/LICENSE');
    expect(app!['codeRepository']).toBe('https://github.com/ashlrai/phantom');
    const offers = app!['offers'] as Record<string, unknown>;
    expect(offers?.['@type']).toBe('Offer');
    expect(offers?.['price']).toBe('0');
  });

  it('keeps published metadata versions consistent and never ahead of source', () => {
    expect(read('index.html').match(/"softwareVersion"\s*:/g)).toHaveLength(1);
    const siteVersion = String(app!['softwareVersion']);
    for (const node of applicationNodes) {
      expect(node['softwareVersion'], 'every page repeats the same application version').toBe(siteVersion);
    }
    expect(capabilities['version']).toBe(siteVersion);
    expect(mcpServer['version']).toBe(siteVersion);
    expect(compareSemver(pkg.version, siteVersion), 'site metadata must not advertise a version newer than source').toBeGreaterThanOrEqual(0);
  });

  it('parses llms.txt and llms-full.txt with the llms.txt shape', () => {
    for (const name of ['llms.txt', 'llms-full.txt']) {
      const text = read(name);
      expect(text, `${name} has an H1`).toMatch(/(^|\n)# \S/);
      expect(text.match(/(^|\n)## \S/g)?.length ?? 0, `${name} has sections`).toBeGreaterThanOrEqual(1);
      const links = text.match(/\[[^\]]+\]\([^)\s]+\)/g) ?? [];
      expect(links.length, `${name} lists markdown links`).toBeGreaterThanOrEqual(3);
      for (const link of links) {
        expect(link, `${name} links resolve to absolute URLs`).toMatch(/\]\(https:\/\/\S+\)/);
      }
    }
    const short = (read('llms.txt').match(/\]\(/g) ?? []).length;
    const full = (read('llms-full.txt').match(/\]\(/g) ?? []).length;
    expect(full).toBeGreaterThan(short);
  });

  it('keeps the generated llms files in sync with README and docs headings', () => {
    const built = buildSiteLlmsFiles(root);
    expect(read('llms.txt'), 'site/llms.txt is generated; run node scripts/generate-site-llms.mjs')
      .toBe(built.llmsTxt);
    expect(read('llms-full.txt'), 'site/llms-full.txt is generated; run node scripts/generate-site-llms.mjs')
      .toBe(built.llmsFullTxt);
  });

  it('validates sitemap.xml against the published canonical pages', () => {
    const document = new JSDOM(read('sitemap.xml'), { contentType: 'text/xml' }).window.document;
    expect(document.querySelector('parsererror')).toBeNull();
    const urlset = document.querySelector('urlset');
    expect(urlset).not.toBeNull();
    const locs = [...document.querySelectorAll('url > loc')].map((loc) => loc.textContent);
    expect(locs.sort()).toEqual(pages.map(canonicalFor).sort());
    for (const entry of document.querySelectorAll('url')) {
      expect(entry.querySelector('loc')?.textContent).toMatch(/^https:\/\/verse\.ashlr\.ai\//);
      expect(entry.querySelector('lastmod')?.textContent).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
    expect(read('robots.txt')).toMatch(/^Sitemap:\s*https:\/\/verse\.ashlr\.ai\/sitemap\.xml\s*$/m);
  });

  it('gives every page one canonical URL and one h1 with semantic order', () => {
    for (const page of pages) {
      const document = doms.get(page)!;
      const canonical = document.querySelectorAll('link[rel="canonical"]');
      expect(canonical.length, `${page} has exactly one canonical`).toBe(1);
      expect(canonical[0]!.getAttribute('href')).toBe(canonicalFor(page));
      const h1s = document.querySelectorAll('h1');
      expect(h1s.length, `${page} has exactly one h1`).toBe(1);
      const levels = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6')]
        .map((h) => Number(h.tagName[1]));
      for (let i = 1; i < levels.length; i++) {
        expect(levels[i]! <= levels[i - 1]! + 1, `${page} skips a heading level`).toBe(true);
      }
    }
  });

  it('carries description, OpenGraph and twitter card on every page', () => {
    const required = ['description', 'og:title', 'og:description', 'og:type', 'og:url', 'og:image', 'twitter:card'];
    for (const page of pages) {
      const document = doms.get(page)!;
      expect(document.querySelector('title')?.textContent?.trim(), page).toBeTruthy();
      for (const key of required) {
        const meta = document.querySelector(`meta[name="${key}"], meta[property="${key}"]`);
        expect(meta?.getAttribute('content')?.trim(), `${page} misses ${key}`).toBeTruthy();
      }
      expect(document.querySelector('meta[property="og:url"]')?.getAttribute('content'))
        .toBe(canonicalFor(page));
    }
  });

  it('publishes machine-readable capabilities and MCP manifests', () => {
    const manifestKeys = ['name', 'version', 'description', 'capabilities', 'install', 'commands', 'tools']
      .filter((key) => capabilities[key] !== undefined);
    expect(manifestKeys.length).toBeGreaterThanOrEqual(2);
    expect(capabilities['name']).toBe('Phantom');
    expect(Array.isArray(capabilities['capabilities'])).toBe(true);
    const install = capabilities['install'] as Record<string, unknown>;
    expect(install?.['command']).toContain('@ashlr/phantom');

    expect(String(mcpServer['name'])).toMatch(/^[a-z0-9]+(?:[.-][a-z0-9]+)*\/[a-z0-9][a-z0-9._-]*$/i);
    expect(String(mcpServer['description'] ?? '')).not.toBe('');
    const packages = Array.isArray(mcpServer['packages']) ? mcpServer['packages'] : [];
    const remotes = Array.isArray(mcpServer['remotes']) ? mcpServer['remotes'] : [];
    expect(packages.length + remotes.length).toBeGreaterThanOrEqual(1);
    expect(existsSync(resolve(site, 'AGENTS.md'))).toBe(true);
  });

  it('keeps the new agent-facing files free of em dashes', () => {
    for (const path of ['llms.txt', 'llms-full.txt', 'capabilities.json', '.well-known/mcp/server.json', 'AGENTS.md', 'install.html']) {
      expect(read(path), `${path} uses an em dash`).not.toContain('—');
    }
  });
});
