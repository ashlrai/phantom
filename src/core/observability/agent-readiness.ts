/**
 * agent-readiness.ts - offline agentic-readiness scorer for a local site
 * build dir or a repo checkout.
 *
 * Reads only files inside the scored root, never the network, never a model,
 * and never writes unless the caller explicitly asks for artifacts. Reads are
 * bounded (file count and byte caps) so a hostile or pathological tree cannot
 * hang or exhaust the process.
 *
 * Output contract: `agent-readiness.v1` JSON, one artifact per scored target,
 * written under `$ASHLR_HOME/metrics/agent-readiness/` (default
 * `~/.ashlr/metrics/agent-readiness/`) - the same metrics inputs tree that
 * RQ-METRICS-IMPACT-SCORE reads, so an impact reader can reward score gains.
 * Each artifact records `previous` and `delta` when an artifact already
 * exists at the output path, which is the gain signal.
 */

import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join } from 'node:path';

export const AGENT_READINESS_SCHEMA = 'agent-readiness.v1' as const;

// Bounds: enough for a real site, small enough that a pathological tree fails
// fast rather than scanning forever.
const MAX_FILES = 4_000;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_HTML_PAGES = 200;
const MAX_HTML_BYTES = 1024 * 1024;
const MAX_TEXT_BYTES = 1024 * 1024;

// ---------------------------------------------------------------------------
// Source abstraction: a scored target is a read-only listing of files. The fs
// implementation walks a directory; the memory implementation backs tests.
// ---------------------------------------------------------------------------

export interface AgentReadinessSource {
  /** POSIX-relative paths of every regular file under the root. */
  listFiles(): string[];
  /** UTF-8 text of a file, or undefined when absent, non-regular, or oversized. */
  readText(path: string): string | undefined;
  /** Byte size of a file, or undefined when absent or non-regular. */
  sizeBytes(path: string): number | undefined;
}

function normalizeRel(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\.\//, '').replace(/^\//, '');
}

export function createMemoryReadinessSource(
  files: Record<string, string | Uint8Array>,
): AgentReadinessSource {
  const map = new Map<string, Buffer>();
  for (const [name, contents] of Object.entries(files)) {
    map.set(normalizeRel(name), Buffer.isBuffer(contents) ? contents : Buffer.from(String(contents)));
  }
  return {
    listFiles: () => [...map.keys()].sort(),
    readText: (path) => {
      const bytes = map.get(normalizeRel(path));
      if (!bytes || bytes.length > MAX_FILE_BYTES) return undefined;
      return bytes.toString('utf8');
    },
    sizeBytes: (path) => map.get(normalizeRel(path))?.length,
  };
}

/**
 * Real directory source. Refuses symlinked entries outright: the scorer is
 * read-only, and following links would let a fixture point outside the root.
 * Read failures surface as absent files rather than thrown errors: a check
 * that cannot read its input scores zero for that input, and the walk itself
 * throws only when the root is missing or not a directory.
 */
export function createFsReadinessSource(root: string): AgentReadinessSource {
  const resolved = realpathSync(root);
  const rootStat = lstatSync(resolved);
  if (!rootStat.isDirectory()) throw new Error('Readiness target is not a directory.');

  let cached: string[] | null = null;
  const walk = (): string[] => {
    if (cached) return cached;
    const out: string[] = [];
    const stack = [''];
    while (stack.length && out.length < MAX_FILES) {
      const dir = stack.pop()!;
      let entries;
      try {
        entries = readdirSync(join(resolved, dir), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (out.length >= MAX_FILES) break;
        const rel = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) stack.push(rel);
        else if (entry.isFile()) out.push(rel);
      }
    }
    cached = out.sort();
    return cached;
  };

  const stat = (path: string) => {
    const rel = normalizeRel(path);
    // Defense in depth: callers only pass root-relative names, but never let a
    // `..` segment escape the scored root if that ever changes.
    if (rel.split('/').includes('..')) return null;
    try {
      const s = lstatSync(join(resolved, rel));
      return s.isFile() && !s.isSymbolicLink() ? s : null;
    } catch {
      return null;
    }
  };

  return {
    listFiles: walk,
    readText: (path) => {
      const s = stat(path);
      if (!s || s.size > MAX_FILE_BYTES) return undefined;
      try {
        return readFileSync(join(resolved, normalizeRel(path)), 'utf8');
      } catch {
        return undefined;
      }
    },
    sizeBytes: (path) => stat(path)?.size,
  };
}

