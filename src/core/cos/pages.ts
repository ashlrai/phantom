/**
 * core/cos/pages.ts - published report pages for the local dashboard.
 *
 * `phm pages publish <file.md|file.json>` renders a report into a page record
 * at `<ashlrHome>/pages/<slug>.json`; the loopback dashboard serves it under
 * `/pages/<slug>` (console route) backed by `GET /api/pages` and
 * `GET /api/pages/<slug>`. Briefs and chief-of-staff results can therefore
 * link a stable local page instead of pasting a report body.
 *
 * GUARDRAILS:
 *  - LOCAL ONLY: reads/writes only under <ashlrHome>/pages plus the one source
 *    file the operator names on the CLI. No network, no outward sends, nothing
 *    public: the API responses ride the same loopback read authority as every
 *    other GET under /api (enforced in src/core/web/server.ts before dispatch).
 *  - Bounded: source input capped at MAX_SOURCE_BYTES, stored page files
 *    capped at MAX_PAGE_FILE_BYTES, directory listings bounded by
 *    MAX_LIST_ENTRIES / MAX_LIST.
 *  - Atomic publish: tmp file then rename, private modes (dir 0700, file 0600).
 *  - Read paths never throw: list/read swallow malformed records and return
 *    safe defaults ([] / null).
 *  - Markdown is stored as source; rendering happens in the console through
 *    the existing marked + DOMPurify path (routes/pages/PagesView.tsx), so
 *    page HTML is always sanitized. Raw HTML embedded in a page is therefore
 *    inert - publish never trusts it.
 *  - No secrets: page records carry operator content only; nothing here
 *    reads config, env credentials, or token material.
 */

import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { basename, extname, join, resolve, sep } from 'node:path';
import { ashlrHome } from '../cloud/store.js';

// ---------------------------------------------------------------------------
// Types and constants
// ---------------------------------------------------------------------------

export const PAGES_SCHEMA_VERSION = 1;

/** A page slug is a short lowercase web-safe id: `weekly-report`, `q3-cos`. */
export const PAGE_SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{0,78}[a-z0-9])?$/;

/** Largest report source publish will read (512 KiB). */
export const MAX_SOURCE_BYTES = 512 * 1024;
/** Largest stored page record list/read will trust (1 MiB). */
export const MAX_PAGE_FILE_BYTES = 1024 * 1024;
/** Physical directory entries inspected per list call, noise included. */
export const MAX_LIST_ENTRIES = 512;
/** Most pages one list call returns. */
export const MAX_LIST = 200;
/** Front matter is scanned only this far into a Markdown source. */
const FRONT_MATTER_SCAN_LINES = 60;
/** Slug length bound (matches PAGE_SLUG_RE). */
const SLUG_MAX = 80;
/** Description length bound. */
const DESCRIPTION_MAX = 200;

export interface PublishedPage {
  schemaVersion: typeof PAGES_SCHEMA_VERSION;
  slug: string;
  title: string;
  description?: string;
  /** Report body as Markdown source; the console renders + sanitizes it. */
  markdown: string;
  sourceFormat: 'markdown' | 'json';
  /** Basename of the published source file, never a full path. */
  sourceName: string;
  publishedAt: string;
  /** Byte length of `markdown`. */
  bytes: number;
}

export interface PageSummary {
  slug: string;
  title: string;
  description?: string;
  publishedAt: string;
  bytes: number;
}

export type PublishFailureReason =
  | 'source-not-found'
  | 'source-too-large'
  | 'unsupported-format'
  | 'invalid-json'
  | 'invalid-slug'
  | 'empty-content'
  | 'write-failed';

export type PublishResult =
  | { ok: true; page: PublishedPage; file: string }
  | { ok: false; reason: PublishFailureReason; message: string };

