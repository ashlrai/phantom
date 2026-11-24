/**
 * cos-pages tests - hermetic coverage for src/core/cos/pages.ts.
 *
 * Covers:
 *   - slugify / PAGE_SLUG_RE grammar
 *   - publishPage over .md and .json sources (title/slug/description
 *     derivation, front matter, generic COS result documents)
 *   - store layout, atomic re-publish, bounded reads
 *   - listPages / readPage round-trips and malformed-record tolerance
 *   - pagesApiGetResponse + isPagesApiPath (the /api mount server.ts wires)
 *
 * HOME/ASHLR_HOME are relocated per test; nothing touches the real home.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  isPagesApiPath,
  listPages,
  MAX_LIST,
  MAX_SOURCE_BYTES,
  PAGE_SLUG_RE,
  pagesApiGetResponse,
  pagesDir,
  publishPage,
  readPage,
  slugify,
} from '../src/core/cos/pages.js';

let tmpHome: string;
let prevHome: string | undefined;
let prevAshlrHome: string | undefined;

beforeEach(() => {
  tmpHome = mkdtempSync(join(tmpdir(), 'ashlr-cos-pages-'));
  prevHome = process.env.HOME;
  prevAshlrHome = process.env.ASHLR_HOME;
  process.env.HOME = tmpHome;
  process.env.ASHLR_HOME = join(tmpHome, '.ashlr');
});

afterEach(() => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevAshlrHome === undefined) delete process.env.ASHLR_HOME;
  else process.env.ASHLR_HOME = prevAshlrHome;
});

function source(name: string, body: string): string {
  const path = join(tmpHome, name);
  writeFileSync(path, body);
  return path;
}

// ---------------------------------------------------------------------------
// slugify
// ---------------------------------------------------------------------------

describe('slugify', () => {
  it('normalizes free text into the slug grammar', () => {
    expect(slugify('Weekly Report!')).toBe('weekly-report');
    expect(slugify('  --Weird__Slug??  ')).toBe('weird-slug');
    expect(slugify('Q3 COS Review')).toBe('q3-cos-review');
    expect(slugify('report')).toBe('report');
  });

  it('returns empty when nothing web-safe survives', () => {
    expect(slugify('!!!')).toBe('');
    expect(slugify('---')).toBe('');
    expect(slugify('')).toBe('');
  });

  it('bounds slug length and never emits leading/trailing dashes', () => {
    const slug = slugify('a'.repeat(200));
    expect(slug.length).toBeLessThanOrEqual(80);
    expect(PAGE_SLUG_RE.test(slug)).toBe(true);
    expect(slugify('-'.repeat(90) + 'x')).toBe('x');
  });
});

// ---------------------------------------------------------------------------
// publishPage - markdown sources
// ---------------------------------------------------------------------------

describe('publishPage (.md)', () => {
  it('stores a page record under <ASHLR_HOME>/pages and returns it', () => {
    const file = source('weekly-report.md', '# Weekly report\n\nAll merged.\n');
    const result = publishPage({ filePath: file, now: new Date('2026-11-04T10:00:00Z') });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.page.slug).toBe('weekly-report');
    expect(result.page.title).toBe('Weekly report');
    expect(result.page.markdown).toContain('# Weekly report');
    expect(result.page.sourceFormat).toBe('markdown');
    expect(result.page.sourceName).toBe('weekly-report.md');
    expect(result.page.publishedAt).toBe('2026-11-04T10:00:00.000Z');
    expect(readFileSync(result.file, 'utf8')).toContain('"slug":"weekly-report"');
    expect(result.file).toBe(join(pagesDir(), 'weekly-report.json'));
  });

  it('derives a description from the first paragraph', () => {
    const file = source('r.md', '# T\n\nFirst line of the report.\n\nMore.\n');
    const result = publishPage({ filePath: file });
    expect(result.ok && result.page.description).toBe('First line of the report.');
  });

  it('honors front matter title, slug and description', () => {
    const file = source('fm.md', '---\ntitle: Custom Title\nslug: custom-slug\ndescription: Custom desc\n---\n\n# Ignored\n\nBody.\n');
    const result = publishPage({ filePath: file });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.page.slug).toBe('custom-slug');
    expect(result.page.title).toBe('Custom Title');
    expect(result.page.description).toBe('Custom desc');
    expect(result.page.markdown).not.toContain('Custom Title\nslug:');
    expect(result.page.markdown).toContain('# Ignored');
  });

  it('keeps the whole body past the front-matter scan window', () => {
    const tail = 'x'.repeat(5_000);
    const file = source('long.md', `---\ntitle: T\n---\n\n${'# h\n\n'.repeat(40)}${tail}\n`);
    const result = publishPage({ filePath: file });
    expect(result.ok && result.page.markdown.includes(tail)).toBe(true);
  });

  it('respects explicit --slug and --title overrides', () => {
    const file = source('a.md', '# A\n\nbody\n');
    const result = publishPage({ filePath: file, slug: 'My Slug!', title: 'Given' });
    expect(result.ok && result.page.slug === 'my-slug' && result.page.title === 'Given').toBe(true);
  });

  it('republishing a slug replaces the page', () => {
    const file = source('r.md', '# V1\n\nfirst\n');
    const first = publishPage({ filePath: file });
    expect(first.ok).toBe(true);
    writeFileSync(file, '# V2\n\nsecond\n');
    const second = publishPage({ filePath: file });
    expect(second.ok).toBe(true);
    expect(readPage('r')?.title).toBe('V2');
    expect(readdirSync(pagesDir()).filter((n) => n === 'r.json')).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// publishPage - json sources
// ---------------------------------------------------------------------------

describe('publishPage (.json)', () => {
  it('uses explicit markdown/body fields when present', () => {
    const file = source('p.json', JSON.stringify({ title: 'JSON page', slug: 'json-page', markdown: '# Hi\n\nfrom json\n' }));
    const result = publishPage({ filePath: file });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.page.slug).toBe('json-page');
    expect(result.page.title).toBe('JSON page');
    expect(result.page.sourceFormat).toBe('json');
    expect(result.page.markdown).toContain('# Hi');
  });

  it('publishes a generic COS result document as a fenced JSON body', () => {
    const doc = { kind: 'cos-result', summary: 'three merges', items: [1, 2, 3] };
    const file = source('cos-result.json', JSON.stringify(doc));
    const result = publishPage({ filePath: file });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.page.slug).toBe('cos-result');
    expect(result.page.title).toBe('cos result');
    expect(result.page.markdown).toContain('```json');
    expect(result.page.markdown).toContain('"cos-result"');
  });

  it('rejects non-object and invalid JSON', () => {
    for (const [name, body] of [['arr.json', '[1,2]'], ['bad.json', '{nope']]) {
      const result = publishPage({ filePath: source(name, body) });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('invalid-json');
    }
  });
});

// ---------------------------------------------------------------------------
// publishPage - failures and bounds
// ---------------------------------------------------------------------------

describe('publishPage failures', () => {
  it('missing file, unsupported extension, empty content, bad slug', () => {
    expect(publishPage({ filePath: join(tmpHome, 'missing.md') })).toMatchObject({ ok: false, reason: 'source-not-found' });
    expect(publishPage({ filePath: source('x.txt', 'hi') })).toMatchObject({ ok: false, reason: 'unsupported-format' });
    expect(publishPage({ filePath: source('empty.md', '\n\n') })).toMatchObject({ ok: false, reason: 'empty-content' });
    expect(publishPage({ filePath: source('s.md', '# T\n\nb\n'), slug: '!!!' })).toMatchObject({ ok: false, reason: 'invalid-slug' });
  });

  it('refuses sources over MAX_SOURCE_BYTES', () => {
    const file = source('big.md', `# T\n\n${'y'.repeat(MAX_SOURCE_BYTES)}`);
    expect(publishPage({ filePath: file })).toMatchObject({ ok: false, reason: 'source-too-large' });
  });
});

// ---------------------------------------------------------------------------
// listPages / readPage
// ---------------------------------------------------------------------------

describe('listPages + readPage', () => {
  it('lists newest first and never throws on an empty store', () => {
    expect(listPages()).toEqual([]);
    publishPage({ filePath: source('a.md', '# A\n\nx\n'), now: new Date('2026-01-01T00:00:00Z') });
    publishPage({ filePath: source('b.md', '# B\n\nx\n'), now: new Date('2026-02-01T00:00:00Z') });
    const pages = listPages();
    expect(pages.map((p) => p.slug)).toEqual(['b', 'a']);
    expect(pages[0]).not.toHaveProperty('markdown');
  });

  it('skips malformed records and non-page files', () => {
    publishPage({ filePath: source('good.md', '# Good\n\nx\n') });
    mkdirSync(pagesDir(), { recursive: true });
    writeFileSync(join(pagesDir(), 'broken.json'), '{not json');
    writeFileSync(join(pagesDir(), 'wrong.json'), JSON.stringify({ schemaVersion: 1, slug: 'other' }));
    writeFileSync(join(pagesDir(), 'stray.txt'), 'noise');
    const pages = listPages();
    expect(pages.map((p) => p.slug)).toEqual(['good']);
  });

  it('readPage validates slug and record shape', () => {
    expect(readPage('../etc')).toBeNull();
    expect(readPage('nope')).toBeNull();
    publishPage({ filePath: source('ok.md', '# Ok\n\nx\n') });
    expect(readPage('ok')?.markdown).toContain('# Ok');
  });

  it('caps the list at MAX_LIST', () => {
    mkdirSync(pagesDir(), { recursive: true });
    for (let i = 0; i < MAX_LIST + 5; i++) {
      writeFileSync(join(pagesDir(), `p${String(i).padStart(3, '0')}.json`), JSON.stringify({
        schemaVersion: 1, slug: `p${String(i).padStart(3, '0')}`, title: 't', markdown: 'x',
        sourceFormat: 'markdown', sourceName: 's', publishedAt: '2026-01-01T00:00:00.000Z', bytes: 1,
      }));
    }
    expect(listPages()).toHaveLength(MAX_LIST);
  });
});

// ---------------------------------------------------------------------------
// /api mount helpers (wired in src/core/web/server.ts)
// ---------------------------------------------------------------------------

describe('pagesApiGetResponse + isPagesApiPath', () => {
  it('recognizes only the pages API paths', () => {
    expect(isPagesApiPath('/api/pages')).toBe(true);
    expect(isPagesApiPath('/api/pages/weekly-report')).toBe(true);
    expect(isPagesApiPath('/api/pagesx')).toBe(false);
    expect(isPagesApiPath('/api/other')).toBe(false);
    expect(isPagesApiPath('/pages/x')).toBe(false);
  });

  it('lists pages at /api/pages', () => {
    publishPage({ filePath: source('a.md', '# A\n\nx\n') });
    const res = pagesApiGetResponse('/api/pages');
    expect(res.status).toBe(200);
    const body = res.body as { schemaVersion: number; count: number; pages: { slug: string }[] };
    expect(body.schemaVersion).toBe(1);
    expect(body.count).toBe(1);
    expect(body.pages[0]?.slug).toBe('a');
  });

  it('serves one page record at /api/pages/<slug>', () => {
    publishPage({ filePath: source('deep.md', '# Deep\n\nbody\n') });
    const res = pagesApiGetResponse('/api/pages/deep');
    expect(res.status).toBe(200);
    const body = res.body as { slug: string; markdown: string };
    expect(body.slug).toBe('deep');
    expect(body.markdown).toContain('# Deep');
  });

  it('404s unknown slugs, bad slugs and traversal attempts', () => {
    for (const path of ['/api/pages/missing', '/api/pages/../etc', '/api/pages/A_B', '/api/pages/', '/api/pages/%2e%2e']) {
      expect(pagesApiGetResponse(path).status).toBe(404);
    }
  });
});