// ---------------------------------------------------------------------------
// Report contract
// ---------------------------------------------------------------------------

export const AGENT_READINESS_CHECK_IDS = [
  'llmsTxt',
  'agentsMd',
  'jsonLd',
  'sitemapRobots',
  'openGraph',
  'canonical',
  'headings',
  'capabilities',
  'mcpServer',
  'pageWeight',
] as const;

export type AgentReadinessCheckId = (typeof AGENT_READINESS_CHECK_IDS)[number];

/** Weights sum to 100; each check contributes weight * score (0..1) points. */
export const AGENT_READINESS_WEIGHTS: Readonly<Record<AgentReadinessCheckId, number>> = {
  llmsTxt: 15,
  agentsMd: 10,
  jsonLd: 10,
  sitemapRobots: 10,
  openGraph: 10,
  canonical: 10,
  headings: 10,
  capabilities: 10,
  mcpServer: 10,
  pageWeight: 5,
};

export type AgentReadinessTargetKind = 'site' | 'repo';

export interface AgentReadinessCheckResult {
  id: AgentReadinessCheckId;
  weight: number;
  /** False when the check cannot apply to this target kind (excluded from the denominator). */
  applicable: boolean;
  /** 0..1 rubric score for the check; 0 when not applicable. */
  score: number;
  /** weight * score when applicable, else 0. */
  points: number;
  findings: string[];
}

export interface AgentReadinessReport {
  schema: typeof AGENT_READINESS_SCHEMA;
  generatedAt: string;
  target: { kind: AgentReadinessTargetKind; path: string; label: string };
  /** 0..100, one decimal. Earned points normalized over applicable weight. */
  score: number;
  totals: { earned: number; applicable: number; possible: number };
  checks: AgentReadinessCheckResult[];
  previous: { score: number; generatedAt: string } | null;
  delta: number | null;
}

// ---------------------------------------------------------------------------
// Small HTML / text helpers (deliberately small grammars, not a DOM parser)
// ---------------------------------------------------------------------------

const has = (text: string | undefined): text is string => typeof text === 'string' && text.length > 0;

function attr(tag: string, name: string): string | undefined {
  const m = new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i').exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3]) : undefined;
}

function metaTags(html: string): Array<{ name?: string; property?: string; content?: string }> {
  const out: Array<{ name?: string; property?: string; content?: string }> = [];
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    out.push({ name: attr(m[0], 'name'), property: attr(m[0], 'property'), content: attr(m[0], 'content') });
  }
  return out;
}

function metaContent(html: string, key: string): string | undefined {
  const lower = key.toLowerCase();
  for (const tag of metaTags(html)) {
    if ((tag.name ?? tag.property ?? '').toLowerCase() === lower) return tag.content;
  }
  return undefined;
}

function linkTags(html: string, rel: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
    const rels = (attr(m[0], 'rel') ?? '').toLowerCase().split(/\s+/);
    if (rels.includes(rel)) {
      const href = attr(m[0], 'href');
      if (href !== undefined) out.push(href);
    }
  }
  return out;
}

function jsonLdBlocks(html: string): string[] {
  const out: string[] = [];
  const re = /<script\b[^>]*type\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)(?:<\/script>|$)/gi;
  for (const m of html.matchAll(re)) out.push(m[1] ?? '');
  return out;
}

interface JsonLdNode { types: string[]; name?: string }

function jsonLdNodes(value: unknown, seen: Set<unknown> = new Set()): JsonLdNode[] {
  if (!value || typeof value !== 'object' || seen.has(value)) return [];
  seen.add(value);
  if (Array.isArray(value)) return value.flatMap((v) => jsonLdNodes(v, seen));
  const row = value as Record<string, unknown>;
  const self: JsonLdNode = {
    types: (Array.isArray(row['@type']) ? row['@type'] : [row['@type']]).filter((t): t is string => typeof t === 'string'),
    ...(typeof row['name'] === 'string' ? { name: row['name'] } : {}),
  };
  const nested = [row['@graph'], row['mainEntity'], row['itemListElement']]
    .flatMap((v) => (Array.isArray(v) ? v : v ? [v] : []));
  return [self, ...nested.flatMap((v) => jsonLdNodes(v, seen))];
}

