#!/usr/bin/env node
/**
 * generate-site-llms.mjs - regenerate the agent-facing indexes the static
 * site serves at /llms.txt and /llms-full.txt.
 *
 * Both files are generated, never hand-edited:
 *   - llms.txt leads with the curated "Start here" task table from
 *     docs/README.md plus the site's machine-readable manifests.
 *   - llms-full.txt lists every README section anchor and every Markdown
 *     document under docs/, titled by each document's own first heading.
 *
 * Output is deterministic: no timestamps, alphabetical file order. Document
 * titles are copied verbatim except that em/en dashes are normalized to
 * hyphens (typographic punctuation survives poorly in plain-text contexts).
 *
 *   node scripts/generate-site-llms.mjs           # write both files
 *   node scripts/generate-site-llms.mjs --check   # fail when output drifted
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const GITHUB_BLOB = 'https://github.com/ashlrai/phantom/blob/master';
const SITE_ORIGIN = 'https://verse.ashlr.ai';

/** Directory names under docs/ that are working notes, not public canon. */
const EXCLUDED_DOC_DIRS = new Set(['internal']);

/** Section titles for docs/ subdirectories, keyed by directory name. */
const DOC_DIR_SECTIONS = {
  '': 'Guides',
  adr: 'Architecture decision records',
  architecture: 'Architecture',
  companions: 'Companions',
  contracts: 'Contracts',
};

const MAX_HEADING_SCAN_LINES = 200;
const MAX_DESCRIPTION = 160;