export interface PublishOptions {
  /** Absolute or cwd-relative path to the .md/.json report source. */
  filePath: string;
  /** Optional slug override; normalized through slugify. */
  slug?: string;
  /** Optional title override. */
  title?: string;
  now?: Date;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** `<ashlrHome>/pages` - re-resolved per call so relocated homes work. */
export function pagesDir(): string {
  return join(ashlrHome(), 'pages');
}

function pageFile(slug: string): string {
  return join(pagesDir(), `${slug}.json`);
}

// ---------------------------------------------------------------------------
// Slug + title + description derivation
// ---------------------------------------------------------------------------

/**
 * Normalize any free text into a valid page slug. Returns '' when nothing
 * web-safe survives - callers treat that as invalid-slug, never a guess.
 */
export function slugify(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, SLUG_MAX)
    .replace(/-+$/g, '');
  return PAGE_SLUG_RE.test(slug) ? slug : '';
}

/** `weekly-report_2026.md` -> `weekly report 2026`. */
function titleFromFilename(filePath: string): string {
  const stem = basename(filePath).replace(/\.[^.]+$/, '');
  return stem.replace(/[-_]+/g, ' ').trim() || 'Page';
}

/** First `# heading` in Markdown, if any. */
function titleFromMarkdown(markdown: string): string | undefined {
  for (const line of markdown.split('\n')) {
    const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) return m[1]!.trim();
    if (line.trim() !== '') return undefined; // first content line was not a heading
  }
  return undefined;
}

