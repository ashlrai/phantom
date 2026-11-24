#!/usr/bin/env node

/**
 * scripts/generate-site-llms.mjs — generate llms.txt and llms-full.txt for the public site.
 *
 * Reads the site/ directory (HTML pages) and the repo root (package.json) to
 * produce two plain-text guides for AI agents:
 *
 *   - llms.txt       concise index for an agent's first encounter
 *   - llms-full.txt  detailed guide with install steps, commands, and all page links
 *
 * Both files are written into site/ so they serve at verse.ashlr.ai/llms.txt.
 *
 * Usage:
 *   node scripts/generate-site-llms.mjs           # rewrite both files
 *   node scripts/generate-site-llms.mjs --check   # exit 1 if they would change
 *
 * Deterministic: same site tree and package.json produce the same output bytes.
 * No network, credentials, or model calls. Mirrors the conventions from
 * build-site-sitemap.mjs and site-freshness.mjs.
 */
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

// ---------------------------------------------------------------------------
// Read helpers
// ---------------------------------------------------------------------------

function read(root, name) {
  return readFileSync(resolve(root, name), 'utf8');
}

function* htmlFiles(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) yield* htmlFiles(path);
    else if (entry.isFile() && entry.name.endsWith('.html')) yield path;
  }
}

function extractMeta(html) {
  const canonical = html.match(/<link\s+[^>]*rel="canonical"\s+href="([^"]+)"[^>]*\/?>/i)
    ?? html.match(/<link\s+[^>]*href="([^"]+)"\s+rel="canonical"[^>]*\/?>/i);
  const title = html.match(/<title[^>]*>([^<]+)<\/title>/i);
  const desc = html.match(/<meta\s+[^>]*name="description"\s+content="([^"]*)"[^>]*\/?>/i)
    ?? html.match(/<meta\s+[^>]*content="([^"]*)"\s+name="description"[^>]*\/?>/i);
  const og = html.match(/<meta\s+[^>]*property="og:url"\s+content="([^"]*)"[^>]*\/?>/i)
    ?? html.match(/<meta\s+[^>]*content="([^"]*)"\s+property="og:url"[^>]*\/?>/i);
  return {
    canonical: canonical ? canonical[1] : null,
    og: og ? og[1] : null,
    url: canonical ? canonical[1] : og ? og[1] : null,
    title: title ? title[1] : null,
    description: desc ? desc[1] : null,
  };
}

// ---------------------------------------------------------------------------
// Data gathering
// ---------------------------------------------------------------------------