function headingLevels(html: string): number[] {
  const out: number[] = [];
  for (const m of html.matchAll(/<h([1-6])\b[^>]*>/gi)) out.push(Number(m[1]));
  return out;
}

function markdownLinks(text: string): number {
  return (text.match(/\[[^\]]{1,200}\]\([^)\s]{1,500}\)/g) ?? []).length;
}

// ---------------------------------------------------------------------------
// File lookup helpers
// ---------------------------------------------------------------------------

function findFile(source: AgentReadinessSource, names: string[]): string | undefined {
  const lower = new Map(source.listFiles().map((f) => [f.toLowerCase(), f]));
  for (const name of names) {
    const hit = lower.get(name.toLowerCase());
    if (hit) return hit;
  }
  return undefined;
}

function htmlFiles(source: AgentReadinessSource): string[] {
  return source
    .listFiles()
    .filter((f) => /\.(html?|xhtml)$/i.test(f))
    .slice(0, MAX_HTML_PAGES);
}

function readPage(source: AgentReadinessSource, path: string): string | undefined {
  const size = source.sizeBytes(path);
  if (size === undefined || size > MAX_HTML_BYTES) return undefined;
  return source.readText(path);
}

// ---------------------------------------------------------------------------
// Checks. Each returns { score, findings } in 0..1; applicability is decided
// by the caller so a repo checkout is not penalized for having no pages.
// ---------------------------------------------------------------------------

interface CheckOutcome { score: number; findings: string[] }

