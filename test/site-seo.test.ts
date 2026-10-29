/**
 * Site SEO contract (RQ-SEO-PH).
 *
 * The static site in site/ makes factual claims in `.claim` blocks. Every
 * claim block must carry a `.src` link to a source a reader can open: a path
 * inside this repository (docs, benchmarks, code) or a linked public source.
 * Repo links under github.com/ashlrai/phantom/blob|tree are resolved against
 * the checkout so a renamed file or dead anchor fails here.
 *
 * Also enforced: one absolute canonical per page, a sitemap that matches the
 * page set with truthful lastmod dates, working internal links and anchors,
 * and no em/en dashes in the new intent pages.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { JSDOM } from 'jsdom';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const site = resolve(root, 'site');
const ORIGIN = 'https://verse.ashlr.ai';

const pages: string[] = [];
(function walk(dir: string) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) walk(path);
    else if (entry.isFile() && entry.name.endsWith('.html')) pages.push(path);
  }
})(site);
pages.sort();

const NEW_PAGES = [
  'site/use-cases/own-accounts.html',
  'site/use-cases/local-models.html',
  'site/use-cases/signed-autonomy.html',
  'site/use-cases/review-agent-work.html',
  'site/compare/agent-clis.html',
];

function dom(path: string) {
  return new JSDOM(readFileSync(path, 'utf8'), { url: `${ORIGIN}/` }).window.document;
}

/** site/foo/bar.html -> https://verse.ashlr.ai/foo/bar (index.html -> /). */
function canonicalPathFor(path: string) {
  const rel = relative(site, path).replace(/\.html$/, '');
  return rel === 'index' ? `${ORIGIN}/` : `${ORIGIN}/${rel}`;
}

function git(args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return '';
  }
}

