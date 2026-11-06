#!/usr/bin/env node
/**
 * scripts/site-freshness.mjs - generate the facts site/ pages show.
 *
 * The static site (verse.ashlr.ai) used to hand-maintain version strings,
 * install commands, provider model lists and its declared companion MCP
 * server list. Each of those now lives in a managed block between
 * `<!-- fresh:begin NAME -->` and `<!-- fresh:end -->` markers in the HTML,
 * regenerated here from the repository source of truth:
 *
 *   version + release date   package.json candidate is NOT published metadata;
 *                            the first dated CHANGELOG.md release is
 *   install command          package.json name + bin names
 *   Node.js floor            package.json engines.node
 *   ashlr/phm commands       src/cli/index.ts dispatch switch plus the verb
 *                            tables in src/cli/completions.ts
 *   provider model lists     documented model tables in
 *                            src/core/verse/model-windows.ts
 *   companion MCP servers    .mcp.json mcpServers keys
 *
 * `node scripts/site-freshness.mjs` rewrites managed blocks in place.
 * `node scripts/site-freshness.mjs --check` is read-only and exits 1 on
 * drift. Both modes also validate every `ashlr`/`phm` command line in
 * <pre>/<code> elements against the real CLI, so a renamed command or flag
 * fails loudly instead of going stale on the public page.
 *
 * Mirrors the scripts/freshness/ marker convention from RQ-FRESH-GEN-PH so
 * the two can converge once that lands. No network, credentials or deps.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = fileURLToPath(new URL('../', import.meta.url));
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const SITE_FILES = ['index.html', 'ecosystem.html'];
const BIN_NAME = /^(?:ashlr|phm)$/;

/**
 * Commands dispatched one level below a top-level command that has no
 * SUBCOMMANDS completion entry. Maps the literal token prefix to the module
 * that must contain the next literal token, so a renamed verb fails closed.
 */
const DEEP_DISPATCH = new Map([
  ['resources', 'src/cli/resources.ts'],
  ['resources profile', 'src/cli/resource-profile.ts'],
]);

// ---------------------------------------------------------------------------
// Facts
// ---------------------------------------------------------------------------

/** Top-level commands in the real `switch (cmd)` dispatch (drift-test source). */
function dispatchedCommands(src) {
  const start = src.indexOf('switch (cmd) {');
  if (start === -1) throw new Error('src/cli/index.ts: dispatch switch not found');
  const end = src.indexOf('\n  } catch (err) {', start);
  if (end === -1) throw new Error('src/cli/index.ts: dispatch switch end not found');
  const found = new Set();
  for (const m of src.slice(start, end).matchAll(/case '([a-zA-Z][a-zA-Z0-9-]*)':/g)) found.add(m[1]);
  if (found.size < 50) throw new Error('src/cli/index.ts: implausibly few dispatched commands');
  return found;
}

/** `const SUBCOMMANDS: Record<string, string[]> = { ... }` verb tables. */
function completionVerbs(src) {
  const start = src.indexOf('const SUBCOMMANDS');
  if (start === -1) throw new Error('src/cli/completions.ts: SUBCOMMANDS not found');
  const end = src.indexOf('};', start);
  if (end === -1) throw new Error('src/cli/completions.ts: SUBCOMMANDS end not found');
  const verbs = new Map();
  const entry = /(?:^|\n)\s*'?([a-zA-Z][a-zA-Z0-9-]*)'?\s*:\s*\[([^\]]*)\]/g;
  for (const m of src.slice(start, end).matchAll(entry)) {
    verbs.set(m[1], new Set([...m[2].matchAll(/'([^']+)'/g)].map((v) => v[1])));
  }
  if (verbs.size < 20) throw new Error('src/cli/completions.ts: implausibly few verb tables');
  return verbs;
}

/** Every `--flag` spelled anywhere under src/, matching test/doc-facts.test.ts. */
function sourceFlags(root) {
  const flags = new Set();
  const walk = (dir) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) walk(path);
      else if (/\.(ts|tsx|mjs|js)$/.test(name)) {
        for (const m of readFileSync(path, 'utf8').matchAll(/--[a-z][a-z0-9-]*/g)) flags.add(m[0]);
      }
    }
  };
  walk(join(root, 'src'));
  return flags;
}