/** First non-heading, non-fence paragraph line, shortened. */
function descriptionFromMarkdown(markdown: string): string | undefined {
  let inFence = false;
  for (const line of markdown.split('\n')) {
    const trimmed = line.trim();
    if (/^```/.test(trimmed)) { inFence = !inFence; continue; }
    if (inFence || trimmed === '' || trimmed.startsWith('#')) continue;
    const text = trimmed.replace(/[*_`>[\]()#]/g, '').trim();
    if (text === '') continue;
    return text.length > DESCRIPTION_MAX ? `${text.slice(0, DESCRIPTION_MAX - 1).trimEnd()}…` : text;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// Source parsing
// ---------------------------------------------------------------------------

interface ParsedSource {
  title?: string;
  slug?: string;
  description?: string;
  markdown: string;
}

/** Strip a leading `---` front-matter block and harvest simple scalar keys. */
function readFrontMatter(text: string): { body: string; fields: Record<string, string> } {
  const fields: Record<string, string> = {};
  const open = /^---[ \t]*\r?\n/.exec(text);
  if (!open) return { body: text, fields };
  const lines = text.slice(open[0].length).split('\n');
  // The closer must appear inside the first FRONT_MATTER_SCAN_LINES lines;
  // the body keeps every line after it, however long the document runs.
  let closer = -1;
  for (let i = 0; i < Math.min(lines.length, FRONT_MATTER_SCAN_LINES); i++) {
    if (/^---[ \t]*\r?$/.test(lines[i]!)) { closer = i; break; }
  }
  if (closer < 0) return { body: text, fields };
  for (const line of lines.slice(0, closer)) {
    const m = /^([A-Za-z][A-Za-z0-9_-]{0,40})[ \t]*:[ \t]*(.*)$/.exec(line);
    if (!m) continue;
    const value = m[2]!.trim().replace(/^["']|["']$/g, '');
    if (value !== '') fields[m[1]!.toLowerCase()] = value;
  }
  // Skip the block and the closer, plus the blank line that usually follows.
  const body = lines.slice(closer + 1).join('\n').replace(/^\r?\n+/, '');
  return { body, fields };
}

function parseMarkdownSource(text: string): ParsedSource {
  const { body, fields } = readFrontMatter(text);
  const markdown = body.trim();
  return {
    title: fields['title'],
    slug: fields['slug'],
    description: fields['description'],
    markdown,
  };
}

function parseJsonSource(text: string, filePath: string): ParsedSource | { reason: 'invalid-json' } {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return { reason: 'invalid-json' };
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) {
    return { reason: 'invalid-json' };
  }
  const record = doc as Record<string, unknown>;
  const str = (key: string): string | undefined =>
    typeof record[key] === 'string' && (record[key] as string).trim() !== ''
      ? (record[key] as string).trim() : undefined;
  const markdown = str('markdown') ?? str('body')
    // A COS result JSON without an explicit body publishes its own document:
    // the deterministic pretty-print lands in a fenced block for the console.
    ?? `\`\`\`json\n${JSON.stringify(doc, null, 2)}\n\`\`\``;
  return {
    title: str('title') ?? str('name') ?? titleFromFilename(filePath),
    ...(str('slug') !== undefined ? { slug: str('slug') } : {}),
    ...(str('description') !== undefined ? { description: str('description') } : {}),
    markdown,
  };
}

// ---------------------------------------------------------------------------
// Publish
// ---------------------------------------------------------------------------

export function publishPage(opts: PublishOptions): PublishResult {
  const filePath = resolve(opts.filePath);
  const now = opts.now ?? new Date();

  let size: number;
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) {
      return { ok: false, reason: 'source-not-found', message: `not a regular file: ${opts.filePath}` };
    }
    size = stat.size;
  } catch {
    return { ok: false, reason: 'source-not-found', message: `cannot read source file: ${opts.filePath}` };
  }
  if (size > MAX_SOURCE_BYTES) {
    return { ok: false, reason: 'source-too-large', message: `source exceeds ${MAX_SOURCE_BYTES} bytes` };
  }
  // Publishing a store file back into itself is legal but useless; still allow
  // it - the record lands as a normal page.
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch {
    return { ok: false, reason: 'source-not-found', message: `cannot read source file: ${opts.filePath}` };
  }
  // Re-check after the read: the file may have grown between stat and read.
  if (Buffer.byteLength(text, 'utf8') > MAX_SOURCE_BYTES) {
    return { ok: false, reason: 'source-too-large', message: `source exceeds ${MAX_SOURCE_BYTES} bytes` };
  }

  const ext = extname(filePath).toLowerCase();
  let parsed: ParsedSource | { reason: 'invalid-json' };
  let sourceFormat: PublishedPage['sourceFormat'];
  if (ext === '.md' || ext === '.markdown') {
    sourceFormat = 'markdown';
    parsed = parseMarkdownSource(text);
  } else if (ext === '.json') {
    sourceFormat = 'json';
    parsed = parseJsonSource(text, filePath);
  } else {
    return { ok: false, reason: 'unsupported-format', message: `unsupported extension "${ext || '(none)'}" - publish a .md or .json file` };
  }
  if ('reason' in parsed) {
    return { ok: false, reason: parsed.reason, message: 'JSON source must be an object (optionally {title, slug, description, markdown|body})' };
  }

  const markdown = parsed.markdown.trim();
  if (markdown === '') {
    return { ok: false, reason: 'empty-content', message: 'report produced no page content' };
  }

  const slug = slugify(opts.slug ?? parsed.slug ?? basename(filePath).replace(/\.[^.]+$/, ''));
  if (slug === '') {
    return { ok: false, reason: 'invalid-slug', message: 'no web-safe slug could be derived - pass --slug <a-z0-9-slug>' };
  }

  const title = (opts.title ?? parsed.title ?? titleFromMarkdown(markdown) ?? titleFromFilename(filePath)).slice(0, 200);
  const rawDescription = parsed.description ?? descriptionFromMarkdown(markdown);
  const description = rawDescription !== undefined && rawDescription.length > DESCRIPTION_MAX
    ? `${rawDescription.slice(0, DESCRIPTION_MAX - 1).trimEnd()}…`
    : rawDescription;

  const page: PublishedPage = {
    schemaVersion: PAGES_SCHEMA_VERSION,
    slug,
    title,
    ...(description !== undefined ? { description } : {}),
    markdown,
    sourceFormat,
    sourceName: basename(filePath),
    publishedAt: now.toISOString(),
    bytes: Buffer.byteLength(markdown, 'utf8'),
  };

  const dir = pagesDir();
  const file = pageFile(slug);
  // Guard the store path itself (defense in depth - the slug grammar already
  // makes `..` and separators impossible, so this should never fire).
  const rootWithSep = resolve(dir) + sep;
  if (!resolve(file).startsWith(rootWithSep)) {
    return { ok: false, reason: 'invalid-slug', message: 'resolved page path escaped the pages store' };
  }
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = join(dir, `.${slug}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
    writeFileSync(tmp, `${JSON.stringify(page)}\n`, { mode: 0o600 });
    renameSync(tmp, file);
  } catch (err) {
    return { ok: false, reason: 'write-failed', message: `could not write ${file}: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { ok: true, page, file };
}

// ---------------------------------------------------------------------------
// Read paths (never throw)
// ---------------------------------------------------------------------------

function parsePageRecord(raw: unknown, slug: string): PublishedPage | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (
    record.schemaVersion !== PAGES_SCHEMA_VERSION
    || record.slug !== slug
    || typeof record.title !== 'string'
    || typeof record.markdown !== 'string'
    || record.markdown === ''
    || typeof record.publishedAt !== 'string'
    || (record.sourceFormat !== 'markdown' && record.sourceFormat !== 'json')
    || typeof record.bytes !== 'number'
  ) return null;
  return {
    schemaVersion: PAGES_SCHEMA_VERSION,
    slug,
    title: record.title,
    ...(typeof record.description === 'string' ? { description: record.description } : {}),
    markdown: record.markdown,
    sourceFormat: record.sourceFormat,
    sourceName: typeof record.sourceName === 'string' ? record.sourceName : '',
    publishedAt: record.publishedAt,
    bytes: record.bytes,
  };
}

function readPageFile(slug: string): PublishedPage | null {
  try {
    const file = pageFile(slug);
    if (statSync(file).size > MAX_PAGE_FILE_BYTES) return null;
    return parsePageRecord(JSON.parse(readFileSync(file, 'utf8')), slug);
  } catch {
    return null;
  }
}

/** Full page record for one slug, or null. */
export function readPage(slug: string): PublishedPage | null {
  if (!PAGE_SLUG_RE.test(slug)) return null;
  return readPageFile(slug);
}

function summarize(page: PublishedPage): PageSummary {
  return {
    slug: page.slug,
    title: page.title,
    ...(page.description !== undefined ? { description: page.description } : {}),
    publishedAt: page.publishedAt,
    bytes: page.bytes,
  };
}

/** Newest-first summaries of every valid stored page. Never throws. */
export function listPages(limit = MAX_LIST): PageSummary[] {
  let names: string[];
  try {
    names = readdirSync(pagesDir());
  } catch {
    return [];
  }
  const summaries: PageSummary[] = [];
  let inspected = 0;
  for (const name of names) {
    if (inspected >= MAX_LIST_ENTRIES || summaries.length >= limit) break;
    inspected += 1;
    if (!name.endsWith('.json')) continue;
    const slug = name.slice(0, -5);
    if (!PAGE_SLUG_RE.test(slug)) continue;
    const page = readPageFile(slug);
    if (page) summaries.push(summarize(page));
  }
  return summaries.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt) || a.slug.localeCompare(b.slug));
}