function scoreLlmsTxt(source: AgentReadinessSource): CheckOutcome {
  const findings: string[] = [];
  const grade = (text: string | undefined, name: string): { score: number; notes: string[] } => {
    if (!has(text)) return { score: 0, notes: [`${name} missing`] };
    if (text.length > MAX_TEXT_BYTES) return { score: 0.2, notes: [`${name} exceeds ${MAX_TEXT_BYTES} bytes`] };
    const notes: string[] = [];
    let score = 0.4; // present and readable
    const h1 = /(^|\n)#\s+\S/.test(text.slice(0, 4000));
    const links = markdownLinks(text);
    const sections = (text.match(/(^|\n)##\s+\S/g) ?? []).length;
    if (h1) score += 0.2; else notes.push(`${name} has no H1 title`);
    if (links >= 3) score += 0.25;
    else { score += links * 0.05; notes.push(`${name} lists ${links} markdown link(s)`); }
    if (sections >= 1) score += 0.15; else notes.push(`${name} has no section headings`);
    return { score: Math.min(1, score), notes };
  };
  const llms = grade(source.readText(findFile(source, ['llms.txt', 'docs/llms.txt']) ?? 'llms.txt'), 'llms.txt');
  const full = grade(
    source.readText(findFile(source, ['llms-full.txt', 'docs/llms-full.txt']) ?? 'llms-full.txt'),
    'llms-full.txt',
  );
  findings.push(...llms.notes, ...full.notes);
  return { score: Math.round((0.6 * llms.score + 0.4 * full.score) * 1000) / 1000, findings };
}

function scoreAgentsMd(source: AgentReadinessSource): CheckOutcome {
  const path = findFile(source, ['AGENTS.md', 'agents.md', 'docs/AGENTS.md', 'CLAUDE.md']);
  if (!path) return { score: 0, findings: ['AGENTS.md missing'] };
  const text = source.readText(path);
  if (!has(text)) return { score: 0.1, findings: [`${path} is empty or unreadable`] };
  const findings: string[] = [];
  let score = 0.3; // present and readable
  if (text.length >= 400) score += 0.2; else findings.push(`${path} is thin (${text.length} bytes)`);
  const sections = (text.match(/(^|\n)#{1,3}\s+\S/g) ?? []).length;
  if (sections >= 2) score += 0.2; else findings.push(`${path} has ${sections} heading(s)`);
  if (/\b(?:npm|pnpm|yarn|bun|deno|make|cargo|go test|pytest|vitest|jest|gradle|mvn|dotnet|composer|tsc|eslint|docker)\b/i.test(text)) {
    score += 0.2;
  } else findings.push(`${path} names no runnable tooling`);
  if (/\b(?:build|test|lint|install|run|verify|check)\b/i.test(text)) score += 0.1;
  else findings.push(`${path} has no build/test guidance`);
  if (score >= 1) findings.push(`${path} covers structure, tooling and verification`);
  return { score: Math.min(1, score), findings };
}

const APPLICATION_TYPES = new Set(['softwareapplication', 'webapplication', 'mobileapplication']);

function scoreJsonLd(source: AgentReadinessSource): CheckOutcome {
  const pages = htmlFiles(source).map((p) => ({ p, html: readPage(source, p) })).filter((x): x is { p: string; html: string } => x.html !== undefined);
  let sawJsonLd = false;
  let sawParseError = false;
  let sawApplication = false;
  for (const { html } of pages) {
    for (const block of jsonLdBlocks(html)) {
      sawJsonLd = true;
      try {
        const nodes = jsonLdNodes(JSON.parse(block));
        if (nodes.some((n) => n.types.some((t) => APPLICATION_TYPES.has(t.toLowerCase())) && n.name)) {
          sawApplication = true;
        }
      } catch {
        sawParseError = true;
      }
    }
  }
  if (sawApplication) return { score: 1, findings: ['SoftwareApplication JSON-LD with a name found'] };
  if (sawParseError) return { score: 0.2, findings: ['a JSON-LD block failed to parse'] };
  if (sawJsonLd) return { score: 0.4, findings: ['JSON-LD present but no named SoftwareApplication'] };
  return { score: 0, findings: ['no application/ld+json blocks found'] };
}

function scoreSitemapRobots(source: AgentReadinessSource): CheckOutcome {
  const findings: string[] = [];
  const sitemapPath = findFile(source, ['sitemap.xml', 'sitemap_index.xml']);
  const sitemap = sitemapPath ? source.readText(sitemapPath) : undefined;
  let sitemapScore = 0;
  if (sitemapPath && has(sitemap)) {
    const locs = (sitemap.match(/<loc\b[^>]*>/gi) ?? []).length;
    if (/<urlset\b/i.test(sitemap) && locs > 0) sitemapScore = 1;
    else if (/<sitemapindex\b/i.test(sitemap) && locs > 0) sitemapScore = 1;
    else { sitemapScore = 0.3; findings.push(`${sitemapPath} has no <loc> entries`); }
    if (sitemapScore === 1) findings.push(`${sitemapPath} lists ${locs} URL(s)`);
  } else findings.push('sitemap.xml missing');
  const robotsPath = findFile(source, ['robots.txt']);
  const robots = robotsPath ? source.readText(robotsPath) : undefined;
  const robotsPresent = has(robots) && robots.trim().length > 0;
  const robotsLinksSitemap = robotsPresent && /^sitemap:\s*\S+/im.test(robots!);
  if (!robotsPresent) findings.push('robots.txt missing or empty');
  else if (!robotsLinksSitemap) findings.push(`${robotsPath} does not declare a Sitemap:`);
  else findings.push(`${robotsPath} declares a Sitemap:`);
  return { score: 0.6 * sitemapScore + (robotsPresent ? 0.2 : 0) + (robotsLinksSitemap ? 0.2 : 0), findings };
}

const OG_CORE = ['title', 'description', 'og:title', 'og:description'] as const;
const OG_EXTENDED = ['og:type', 'og:url', 'og:image', 'twitter:card'] as const;

function scoreOpenGraph(source: AgentReadinessSource): CheckOutcome {
  const findings: string[] = [];
  const pages = htmlFiles(source).map((p) => ({ p, html: readPage(source, p) })).filter((x): x is { p: string; html: string } => x.html !== undefined);
  if (!pages.length) return { score: 0, findings: ['no HTML pages to inspect'] };
  let total = 0;
  for (const { p, html } of pages) {
    let page = 0;
    const missing: string[] = [];
    const title = /<title\b[^>]*>[^<]*\S[^<]*<\/title>/i.test(html);
    const signals: Record<string, boolean> = {
      title,
      'description': has(metaContent(html, 'description')),
      'og:title': has(metaContent(html, 'og:title')),
      'og:description': has(metaContent(html, 'og:description')),
      'og:type': has(metaContent(html, 'og:type')),
      'og:url': has(metaContent(html, 'og:url')),
      'og:image': has(metaContent(html, 'og:image')),
      'twitter:card': has(metaContent(html, 'twitter:card')),
    };
    for (const key of OG_CORE) page += signals[key] ? 0.15 : 0;
    for (const key of OG_EXTENDED) page += signals[key] ? 0.1 : 0;
    for (const key of [...OG_CORE, ...OG_EXTENDED]) if (!signals[key]) missing.push(key === 'title' ? '<title>' : key);
    if (missing.length) findings.push(`${p}: missing ${missing.join(', ')}`);
    total += page;
  }
  const score = Math.round((total / pages.length) * 1000) / 1000;
  if (!findings.length) findings.push(`all ${pages.length} page(s) carry core meta and OpenGraph tags`);
  return { score, findings };
}

function scoreCanonical(source: AgentReadinessSource): CheckOutcome {
  const findings: string[] = [];
  const pages = htmlFiles(source).map((p) => ({ p, html: readPage(source, p) })).filter((x): x is { p: string; html: string } => x.html !== undefined);
  if (!pages.length) return { score: 0, findings: ['no HTML pages to inspect'] };
  let total = 0;
  for (const { p, html } of pages) {
    const hrefs = linkTags(html, 'canonical');
    if (!hrefs.length) { findings.push(`${p}: no rel=canonical`); continue; }
    if (hrefs.some((h) => /^https?:\/\/\S+/i.test(h))) { total += 1; continue; }
    total += 0.4;
    findings.push(`${p}: canonical is not an absolute http(s) URL`);
  }
  return { score: Math.round((total / pages.length) * 1000) / 1000, findings };
}

function scoreHeadings(source: AgentReadinessSource): CheckOutcome {
  const findings: string[] = [];
  const pages = htmlFiles(source).map((p) => ({ p, html: readPage(source, p) })).filter((x): x is { p: string; html: string } => x.html !== undefined);
  if (!pages.length) return { score: 0, findings: ['no HTML pages to inspect'] };
  let valid = 0;
  for (const { p, html } of pages) {
    const levels = headingLevels(html);
    if (!levels.length) { valid += 1; continue; } // no headings: nothing to violate
    const h1s = levels.filter((l) => l === 1).length;
    let skip = 0;
    for (let i = 1; i < levels.length; i++) if (levels[i]! > levels[i - 1]! + 1) skip++;
    if (h1s === 1 && skip === 0) { valid += 1; continue; }
    const why = [h1s !== 1 ? `${h1s} h1 element(s)` : '', skip ? `${skip} skipped level(s)` : '']
      .filter(Boolean)
      .join(', ');
    findings.push(`${p}: ${why}`);
  }
  const score = Math.round((valid / pages.length) * 1000) / 1000;
  if (valid === pages.length) findings.push(`heading order is semantic on ${valid} page(s)`);
  return { score, findings };
}

const CAPABILITY_JSON_CANDIDATES = [
  'capabilities.json',
  'agent-capabilities.json',
  '.well-known/capabilities.json',
  '.well-known/agent-capabilities.json',
  '.well-known/ai-plugin.json',
  'install.json',
];
const CAPABILITY_HTML_CANDIDATES = [
  'install.html',
  'install/index.html',
  'docs/install.html',
  'getting-started.html',
  'quickstart.html',
];
const CAPABILITY_MD_CANDIDATES = [
  'INSTALL.md',
  'install.md',
  'docs/INSTALL.md',
  'docs/install.md',
  'docs/GETTING-STARTED.md',
  'docs/QUICKSTART.md',
];

const INSTALL_COMMAND = /\b(?:npm (?:i|install|create)|npx|pnpm (?:add|create|dlx)|yarn (?:add|create|dlx)|bunx?|brew install|pip install|cargo install|go install|curl\b[^|]*\|\s*(?:ba|z)?sh|docker run)\b/i;

function scoreCapabilities(source: AgentReadinessSource): CheckOutcome {
  const jsonPath = findFile(source, CAPABILITY_JSON_CANDIDATES);
  if (jsonPath) {
    const text = source.readText(jsonPath);
    try {
      const value = JSON.parse(text ?? '') as unknown;
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const keys = ['name', 'version', 'description', 'capabilities', 'install', 'commands', 'tools']
          .filter((k) => (value as Record<string, unknown>)[k] !== undefined);
        if (keys.length >= 2) {
          return { score: 1, findings: [`${jsonPath} is machine-readable (${keys.join(', ')})`] };
        }
        return { score: 0.6, findings: [`${jsonPath} parses but declares only ${keys.join(', ') || 'nothing'}`] };
      }
    } catch {
      return { score: 0.2, findings: [`${jsonPath} is not valid JSON`] };
    }
    return { score: 0.2, findings: [`${jsonPath} is not a JSON object`] };
  }
  for (const candidate of CAPABILITY_HTML_CANDIDATES) {
    const text = source.readText(candidate);
    if (has(text) && /<pre\b|<code\b/i.test(text) && INSTALL_COMMAND.test(text)) {
      return { score: 0.5, findings: [`${candidate} documents install commands as HTML`] };
    }
  }
  for (const candidate of CAPABILITY_MD_CANDIDATES) {
    const text = source.readText(candidate);
    if (has(text) && INSTALL_COMMAND.test(text)) {
      return { score: 0.4, findings: [`${candidate} documents install commands as Markdown`] };
    }
  }
  return { score: 0, findings: ['no machine-readable capabilities or install page found'] };
}

const MCP_SERVER_CANDIDATES = ['server.json', '.well-known/mcp/server.json', 'mcp/server.json'];
// Registry names are a dotted reverse-DNS namespace plus a name: `io.github.owner/tool`.
const MCP_NAME = /^[a-z0-9]+(?:\.[a-z0-9]+)+\/[a-z0-9][a-z0-9._-]*$/i;

function scoreMcpServer(source: AgentReadinessSource): CheckOutcome {
  const path = findFile(source, MCP_SERVER_CANDIDATES);
  if (!path) return { score: 0, findings: ['no MCP server.json found'] };
  const text = source.readText(path);
  if (!has(text)) return { score: 0.1, findings: [`${path} is empty or unreadable`] };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { score: 0.2, findings: [`${path} is not valid JSON`] };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { score: 0.2, findings: [`${path} is not a JSON object`] };
  }
  const row = value as Record<string, unknown>;
  const missing: string[] = [];
  if (typeof row['name'] !== 'string' || !MCP_NAME.test(row['name'])) missing.push('name (namespace/name)');
  if (typeof row['description'] !== 'string' || !row['description'].trim()) missing.push('description');
  if (typeof row['version'] !== 'string' || !row['version'].trim()) missing.push('version');
  const packages = Array.isArray(row['packages']) ? row['packages'].length : 0;
  const remotes = Array.isArray(row['remotes']) ? row['remotes'].length : 0;
  if (!packages && !remotes) missing.push('packages or remotes');
  if (missing.length) return { score: 0.4, findings: [`${path} is missing ${missing.join(', ')}`] };
  return { score: 1, findings: [`${path} declares ${String(row['name'])}`] };
}

function scorePageWeight(source: AgentReadinessSource): CheckOutcome {
  const files = source.listFiles();
  const html = files.filter((f) => /\.(html?|xhtml)$/i.test(f));
  let total = 0;
  let maxPage = 0;
  let unknown = 0;
  for (const file of files) {
    const size = source.sizeBytes(file);
    if (size === undefined) { unknown += 1; continue; }
    total += size;
    if (/\.(html?|xhtml)$/i.test(file)) maxPage = Math.max(maxPage, size);
  }
  const kib = (n: number) => `${Math.round(n / 1024)} KiB`;
  const findings: string[] = [];
  if (unknown) findings.push(`${unknown} file(s) could not be measured`);
  const perPage = maxPage <= 128 * 1024 ? 1 : maxPage <= 512 * 1024 ? 0.6 : 0.2;
  const totalScore = total <= 2 * 1024 * 1024 ? 1 : total <= 16 * 1024 * 1024 ? 0.6 : 0.2;
  findings.push(`largest page ${kib(maxPage)}, ${files.length} file(s) totalling ${kib(total)}`);
  if (!html.length) findings.push('no HTML pages measured');
  return { score: 0.5 * perPage + 0.5 * totalScore, findings };
}

// ---------------------------------------------------------------------------
// Scoring entry points
// ---------------------------------------------------------------------------

const REPO_APPLICABLE: ReadonlySet<AgentReadinessCheckId> = new Set<AgentReadinessCheckId>([
  'llmsTxt', 'agentsMd', 'capabilities', 'mcpServer',
]);

const CHECK_RUNNERS: Record<AgentReadinessCheckId, (source: AgentReadinessSource) => CheckOutcome> = {
  llmsTxt: scoreLlmsTxt,
  agentsMd: scoreAgentsMd,
  jsonLd: scoreJsonLd,
  sitemapRobots: scoreSitemapRobots,
  openGraph: scoreOpenGraph,
  canonical: scoreCanonical,
  headings: scoreHeadings,
  capabilities: scoreCapabilities,
  mcpServer: scoreMcpServer,
  pageWeight: scorePageWeight,
};

export interface ScoreAgentReadinessOptions {
  kind: AgentReadinessTargetKind;
  source: AgentReadinessSource;
  /** Display path recorded in the artifact; defaults to the source root label. */
  path?: string;
  label?: string;
  /** ISO timestamp override; defaults to the current time. */
  now?: string;
  /** Previously emitted artifact, used to compute `previous` and `delta`. */
  previous?: { score: number; generatedAt: string } | null;
}

export function scoreAgentReadinessTarget(options: ScoreAgentReadinessOptions): AgentReadinessReport {
  const { kind, source } = options;
  const checks: AgentReadinessCheckResult[] = AGENT_READINESS_CHECK_IDS.map((id) => {
    const applicable = kind === 'site' || REPO_APPLICABLE.has(id);
    const weight = AGENT_READINESS_WEIGHTS[id];
    if (!applicable) {
      return { id, weight, applicable, score: 0, points: 0, findings: ['not applicable to a repo checkout'] };
    }
    const outcome = CHECK_RUNNERS[id](source);
    const score = Math.round(Math.max(0, Math.min(1, outcome.score)) * 1000) / 1000;
    return { id, weight, applicable, score, points: Math.round(weight * score * 100) / 100, findings: outcome.findings };
  });
  const applicable = checks.filter((c) => c.applicable).reduce((sum, c) => sum + c.weight, 0);
  const earned = checks.reduce((sum, c) => sum + c.points, 0);
  const score = applicable > 0 ? Math.round((earned / applicable) * 1000) / 10 : 0;
  const previous = options.previous ?? null;
  return {
    schema: AGENT_READINESS_SCHEMA,
    generatedAt: options.now ?? new Date().toISOString(),
    target: {
      kind,
      path: options.path ?? '.',
      label: options.label ?? (basename((options.path ?? '.').replace(/[/\\]+$/, '') || '.') || '.'),
    },
    score,
    totals: { earned: Math.round(earned * 100) / 100, applicable, possible: checks.reduce((s, c) => s + c.weight, 0) },
    checks,
    previous,
    delta: previous ? Math.round((score - previous.score) * 10) / 10 : null,
  };
}

// ---------------------------------------------------------------------------
// Artifact persistence and validation
// ---------------------------------------------------------------------------

/** Metrics inputs tree shared with the RQ-METRICS-IMPACT-SCORE job source. */
export function defaultAgentReadinessDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['ASHLR_HOME'];
  const home = configured && isAbsolute(configured) ? configured : join(homedir(), '.ashlr');
  return join(home, 'metrics', 'agent-readiness');
}

export function agentReadinessArtifactName(report: Pick<AgentReadinessReport, 'target'>): string {
  const slug = report.target.label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'target';
  return `${report.target.kind}-${slug}.json`;
}

const ISO_STAMP = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?Z$/;

function assertReadiness(value: unknown, context: string): asserts value is AgentReadinessReport {
  const fail = (): never => { throw new Error(`Invalid agent-readiness artifact (${context}).`); };
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const row = value as Record<string, unknown>;
  if (row['schema'] !== AGENT_READINESS_SCHEMA) fail();
  if (typeof row['generatedAt'] !== 'string' || !ISO_STAMP.test(row['generatedAt'])) fail();
  const target = row['target'];
  if (!target || typeof target !== 'object' || Array.isArray(target)) fail();
  const t = target as Record<string, unknown>;
  if (!['site', 'repo'].includes(t['kind'] as string)) fail();
  if (typeof t['path'] !== 'string' || typeof t['label'] !== 'string' || !t['label']) fail();
  if (typeof row['score'] !== 'number' || !Number.isFinite(row['score']) || row['score'] < 0 || row['score'] > 100) fail();
  const totals = row['totals'];
  if (!totals || typeof totals !== 'object') fail();
  const tt = totals as Record<string, number>;
  if ([tt['earned'], tt['applicable'], tt['possible']].some((n) => typeof n !== 'number' || !Number.isFinite(n) || n < 0)) fail();
  const checkRows = row['checks'];
  if (!Array.isArray(checkRows)) fail();
  const seen = new Set<string>();
  for (const check of checkRows as unknown[]) {
    if (!check || typeof check !== 'object' || Array.isArray(check)) fail();
    const c = check as Record<string, unknown>;
    const id = c['id'];
    if (typeof id !== 'string' || seen.has(id) || !(AGENT_READINESS_CHECK_IDS as readonly string[]).includes(id)) fail();
    seen.add(id as string);
    if (typeof c['weight'] !== 'number' || typeof c['score'] !== 'number' || c['score'] < 0 || c['score'] > 1) fail();
    if (typeof c['applicable'] !== 'boolean' || typeof c['points'] !== 'number') fail();
    if (!Array.isArray(c['findings']) || c['findings'].some((f) => typeof f !== 'string')) fail();
  }
  if (seen.size !== AGENT_READINESS_CHECK_IDS.length) fail();
  if (row['previous'] !== null) {
    const p = row['previous'];
    if (!p || typeof p !== 'object') fail();
    const pr = p as Record<string, unknown>;
    if (typeof pr['score'] !== 'number' || typeof pr['generatedAt'] !== 'string' || !ISO_STAMP.test(pr['generatedAt'])) fail();
  }
  if (row['delta'] !== null && (typeof row['delta'] !== 'number' || !Number.isFinite(row['delta']))) fail();
}

/** Parse an agent-readiness.v1 artifact; throws on any shape violation. */
export function parseAgentReadinessArtifact(text: string): AgentReadinessReport {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('Invalid agent-readiness artifact (JSON).');
  }
  assertReadiness(value, 'shape');
  return value;
}