/** Display names from one documented-model table in model-windows.ts. */
function documentedModels(src, table) {
  const start = src.indexOf(`const ${table}`);
  if (start === -1) throw new Error(`model-windows.ts: ${table} not found`);
  const end = src.indexOf('].map(', start);
  if (end === -1) throw new Error(`model-windows.ts: ${table} end not found`);
  const rows = [...src.slice(start, end).matchAll(/'[^']+'\s*,\s*'([^']+)'/g)].map((m) => m[1]);
  if (rows.length === 0) throw new Error(`model-windows.ts: ${table} has no rows`);
  return rows;
}

function claudeModels(src) {
  const start = src.indexOf('export const VERSE_CLAUDE_MODEL_SPECS');
  if (start === -1) throw new Error('model-windows.ts: VERSE_CLAUDE_MODEL_SPECS not found');
  const end = src.indexOf('];', start);
  if (end === -1) throw new Error('model-windows.ts: VERSE_CLAUDE_MODEL_SPECS end not found');
  const rows = [...src.slice(start, end).matchAll(/label: '([^']+)'/g)].map((m) => m[1]);
  if (rows.length === 0) throw new Error('model-windows.ts: no claude model labels');
  return rows.map((label) => {
    if (!label.startsWith('Claude ')) throw new Error(`unexpected claude label: ${label}`);
    return label.slice('Claude '.length);
  });
}

export function readFacts(root) {
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  if (pkg.name !== '@ashlr/phantom' || !SEMVER.test(pkg.version)) {
    throw new Error('Invalid Phantom package identity or version');
  }
  const bin = Object.keys(pkg.bin ?? {});
  if (!bin.includes('phm')) throw new Error('package.json bin is missing phm');
  const engine = /(\d+\.\d+\.\d+)/.exec(pkg.engines?.node ?? '');
  if (!engine) throw new Error('package.json engines.node has no concrete version');
  const nodeFloor = engine[1].endsWith('.0') ? engine[1].slice(0, -2) : engine[1];

  const changelog = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8');
  const release = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\][^\n]*?\b(\d{4}-\d{2}-\d{2})\s*$/gm)][0];
  if (!release) throw new Error('CHANGELOG.md has no dated released section');

  const mcp = JSON.parse(readFileSync(resolve(root, '.mcp.json'), 'utf8'));
  const mcpServers = Object.keys(mcp.mcpServers ?? {}).sort();
  if (mcpServers.length === 0) throw new Error('.mcp.json declares no mcpServers');

  const cliTop = dispatchedCommands(readFileSync(resolve(root, 'src/cli/index.ts'), 'utf8'));
  const verbs = completionVerbs(readFileSync(resolve(root, 'src/cli/completions.ts'), 'utf8'));
  const deep = new Map([...DEEP_DISPATCH].map(([prefix, file]) => [
    prefix, readFileSync(resolve(root, file), 'utf8'),
  ]));

  const windows = readFileSync(resolve(root, 'src/core/verse/model-windows.ts'), 'utf8');
  return {
    pkgName: pkg.name,
    version: pkg.version,
    bin,
    nodeFloor,
    released: release[1],
    releaseDate: release[2],
    mcpServers,
    cliTop,
    verbs,
    deep,
    srcFlags: sourceFlags(root),
    models: {
      claude: claudeModels(windows),
      codex: documentedModels(windows, 'CODEX_DOCUMENTED_MODELS'),
      grok: documentedModels(windows, 'GROK_DOCUMENTED_MODELS'),
    },
  };
}

// ---------------------------------------------------------------------------
// Command validation: every ashlr/phm line on a page must be a real invocation
// ---------------------------------------------------------------------------

const ENTITIES = {
  '&amp;': '&', '&quot;': '"', '&#39;': "'", '&hellip;': '…',
  '&middot;': '·', '&lt;': '<', '&gt;': '>', '&#8984;': '⌘',
};

