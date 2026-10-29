#!/usr/bin/env node

// Regenerate site/sitemap.xml from the pages that are actually in site/.
//
// Each <loc> is the page's own canonical URL (absolute, https://verse.ashlr.ai).
// Each <lastmod> is the date of the last git commit that touched the file.
// When a page is new or has uncommitted changes, git cannot date it yet, so
// lastmod falls back to today (UTC): the honest "content changed now" date.
//
// Usage:
//   node scripts/build-site-sitemap.mjs          # rewrite sitemap.xml
//   node scripts/build-site-sitemap.mjs --check  # exit 1 if it would change
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const siteDir = resolve(root, 'site');
const sitemapPath = resolve(siteDir, 'sitemap.xml');

function* htmlFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) yield* htmlFiles(path);
    else if (entry.isFile() && entry.name.endsWith('.html')) yield path;
  }
}

function canonicalOf(path) {
  const html = readFileSync(path, 'utf8');
  const match = html.match(/<link\s+rel="canonical"\s+href="([^"]+)"\s*\/?>/i)
    ?? html.match(/<link\s+href="([^"]+)"\s+rel="canonical"\s*\/?>/i);
  if (!match) throw new Error(`no canonical link in ${relative(root, path)}`);
  return match[1];
}

function git(args) {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

function lastmodOf(path) {
  const rel = relative(root, path);
  const committed = git(['log', '-1', '--format=%cs', '--', rel]);
  const dirty = committed === '' || git(['status', '--porcelain', '--', rel]) !== '';
  return dirty ? new Date().toISOString().slice(0, 10) : committed;
}

export function buildSitemap({ readFile = canonicalOf, readLastmod = lastmodOf } = {}) {
  const urls = [...htmlFiles(siteDir)].map((path) => ({
    loc: readFile(path),
    lastmod: readLastmod(path),
  })).sort((a, b) => a.loc.localeCompare(b.loc));
  const seen = new Set();
  for (const { loc } of urls) {
    if (!/^https:\/\/verse\.ashlr\.ai\//.test(loc)) throw new Error(`non-canonical loc ${loc}`);
    if (seen.has(loc)) throw new Error(`duplicate canonical ${loc}`);
    seen.add(loc);
  }
  const lines = urls.map(({ loc, lastmod }) => `  <url><loc>${loc}</loc><lastmod>${lastmod}</lastmod></url>`);
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${lines.join('\n')}\n</urlset>\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const next = buildSitemap();
  if (process.argv.includes('--check')) {
    const current = readFileSync(sitemapPath, 'utf8');
    if (current !== next) {
      console.error('site/sitemap.xml is stale; run `node scripts/build-site-sitemap.mjs`');
      process.exit(1);
    }
    console.log('site/sitemap.xml is current');
  } else {
    writeFileSync(sitemapPath, next);
    console.log(`wrote ${relative(root, sitemapPath)}`);
  }
}