/** GitHub-flavoured heading slugs, mirroring scripts/check-documentation.mjs. */
function markdownAnchors(path: string): Set<string> {
  const anchors = new Set<string>();
  const text = readFileSync(path, 'utf8');
  for (const line of text.split('\n')) {
    const m = line.match(/^#{1,6}\s+(.*)$/);
    if (!m) continue;
    const title = m[1]
      .replace(/<a\s+id="([^"]+)"[^>]*><\/a>/g, '') // explicit anchors handled below
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/[*_`~]/g, '')
      .replace(/<[^>]*>/g, '');
    const base = title.trim().toLowerCase()
      .replace(/[^\p{L}\p{M}\p{N}_ -]/gu, '').replace(/ /g, '-');
    let id = base;
    let dup = 0;
    while (anchors.has(id)) id = `${base}-${++dup}`;
    anchors.add(id);
  }
  for (const m of text.matchAll(/<a\s+id="([^"]+)"/g)) anchors.add(m[1]);
  return anchors;
}

describe('static site SEO contract', () => {
  it('the sitemap builder check agrees with the committed sitemap', () => {
    const output = execFileSync(process.execPath, ['scripts/build-site-sitemap.mjs', '--check'], {
      cwd: root,
      encoding: 'utf8',
    });
    expect(output).toContain('site/sitemap.xml is current');
  });

  it('every page has exactly one absolute canonical matching its file location', () => {
    const seen = new Map<string, string>();
    for (const path of pages) {
      const document = dom(path);
      const canonicals = [...document.querySelectorAll('link[rel="canonical"]')];
      expect(canonicals.length, `${relative(root, path)} canonical count`).toBe(1);
      const href = canonicals[0].getAttribute('href') ?? '';
      expect(href, `${relative(root, path)} canonical must be absolute`).toBe(canonicalPathFor(path));
      expect(seen.has(href), `duplicate canonical ${href}`).toBe(false);
      seen.set(href, path);
      expect(document.querySelector('title')?.textContent?.trim().length, `${relative(root, path)} title`).toBeGreaterThan(0);
      expect(document.querySelector('meta[name="description"]')?.getAttribute('content')?.trim().length, `${relative(root, path)} description`).toBeGreaterThan(0);
    }
  });

  it('every claim block carries a source link', () => {
    let claimCount = 0;
    for (const path of pages) {
      const rel = relative(root, path);
      const document = dom(path);
      for (const claim of document.querySelectorAll('.claim')) {
        claimCount++;
        const sources = [...claim.querySelectorAll('.src a')];
        expect(sources.length, `${rel}: claim without a .src link: ${claim.querySelector('h3')?.textContent}`).toBeGreaterThan(0);
        for (const a of sources) {
          const href = a.getAttribute('href') ?? '';
          expect(href.startsWith('https://'), `${rel}: non-public source ${href}`).toBe(true);
        }
      }
    }
    for (const rel of NEW_PAGES) {
      const document = dom(resolve(root, rel));
      expect(document.querySelectorAll('.claim').length, `${rel} has no claim blocks`).toBeGreaterThan(0);
    }
    expect(claimCount).toBeGreaterThan(0);
  });

  it('repo links resolve to real paths, and markdown anchors exist', () => {
    const anchorCache = new Map<string, Set<string>>();
    for (const path of pages) {
      const document = dom(path);
      for (const a of document.querySelectorAll('a[href]')) {
        const href = a.getAttribute('href') ?? '';
        const m = href.match(/^https:\/\/github\.com\/ashlrai\/([^/]+)\/(blob|tree)\/([^/]+)\/([^#?]+)(?:#([^?]+))?/);
        if (!m || m[1] !== 'phantom' || (m[3] !== 'master' && m[3] !== 'main')) continue;
        const target = resolve(root, decodeURIComponent(m[4]));
        expect(existsSync(target), `${relative(root, path)} links missing repo path ${m[4]}`).toBe(true);
        const anchor = m[5];
        if (anchor && m[4].endsWith('.md')) {
          if (!anchorCache.has(target)) anchorCache.set(target, markdownAnchors(target));
          expect(anchorCache.get(target)!.has(anchor), `${relative(root, path)} links dead anchor ${m[4]}#${anchor}`).toBe(true);
        }
      }
    }
  });

  it('internal links and same-page anchors resolve', () => {
    const docs = new Map<string, Document>(pages.map((p) => [p, dom(p)]));
    const index = docs.get(resolve(site, 'index.html'))!;
    const fileFor = (clean: string) => resolve(site, clean === '/' ? 'index.html' : `${clean.slice(1)}.html`);
    for (const [path, document] of docs) {
      const rel = relative(root, path);
      for (const a of document.querySelectorAll('a[href]')) {
        const href = a.getAttribute('href') ?? '';
        if (href.startsWith('#')) {
          expect(document.getElementById(href.slice(1)), `${rel} dead fragment ${href}`).not.toBeNull();
        } else if (href.startsWith('/#')) {
          expect(index.getElementById(href.slice(2)), `${rel} dead index fragment ${href}`).not.toBeNull();
        } else if (href.startsWith('/')) {
          expect(existsSync(fileFor(href)), `${rel} links missing page ${href}`).toBe(true);
        } else if (!href.startsWith('http') && !href.startsWith('mailto:')) {
          const base = href.split('#')[0];
          expect(base === '' || existsSync(resolve(resolve(path, '..'), base)), `${rel} dead relative link ${href}`).toBe(true);
        }
      }
      for (const el of document.querySelectorAll('[src], link[href]')) {
        const value = el.getAttribute('src') ?? el.getAttribute('href') ?? '';
        if (!value.startsWith('assets/') && !value.startsWith('/assets/')) continue;
        expect(existsSync(resolve(site, value.replace(/^\//, ''))), `${rel} missing asset ${value}`).toBe(true);
      }
    }
  });

  it('use-case pages interlink with docs, install and each other', () => {
    for (const rel of NEW_PAGES) {
      const document = dom(resolve(root, rel));
      const hrefs = [...document.querySelectorAll('a[href]')].map((a) => a.getAttribute('href') ?? '');
      expect(hrefs.some((h) => h === '/#install-verse' || h === '/#start'), `${rel} lacks an install link`).toBe(true);
      expect(hrefs.some((h) => h.startsWith('https://github.com/ashlrai/phantom/blob/master/docs/')), `${rel} lacks a docs link`).toBe(true);
      const siblings = NEW_PAGES.filter((p) => p !== rel).map((p) => `/${p.replace(/^site\//, '').replace(/\.html$/, '')}`);
      expect(hrefs.some((h) => siblings.includes(h)), `${rel} links to no sibling guide`).toBe(true);
    }
  });

  it('keeps the new intent pages free of em and en dashes', () => {
    for (const rel of NEW_PAGES) {
      const text = readFileSync(resolve(root, rel), 'utf8');
      expect(text, `${rel} contains an em/en dash`).not.toMatch(/[\u2013\u2014]|&(mdash|ndash);|&#x?201[34];/i);
    }
  });

  it('sitemap is valid, covers every canonical, and lastmod stays truthful', () => {
    const sitemapDom = new JSDOM(readFileSync(resolve(site, 'sitemap.xml'), 'utf8'), { contentType: 'text/xml' }).window.document;
    expect(sitemapDom.querySelector('parsererror')).toBeNull();
    expect(sitemapDom.documentElement.namespaceURI).toBe('http://www.sitemaps.org/schemas/sitemap/0.9');
    expect(sitemapDom.documentElement.localName).toBe('urlset');
    const entries = [...sitemapDom.querySelectorAll('url')];
    const locs = entries.map((e) => e.querySelector('loc')?.textContent ?? '');
    const canonicals = pages.map(canonicalPathFor).sort();
    expect([...locs].sort(), 'sitemap must list exactly the page canonicals').toEqual(canonicals);
    const today = new Date().toISOString().slice(0, 10);
    for (const entry of entries) {
      const loc = entry.querySelector('loc')!.textContent!;
      expect(loc.startsWith(`${ORIGIN}/`)).toBe(true);
      const lastmod = entry.querySelector('lastmod')?.textContent ?? '';
      expect(lastmod, `${loc} lastmod`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(lastmod <= today, `${loc} lastmod in the future`).toBe(true);
      const file = loc === `${ORIGIN}/` ? 'index.html' : `${loc.slice(ORIGIN.length + 1)}.html`;
      const tracked = git(['ls-files', '--error-unmatch', `site/${file}`]) !== '';
      const dirty = git(['status', '--porcelain', '--', `site/${file}`]) !== '';
      if (tracked && !dirty) {
        // A committed, unchanged page may not claim a modification newer
        // than its last commit; older-but-valid lastmod stays acceptable.
        const committed = git(['log', '-1', '--format=%cs', '--', `site/${file}`]);
        if (committed) expect(lastmod <= committed, `${loc} lastmod is newer than its last commit`).toBe(true);
      }
    }
  });
});