// ---------------------------------------------------------------------------
// Loopback API payload (mounted by src/core/web/server.ts under read authority)
// ---------------------------------------------------------------------------

export const PAGES_API_PATH = '/api/pages';

export function isPagesApiPath(pathname: string): boolean {
  return pathname === PAGES_API_PATH || pathname.startsWith(`${PAGES_API_PATH}/`);
}

/**
 * Pure GET payload for the pages API: `/api/pages` lists summaries and
 * `/api/pages/<slug>` returns one full record. The caller writes the HTTP
 * response; this never throws and never answers non-GET semantics.
 */
export function pagesApiGetResponse(pathname: string): { status: number; body: unknown } {
  if (pathname === PAGES_API_PATH) {
    const pages = listPages();
    return { status: 200, body: { schemaVersion: PAGES_SCHEMA_VERSION, count: pages.length, pages } };
  }
  let slug = '';
  try {
    slug = decodeURIComponent(pathname.slice(PAGES_API_PATH.length + 1));
  } catch {
    slug = '';
  }
  if (!PAGE_SLUG_RE.test(slug)) {
    return { status: 404, body: { error: 'page not found' } };
  }
  const page = readPage(slug);
  if (!page) {
    return { status: 404, body: { error: 'page not found' } };
  }
  return {
    status: 200,
    body: {
      schemaVersion: PAGES_SCHEMA_VERSION,
      slug: page.slug,
      title: page.title,
      ...(page.description !== undefined ? { description: page.description } : {}),
      markdown: page.markdown,
      sourceFormat: page.sourceFormat,
      sourceName: page.sourceName,
      publishedAt: page.publishedAt,
      bytes: page.bytes,
    },
  };
}