function normalizeText(text) {
  return text
    .replace(/[—–]/g, '-')
    .replace(/\[([^\]]+)\]\([^)\s]+\)/g, '$1')
    .replace(/!\[([^\]]*)\]\([^)\s]+\)/g, '$1')
    .replace(/[`*_]/g, '')
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/** First ATX `# ` heading in the document, or undefined. */
export function firstHeading(markdown) {
  const lines = markdown.split(/\r?\n/).slice(0, MAX_HEADING_SCAN_LINES);
  for (const line of lines) {
    const match = /^#\s+(.+?)\s*#*\s*$/.exec(line.trim());
    if (match) return normalizeText(match[1]);
  }
  return undefined;
}

/**
 * First plain-text paragraph following the first `# ` heading. Skips leading
 * HTML anchor tags; a document that opens with a list, table or code fence has
 * no lead paragraph and returns undefined.
 */
export function firstParagraph(markdown) {
  const lines = markdown.split(/\r?\n/);
  let seenHeading = false;
  const buf = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!seenHeading) {
      if (/^#\s/.test(line)) seenHeading = true;
      continue;
    }
    if (!line) {
      if (buf.length) break;
      continue;
    }
    if (line.startsWith('<')) continue;
    if (/^#{1,6}\s/.test(line) || /^(?:```|~~~|\||[-*+] |\d+\. |>)/.test(line)) break;
    buf.push(line);
  }
  const text = normalizeText(buf.join(' '));
  if (!text) return undefined;
  if (text.length <= MAX_DESCRIPTION) return text;
  const cut = text.slice(0, MAX_DESCRIPTION);
  return `${cut.slice(0, cut.lastIndexOf(' '))}...`;
}

/** GitHub-style heading anchor: lowercase, punctuation dropped, spaces to hyphens. */
export function githubAnchor(heading) {
  return heading
    .toLowerCase()
    .replace(/[^\w\s-]/gu, '')
    .trim()
    .replace(/\s+/g, '-');
}

/** Anchors for a heading list, deduplicating repeats the way GitHub does (-1, -2, ...). */
export function githubAnchors(headings) {
  const seen = new Map();
  return headings.map((heading) => {
    const base = githubAnchor(heading.text);
    const count = seen.get(base) ?? 0;
    seen.set(base, count + 1);
    return { text: heading.text, anchor: count === 0 ? base : `${base}-${count}` };
  });
}

/** All `#`-level headings of a markdown document, in order. */
export function markdownHeadings(markdown, levels = [2, 3]) {
  const out = [];
  let fence = false;
  for (const raw of markdown.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (/^(?:```|~~~)/.test(line.trim())) fence = !fence;
    if (fence) continue;
    const match = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line.trim());
    if (match && levels.includes(match[1].length)) {
      out.push({ level: match[1].length, text: normalizeText(match[2]) });
    }
  }
  return out;
}

function isTableDivider(line) {
  return /^\|[\s:|-]+\|\s*$/.test(line.trim());
}

/**
 * The "Start here" task table in docs/README.md: one row per link, carrying
 * the task text as the link's description.
 */
export function docsIndexLinks(markdown) {
  const lines = markdown.split(/\r?\n/);
  const start = lines.findIndex((line) => /^##\s+Start here/i.test(line.trim()));
  if (start < 0) return [];
  const rows = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (/^##\s/.test(line.trim())) break;
    if (!line.trim().startsWith('|') || isTableDivider(line) || /your task/i.test(line)) continue;
    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 2) continue;
    const task = normalizeText(cells[0]);
    for (const match of cells.slice(1).join(' ').matchAll(/\[([^\]]+)\]\(([^)\s]+)\)/g)) {
      rows.push({ task, label: normalizeText(match[1]), href: match[2] });
    }
  }
  return rows;
}

function resolveDocHref(href) {
  if (/^[a-z][a-z\d+.-]*:/i.test(href) || href.startsWith('#')) return href;
  const clean = href.replace(/^\.\//, '');
  return `${GITHUB_BLOB}/docs/${clean}`;
}

function walkDocs(dir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!EXCLUDED_DOC_DIRS.has(entry.name)) out.push(...walkDocs(join(dir, entry.name), rel));
    } else if (entry.isFile() && /\.md$/i.test(entry.name)) {
      out.push(rel);
    }
  }
  return out.sort();
}

function collectDocs(root) {
  const docsDir = join(root, 'docs');
  return walkDocs(docsDir).map((rel) => {
    const markdown = readFileSync(join(docsDir, rel), 'utf8');
    const fileTitle = rel
      .replace(/\.md$/i, '')
      .split('/')
      .pop()
      .replace(/[-_]+/g, ' ');
    return {
      rel: `docs/${rel}`,
      dir: dirname(rel).replace(/^\.$/, ''),
      title: firstHeading(markdown) ?? fileTitle,
      description: firstParagraph(markdown),
    };
  });
}

function siteSection() {
  return [
    '## Site',
    '',
    `- [Phantom](${SITE_ORIGIN}/): the engineering agent workbench`,
    `- [Install](${SITE_ORIGIN}/install): install the CLI and open the console`,
    `- [Ecosystem](${SITE_ORIGIN}/ecosystem): the Ashlr tool family and its GitHub history`,
    `- [capabilities.json](${SITE_ORIGIN}/capabilities.json): machine-readable capability manifest`,
    `- [MCP server manifest](${SITE_ORIGIN}/.well-known/mcp/server.json): MCP registry metadata`,
    `- [llms-full.txt](${SITE_ORIGIN}/llms-full.txt): the complete documentation index`,
  ];
}

function repositorySection() {
  return [
    '## Repository',
    '',
    `- [README](${GITHUB_BLOB}/README.md): install, feature tour and quickstart`,
    `- [Documentation index](${GITHUB_BLOB}/docs/README.md): one canonical guide per task`,
    `- [AGENTS.md](${GITHUB_BLOB}/AGENTS.md): agent constitution, layout and verification`,
    `- [Contributing](${GITHUB_BLOB}/CONTRIBUTING.md): conventions, tests and contracts`,
    `- [Changelog](${GITHUB_BLOB}/CHANGELOG.md): milestone release history`,
    `- [License](${GITHUB_BLOB}/LICENSE): MIT`,
  ];
}

function header(pkg) {
  return [
    '# Phantom',
    '',
    `> ${pkg.description}`,
    '',
    `MIT-licensed open source. Install the CLI with \`npm i -g @ashlr/phantom\`,`,
    `then open the console with \`phm verse\`. Requires Node.js 22.15+ and Git.`,
    '',
  ];
}

/**
 * Build both llms files for a repository root. Returns
 * { llmsTxt, llmsFullTxt } as trailing-newline strings.
 */
export function buildSiteLlmsFiles(root) {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const readme = readFileSync(join(root, 'README.md'), 'utf8');
  const docsIndex = readFileSync(join(root, 'docs/README.md'), 'utf8');

  const taskLinks = docsIndexLinks(docsIndex).map(
    ({ task, label, href }) => `- [${label}](${resolveDocHref(href)}): ${task}`,
  );

  const llms = [
    ...header(pkg),
    ...siteSection(),
    '',
    '## Guides by task',
    '',
    ...taskLinks,
    '',
    ...repositorySection(),
    '',
  ].join('\n');

  const docs = collectDocs(root);
  const grouped = new Map();
  for (const doc of docs) {
    if (!grouped.has(doc.dir)) grouped.set(doc.dir, []);
    grouped.get(doc.dir).push(doc);
  }

  const readmeAnchors = githubAnchors(markdownHeadings(readme)).map(
    ({ text, anchor }) => `- [${text}](${GITHUB_BLOB}/README.md#${anchor})`,
  );

  const sections = [...grouped.keys()].sort(
    (a, b) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)),
  );
  const full = [
    ...header(pkg),
    `This is the complete index: every README section and every Markdown guide`,
    `in the repository (docs/internal working notes excepted), titled by its`,
    `own heading. The short index is ${SITE_ORIGIN}/llms.txt.`,
    '',
    ...siteSection(),
    '',
    '## README sections',
    '',
    ...readmeAnchors,
    '',
  ];
  for (const dir of sections) {
    const title = DOC_DIR_SECTIONS[dir] ?? dir;
    full.push(`## ${title}`, '');
    for (const doc of grouped.get(dir)) {
      const url = `${GITHUB_BLOB}/${doc.rel}`;
      const suffix = doc.description ? `: ${doc.description}` : '';
      full.push(`- [${doc.title}](${url})${suffix}`);
    }
    full.push('');
  }
  full.push(...repositorySection(), '');

  return { llmsTxt: llms, llmsFullTxt: full.join('\n') };
}

export const LLMS_OUTPUTS = [
  ['site/llms.txt', 'llmsTxt'],
  ['site/llms-full.txt', 'llmsFullTxt'],
];

function main(args) {
  const check = args.includes('--check');
  if (args.length !== (check ? 1 : 0)) {
    throw new Error('usage: generate-site-llms.mjs [--check]');
  }
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const built = buildSiteLlmsFiles(root);
  let drift = false;
  for (const [path, key] of LLMS_OUTPUTS) {
    const target = join(root, path);
    let current;
    try {
      current = readFileSync(target, 'utf8');
    } catch {
      current = null;
    }
    if (check) {
      if (current !== built[key]) {
        drift = true;
        console.error(`${path}: ${current === null ? 'missing' : 'out of date'}; run node scripts/generate-site-llms.mjs`);
      } else {
        console.log(`${path}: up to date`);
      }
    } else {
      if (current !== built[key]) {
        writeFileSync(target, built[key], 'utf8');
        console.log(`wrote ${path} (${built[key].length} bytes)`);
      } else {
        console.log(`${path}: already current`);
      }
    }
  }
  if (drift) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(`generate-site-llms: ${error.message}`);
    process.exitCode = 1;
  }
}