function gather(root) {
  const pkg = JSON.parse(read(root, 'package.json'));
  const pages = [...htmlFiles(resolve(root, 'site'))].map((path) => ({
    path,
    ...extractMeta(readFileSync(path, 'utf8')),
  })).filter((p) => p.url);

  // Classify pages by URL pattern
  const landing = pages.find((p) => p.url.endsWith('/'));
  const useCases = pages.filter((p) => /^https:\/\/verse\.ashlr\.ai\/use-cases\//.test(p.url));
  const compare = pages.filter((p) => /^https:\/\/verse\.ashlr\.ai\/compare\//.test(p.url));
  const other = pages.filter((p) => !landing && !useCases.includes(p) && !compare.includes(p));

  return {
    pkg: {
      name: pkg.name,
      version: pkg.version,
      description: pkg.description ?? '',
      bin: pkg.bin ?? {},
      engines: pkg.engines ?? {},
    },
    landing,
    useCases,
    compare,
    other,
  };
}

// ---------------------------------------------------------------------------
// Shared sections: mission, ecosystem and how agents work. The wording mirrors
// README.md ("Chasing open-source RSI", "The Phantom ecosystem" and "How agents
// work on Phantom"); keep the two in step when either changes.
// ---------------------------------------------------------------------------

const REPO = 'https://github.com/ashlrai/phantom/blob/master';

const ECOSYSTEM = [
  ['Phantom', 'https://github.com/ashlrai/phantom', 'the factory floor: console, CLI, MCP gateway, agent bus and fleet that run and record agent work (this package)'],
  ['Phantom Secrets', 'https://github.com/ashlrai/phantom-secrets', 'local vault, placeholders and a proxy for supported API credential use'],
  ['Locus', 'https://github.com/ashlrai/locus', 'account and tenant bindings for agent tools'],
  ['Ashlr Plugin', 'https://github.com/ashlrai/ashlr-plugin', 'compact tool results and a local usage ledger'],
  ['Lexicon', 'https://github.com/ashlrai/lexicon', 'correct recurring speech-to-text errors before agents read them'],
  ['Ashlr MD', 'https://github.com/ashlrai/ashlr-md', 'Markdown editing with CLI and MCP interfaces'],
  ['Ashlr Stack', 'https://github.com/ashlrai/ashlr-stack', 'configure supported development services through CLI and MCP'],
];

function missionLines() {
  return [
    '## Mission',
    '',
    'Phantom is chasing open-source RSI (recursive self-improvement): an open-source, recursively self-improving, fully autonomous software factory that anyone can join with their own agents and compute.',
    'Agents run the factory and the human owner acts as a passive board member. Agents pick work, open pull requests, merge them and ship releases through the sanctioned workflow; the owner sets direction and is needed only for passwords, 2FA, device approvals and payments.',
    '',
    `- [Strategy for recursive self-improvement and an open fleet](${REPO}/docs/strategy/RECURSIVE-SELF-IMPROVEMENT-AND-OPEN-FLEET-2026-11.md): how improvements are tested and the fleet opens without sharing credentials`,
    `- [How agents work on Phantom](${REPO}/README.md#how-agents-work-on-phantom): what agents may do, the limits kept for the owner, evidence over claims`,
    `- [AGENTS.md](${REPO}/AGENTS.md): the agent constitution`,
    '',
  ];
}

function ecosystemLines() {
  return [
    '## Ecosystem',
    '',
    'Companions install separately; each has its own capabilities and authorization boundaries.',
    '',
    ...ECOSYSTEM.map(([name, url, purpose]) => `- [${name}](${url}): ${purpose}`),
    '',
  ];
}

/** The CLI ships as `phm`; `ashlr` is the compatible alias. */
function primaryBin(bin) {
  if (bin.phm) return 'phm';
  return Object.keys(bin).sort()[0] ?? 'ashlr';
}

/** `>=22.15.0` reads as "22.15.0 or newer" in prose. */
function nodeFloor(range) {
  return String(range).replace(/^>=\s*/, '');
}

// ---------------------------------------------------------------------------
// llms.txt — concise agent guide
// ---------------------------------------------------------------------------

function renderLlmsTxt(data) {
  const { pkg, landing, useCases, compare, other } = data;
  const installBin = primaryBin(pkg.bin);

  // Strip trailing punctuation from the package description to avoid
  // a double-dot when concatenating the tagline suffix.
  const desc = (pkg.description ?? '').replace(/\.{1,3}$/, '');

  const lines = [
    `# ${landing?.title ?? 'Phantom — the engineering agent workbench'}`,
    '',
    `> ${desc}${desc.endsWith('.') ? '' : '.'} Open-source, local-first. Documentation index for autonomous agents — not an execution API or authorization.`,
    '',
    ...missionLines(),
    '## Start here',
    '',
  ];

  // Landing and key documentation links (3+ links required for full scoring)
  if (landing) {
    lines.push(`- [${landing.title}](https://verse.ashlr.ai/): landing page`);
  }
  lines.push(`- [Repository README](https://github.com/ashlrai/phantom/blob/master/README.md): quickstart and overview`);
  lines.push(`- [Documentation index](https://github.com/ashlrai/phantom/blob/master/docs/README.md): canonical guides by task`);
  lines.push(`- [All docs as Markdown](https://verse.ashlr.ai/docs/llms-full.txt): every docs page in one file; each page is also at https://verse.ashlr.ai/docs/<page>.md`);
  lines.push(`- [Contributing](https://github.com/ashlrai/phantom/blob/master/CONTRIBUTING.md): source development guide`);
  lines.push(`- [Contribute with an agent](${REPO}/docs/CONTRIBUTE-WITH-AN-AGENT.md): first pull request from a fork, the checks to run once, Merge Gate and auto-merge`);

  lines.push('');
  lines.push('## Install');
  lines.push('');
  lines.push('```sh');
  lines.push(`npm install -g ${pkg.name}`);
  lines.push(`${installBin} --version`);
  lines.push(`${installBin} verse`);
  lines.push('```');
  lines.push('');

  if (pkg.engines?.node) {
    lines.push(`Node.js ${nodeFloor(pkg.engines.node)} or newer is required.`);
    lines.push('');
  }

  lines.push(...ecosystemLines());

  lines.push('## Use-case guides');
  lines.push('');
  for (const uc of useCases) {
    lines.push(`- [${uc.title}](https://verse.ashlr.ai/use-cases/${uc.url.split('/').pop()}): ${uc.description}`);
  }

  lines.push('');
  lines.push('## Compare');
  lines.push('');
  for (const cmp of compare) {
    lines.push(`- [${cmp.title}](https://verse.ashlr.ai/compare/${cmp.url.split('/').pop()}): ${cmp.description}`);
  }

  if (other.length) {
    lines.push('');
    lines.push('## More');
    lines.push('');
    for (const p of other) {
      const slug = p.url.replace('https://verse.ashlr.ai/', '');
      lines.push(`- [${p.title}](https://verse.ashlr.ai/${slug}): ${p.description}`);
    }
  }

  lines.push('');
  lines.push('## Agent-facing resources');
  lines.push('');
  lines.push('- [AGENTS.md](https://github.com/ashlrai/phantom/blob/master/AGENTS.md): agent operations guide');
  lines.push(`- [CLI agent docs](https://github.com/ashlrai/phantom/blob/master/docs/AGENT-READINESS.md): command registry via \`${installBin} docs --agent\``);
  lines.push('- [llms-full.txt](https://verse.ashlr.ai/llms-full.txt): detailed agent guide');
  lines.push('- [Sitemap](https://verse.ashlr.ai/sitemap.xml): complete page index');
  lines.push('- [Capabilities](https://github.com/ashlrai/phantom/blob/master/server.json): machine-readable server config');
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// llms-full.txt — detailed agent guide
// ---------------------------------------------------------------------------

function renderLlmsFull(data) {
  const { pkg, landing, useCases, compare, other } = data;
  const installBin = primaryBin(pkg.bin);

  const lines = [
    `# ${landing?.title ?? 'Phantom — the engineering agent workbench'}`,
    '',
    `> Full documentation bundle for agents. Everything below is plain Markdown.`,
    '',
    '## Overview',
    '',
    `${pkg.description}`,
    '',
    ...missionLines(),
    ...ecosystemLines(),
    `Package: \`${pkg.name}\` v${pkg.version}.`,
    pkg.engines?.node ? `Node.js floor: ${nodeFloor(pkg.engines.node)} or newer.` : '',
    '',
    '## Install',
    '',
    '```sh',
    `npm install -g ${pkg.name}`,
    `${installBin} --version`,
    `${installBin} verse`,
    '```',
    '',
    `${installBin} verse prints a read token and a mutation token; the server listens on`,
    '`127.0.0.1` only. Neither token is written to disk.',
    '',
  ];

  // CLI commands section
  lines.push('## Commands');
  lines.push('');
  lines.push(`- \`${installBin} --help\`: top-level command list`);
  lines.push(`- \`${installBin} verse\`: serve the console`);
  lines.push(`- \`${installBin} docs --agent\`: agent cheat sheet (plain text)`);
  lines.push(`- \`${installBin} docs --agent --json\`: command registry as JSON`);
  lines.push('');

  // Use-case guides with full descriptions
  if (useCases.length) {
    lines.push('## Use-case guides');
    lines.push('');
    for (const uc of useCases) {
      const slug = uc.url.split('/').pop();
      lines.push(`### [${uc.title}](https://verse.ashlr.ai/use-cases/${slug})`);
      lines.push('');
      lines.push(uc.description);
      lines.push('');
    }
  }

  // Comparison page
  if (compare.length) {
    lines.push('## Comparison');
    lines.push('');
    for (const cmp of compare) {
      const slug = cmp.url.split('/').pop();
      lines.push(`- [${cmp.title}](https://verse.ashlr.ai/compare/${slug}): ${cmp.description}`);
    }
    lines.push('');
  }

  // Other pages
  if (other.length) {
    lines.push('## Additional pages');
    lines.push('');
    for (const p of other) {
      const slug = p.url.replace('https://verse.ashlr.ai/', '');
      lines.push(`- [${p.title}](https://verse.ashlr.ai/${slug}): ${p.description}`);
    }
    lines.push('');
  }

  // Repository documentation links
  lines.push('## Repository documentation');
  lines.push('');
  lines.push('- [README](https://github.com/ashlrai/phantom/blob/master/README.md): quickstart and overview');
  lines.push('- [docs/README.md](https://github.com/ashlrai/phantom/blob/master/docs/README.md): task-indexed guide map');
  lines.push('- [CONTRIBUTING.md](https://github.com/ashlrai/phantom/blob/master/CONTRIBUTING.md): source development guide');
  lines.push(`- [Contribute with an agent](${REPO}/docs/CONTRIBUTE-WITH-AN-AGENT.md): first pull request from a fork, the checks to run once, Merge Gate and auto-merge`);
  lines.push('- [AGENTS.md](https://github.com/ashlrai/phantom/blob/master/AGENTS.md): agent operations');
  lines.push('- [Architecture](https://github.com/ashlrai/phantom/blob/master/docs/ARCHITECTURE.md): component boundaries');
  lines.push('- [Quickstart](https://github.com/ashlrai/phantom/blob/master/docs/QUICKSTART.md): first useful turn');
  lines.push('- [CLI reference](https://github.com/ashlrai/phantom/blob/master/docs/CLI-REFERENCE.md): generated command table');
  lines.push('- [Agent readiness](https://github.com/ashlrai/phantom/blob/master/docs/AGENT-READINESS.md): scorer source and rubric');
  lines.push('');

  // Agent resources
  lines.push('## Agent-facing resources');
  lines.push('');
  lines.push('- [llms.txt](https://verse.ashlr.ai/llms.txt): concise agent index');
  lines.push('- [Sitemap](https://verse.ashlr.ai/sitemap.xml): complete page index');
  lines.push('- [server.json](https://github.com/ashlrai/phantom/blob/master/server.json): machine-readable server config');
  lines.push(`- [Agent docs command](https://github.com/ashlrai/phantom/blob/master/docs/AGENT-READINESS.md): \`${installBin} docs --agent --json\``);
  lines.push('');

  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Write / check
// ---------------------------------------------------------------------------

export function buildSiteLlms(root = defaultRoot) {
  const data = gather(root);
  return {
    'llms.txt': renderLlmsTxt(data),
    'llms-full.txt': renderLlmsFull(data),
  };
}

function main(args) {
  const check = args.includes('--check');
  const rootIndex = args.indexOf('--root');
  const root = rootIndex >= 0 && args[rootIndex + 1] ? resolve(args[rootIndex + 1]) : defaultRoot;
  const siteDir = resolve(root, 'site');
  const outputs = buildSiteLlms(root);

  if (check) {
    let stale = false;
    for (const [name, content] of Object.entries(outputs)) {
      const target = resolve(siteDir, name);
      try {
        const current = readFileSync(target, 'utf8');
        if (current !== content) {
          console.error(`site/${name} is stale; run 'node scripts/generate-site-llms.mjs'`);
          stale = true;
        }
      } catch {
        console.error(`site/${name} is missing; run 'node scripts/generate-site-llms.mjs'`);
        stale = true;
      }
    }
    if (stale) process.exit(1);
    else console.log('site llms.txt files are current');
  } else {
    for (const [name, content] of Object.entries(outputs)) {
      writeFileSync(resolve(siteDir, name), content);
      console.log(`wrote site/${name}`);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) {
    console.error(`generate-site-llms: ${error.message}`);
    process.exitCode = 1;
  }
}