function decodeEntities(text) {
  return text.replace(/&(?:amp|quot|#39|hellip|middot|lt|gt|#8984);/g, (e) => ENTITIES[e]);
}

/** Lines of <pre>/<code> text starting with the CLI, continuations joined. */
function* commandLines(text) {
  let pending = '';
  for (const raw of text.split('\n')) {
    const trimmed = raw.trim();
    const line = pending + trimmed;
    if (trimmed.endsWith('\\')) { pending = `${line.slice(0, -1)} `; continue; }
    pending = '';
    if (BIN_NAME.test(line.split(/\s/, 1)[0])) yield line;
  }
}

/** <pre>/<code> element bodies on a page, as rendered (tags stripped). */
function* commandBlocks(html) {
  for (const m of html.matchAll(/<(?:pre|code)\b[^>]*>([\s\S]*?)<\/(?:pre|code)>/g)) {
    yield decodeEntities(m[1].replace(/<[^>]+>/g, ''));
  }
}

function validateInvocation(line, facts, where) {
  const tokens = line.split(/\s+/);
  const cmd = tokens[1];
  if (!cmd) throw new Error(`${where}: bare '${tokens[0]}' invocation`);
  if (cmd.startsWith('--')) {
    if (!facts.srcFlags.has(cmd)) throw new Error(`${where}: '${cmd}' is not a CLI flag found in src/`);
    return;
  }
  if (!facts.cliTop.has(cmd)) {
    throw new Error(`${where}: '${cmd}' is not a dispatched command in src/cli/index.ts`);
  }
  const rest = tokens.slice(2);
  const verbs = facts.verbs.get(cmd);
  const first = rest[0];
  if (verbs && first && /^[a-z][a-z0-9-]*$/.test(first) && !verbs.has(first)) {
    throw new Error(`${where}: '${cmd} ${first}' is not a verb of '${cmd}'`);
  }
  let prefix = cmd;
  for (const tok of rest) {
    const body = facts.deep.get(prefix);
    if (body === undefined || !/^[a-z][a-z0-9-]*$/.test(tok)) break;
    if (!new RegExp(`\\b${tok}\\b`).test(body)) {
      throw new Error(`${where}: '${prefix} ${tok}' is not dispatched by ${DEEP_DISPATCH.get(prefix)}`);
    }
    prefix += ` ${tok}`;
  }
  for (const tok of rest) {
    const flag = tok.split('=', 1)[0];
    if (flag.startsWith('--') && !facts.srcFlags.has(flag)) {
      throw new Error(`${where}: flag '${flag}' is not spelled anywhere in src/`);
    }
  }
}

/** Throws on the first invalid ashlr/phm command line found in page HTML. */
export function validatePageCommands(html, facts, where = 'page') {
  for (const block of commandBlocks(html)) {
    for (const line of commandLines(block)) validateInvocation(line, facts, where);
  }
}

// ---------------------------------------------------------------------------
// Managed blocks
// ---------------------------------------------------------------------------

function renderCommandBlock(innerHtml, facts, name) {
  const text = decodeEntities(innerHtml.replace(/<[^>]+>/g, ''));
  for (const line of commandLines(text)) validateInvocation(line, facts, name);
  return innerHtml;
}

/** "GPT-6 Astra, Sol, Luna": group display names by their version prefix. */
function codexModelLine(names) {
  const groups = new Map();
  for (const name of names) {
    const m = /^(GPT-[\d.]+)\s+(.+)$/.exec(name);
    if (!m) throw new Error(`codex model name does not match the GPT pattern: ${name}`);
    if (!groups.has(m[1])) groups.set(m[1], []);
    groups.get(m[1]).push(m[2]);
  }
  return [...groups.entries()].map(([v, rest]) => `${v} ${rest.join(', ')}`).join(' &middot; ');
}

/** "Grok 4.7, 4.7 Fast, 4.6, 4.5": first name whole, later names elide "Grok ". */
function grokModelLine(names) {
  const family = names[0].split(' ', 1)[0];
  return names.map((name, i) => {
    if (i === 0) return name;
    if (!name.startsWith(`${family} `)) {
      throw new Error(`grok model name does not share the ${family} prefix: ${name}`);
    }
    return name.slice(family.length + 1);
  }).join(', ');
}

function jsonLd(facts) {
  return `<script type="application/ld+json">
{
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "WebSite",
      "@id": "https://verse.ashlr.ai/#website",
      "name": "Phantom",
      "url": "https://verse.ashlr.ai/"
    },
    {
      "@type": "SoftwareApplication",
      "@id": "https://verse.ashlr.ai/#application",
      "name": "Phantom",
      "url": "https://verse.ashlr.ai/",
      "description": "One coding-agent workbench for individual engineers and engineering teams. Use your accounts and local models, review changes, and add signed fleet work when ready.",
      "applicationCategory": "DeveloperApplication",
      "operatingSystem": "macOS, Linux, Windows",
      "softwareVersion": "${facts.released}",
      "dateModified": "${facts.releaseDate}",
      "license": "https://github.com/ashlrai/phantom/blob/master/LICENSE",
      "isAccessibleForFree": true,
      "sameAs": "https://github.com/ashlrai/phantom",
      "featureList": [
        "Coding-agent chats and workspaces",
        "Signed resident autonomy on macOS",
        "Local model discovery",
        "Offline benchmark receipt comparison",
        "Reset-aware eligible task and account choices"
      ]
    }
  ]
}
</script>`;
}

export function renderBlock(name, facts) {
  switch (name) {
    case 'jsonld': return jsonLd(facts);
    case 'node-floor': return facts.nodeFloor;
    case 'mcp-servers': return facts.mcpServers.join(', ');
    case 'models-claude': return facts.models.claude.join(', ');
    case 'models-codex': return codexModelLine(facts.models.codex);
    case 'models-grok': return grokModelLine(facts.models.grok);
    case 'release-line':
      return `<p>Latest dated changelog release: <a href="https://github.com/ashlrai/phantom/blob/master/CHANGELOG.md">${facts.released}</a> (${facts.releaseDate}).</p>`;
    case 'install-commands':
      if (!facts.cliTop.has('verse')) throw new Error("'verse' is no longer a dispatched command");
      return `<pre id="install-command">npm i -g ${facts.pkgName}\nphm verse</pre>`;
    case 'cmd-wiki': return renderCommandBlock(
      '<pre style="margin-top:30px"><span class="c"># the same wiki from the terminal</span>\n' +
      'ashlr wiki build ashlr-hub\nashlr wiki ask "where are standing grants verified?"</pre>', facts, name);
    case 'cmd-profile': return renderCommandBlock(
      '<pre>ashlr resources profile prepare --provider claude \\\n' +
      '  --directory ~/.ashlr/native-profiles/claude-a \\\n  --executable /path/to/claude</pre>', facts, name);
    case 'cmd-leader': return renderCommandBlock(
      '<pre>ashlr leader say "focus: the flaky retry test"\nashlr comms setup-telegram</pre>', facts, name);
    case 'cmd-authority': return renderCommandBlock(
      '<pre>ashlr authority setup --dry-run\nashlr authority setup\nashlr authority resident start</pre>', facts, name);
    case 'cmd-devin': return renderCommandBlock(
      '<pre>ashlr devin connect\nashlr devin budget --acu 50</pre>', facts, name);
    default: throw new Error(`Unknown freshness block: ${name}`);
  }
}

// ---------------------------------------------------------------------------
// Marker engine (same convention as scripts/freshness/ from RQ-FRESH-GEN-PH)
// ---------------------------------------------------------------------------

export function regenerate(text, facts) {
  const marker = /<!-- fresh:(begin [a-z][a-z0-9-]*|end) -->/g;
  let output = '';
  let cursor = 0;
  let open;
  for (const match of text.matchAll(marker)) {
    if (match[1].startsWith('begin ')) {
      if (open) throw new Error('Nested freshness block');
      open = { name: match[1].slice(6), end: match.index + match[0].length };
    } else {
      if (!open) throw new Error('Unmatched freshness end');
      const newline = text.includes('\r\n') ? '\r\n' : '\n';
      const block = renderBlock(open.name, facts);
      const inner = text.slice(open.end, match.index);
      const inline = !inner.includes('\n') && !block.includes('\n');
      // Multi-line blocks keep the end marker's own leading indentation.
      const endIndent = (/\n([ \t]*)$/.exec(inner) ?? [null, ''])[1];
      output += inline
        ? text.slice(cursor, open.end) + block + match[0]
        : text.slice(cursor, open.end) + newline + block.replaceAll('\n', newline) + newline + endIndent + match[0];
      cursor = match.index + match[0].length;
      open = undefined;
    }
  }
  if (open) throw new Error('Unclosed freshness block');
  output += text.slice(cursor);
  // Reject malformed markers rather than silently passing a mistyped block.
  if (/<!--[^>]*?fresh\s*:/.test(text.replace(marker, ''))) throw new Error('Malformed freshness marker');
  return output;
}

export function synchronize(root = defaultRoot, { check = false } = {}) {
  const facts = readFacts(root);
  const changes = [];
  for (const file of SITE_FILES) {
    const path = resolve(root, 'site', file);
    const text = readFileSync(path, 'utf8');
    let generated;
    try {
      generated = regenerate(text, facts);
      validatePageCommands(generated, facts, `site/${file}`);
    } catch (error) { throw new Error(`site/${file}: ${error.message}`); }
    if (text !== generated) changes.push({ file, generated });
  }
  // Validate every page before writing any changes.
  if (!check) for (const { file, generated } of changes) writeFileSync(resolve(root, 'site', file), generated);
  return changes.map(({ file }) => `site/${file}`);
}

export function main(args = process.argv.slice(2)) {
  let check = false;
  let root = defaultRoot;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--check') check = true;
    else if (args[i] === '--root' && args[i + 1]) root = resolve(args[++i]);
    else throw new Error('Usage: node scripts/site-freshness.mjs [--check] [--root directory]');
  }
  const changed = synchronize(root, { check });
  for (const file of changed) console.log(`${check ? 'drift' : 'updated'}: ${file}`);
  if (check && changed.length) process.exitCode = 1;
  else console.log(`site freshness: ${check ? 'in sync' : 'synchronized'}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error(`site freshness: ${error.message}`); process.exitCode = 1; }
}