/** Read an existing artifact for delta computation; null when absent. Throws on malformed content. */
export function readAgentReadinessArtifact(path: string): AgentReadinessReport | null {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`Cannot read existing agent-readiness artifact at ${path}.`);
  }
  return parseAgentReadinessArtifact(text);
}

export interface WriteAgentReadinessResult {
  path: string;
  report: AgentReadinessReport;
}

/**
 * Write one artifact per report into outDir, recomputing each report's
 * previous/delta against the artifact already stored at the destination. A
 * malformed existing artifact fails loudly rather than being silently
 * replaced. Writes go through a same-directory temp file plus rename so a
 * reader never observes a truncated artifact.
 */
export function writeAgentReadinessArtifacts(
  reports: AgentReadinessReport[],
  outDir: string,
): WriteAgentReadinessResult[] {
  mkdirSync(outDir, { recursive: true });
  return reports.map((report) => {
    const path = join(outDir, agentReadinessArtifactName(report));
    const existing = readAgentReadinessArtifact(path);
    const final: AgentReadinessReport = existing
      ? {
          ...report,
          previous: { score: existing.score, generatedAt: existing.generatedAt },
          delta: Math.round((report.score - existing.score) * 10) / 10,
        }
      : report;
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(final, null, 2)}\n`, 'utf8');
    try {
      renameSync(tmp, path);
    } catch (error) {
      try { unlinkSync(tmp); } catch { /* best effort */ }
      throw error;
    }
    return { path, report: final };
  });
}

/** Convenience: score a directory and optionally write its artifact. */
export function scoreAgentReadinessDir(options: {
  kind: AgentReadinessTargetKind;
  dir: string;
  label?: string;
  now?: string;
}): AgentReadinessReport {
  return scoreAgentReadinessTarget({
    kind: options.kind,
    source: createFsReadinessSource(options.dir),
    path: options.dir,
    ...(options.label ? { label: options.label } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
}
