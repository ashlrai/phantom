#!/usr/bin/env node
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const defaultRoot = fileURLToPath(new URL('../../', import.meta.url));
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

export function readFacts(root) {
  const pkg = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'));
  if (pkg.name !== '@ashlr/phantom' || !semver.test(pkg.version)) throw new Error('Invalid Phantom package identity or version');
  const changelog = readFileSync(resolve(root, 'CHANGELOG.md'), 'utf8');
  const release = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\][^\n]*?\b(\d{4}-\d{2}-\d{2})\s*$/gm)][0];
  if (!release) throw new Error('CHANGELOG.md has no dated released section');
  return { version: pkg.version, released: release[1], date: release[2] };
}

export function renderBlock(name, facts) {
  const { version, released, date } = facts;
  switch (name) {
    case 'version-badge':
      return `[![Source version ${version}](https://img.shields.io/badge/source-${version}-blue)](https://github.com/ashlrai/phantom)`;
    case 'install-snippet':
      return `Latest dated changelog release (verify promoted package availability before installing):\n\n\`\`\`sh\nnpm install -g @ashlr/phantom@${released}\nphm --version\n\`\`\``;
    case 'version-table':
      return `| Version source | Version |\n| --- | --- |\n| Source package | ${version} |\n| Latest dated changelog release (${date}) | ${released} |`;
    case 'example-version-pin':
      return `\`\`\`sh\nnpx --package=@ashlr/phantom@${released} phm --version\n\`\`\``;
    default: throw new Error(`Unknown freshness block: ${name}`);
  }
}

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
      output += text.slice(cursor, open.end) + newline + renderBlock(open.name, facts).replaceAll('\n', newline) + newline + match[0];
      cursor = match.index + match[0].length;
      open = undefined;
    }
  }
  if (open) throw new Error('Unclosed freshness block');
  output += text.slice(cursor);
  // Reject malformed markers rather than silently passing a mistyped managed block.
  const stripped = text.replace(marker, '');
  if (/<!--\s*fresh:/.test(stripped)) throw new Error('Malformed freshness marker');
  return output;
}

function documents(root, directory) {
  return readdirSync(resolve(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    if (entry.isSymbolicLink() || entry.name.startsWith('.') || entry.name === 'node_modules') return [];
    return entry.isDirectory() ? documents(root, path) : entry.name.endsWith('.md') ? [path] : [];
  });
}

export function synchronize(root = defaultRoot, { check = false } = {}) {
  const facts = readFacts(root);
  const files = ['README.md', 'CHANGELOG.md', ...documents(root, 'docs'), ...documents(root, 'examples')];
  const changes = [];
  for (const file of files) {
    const text = readFileSync(resolve(root, file), 'utf8');
    let generated;
    try { generated = regenerate(text, facts); } catch (error) { throw new Error(`${file}: ${error.message}`); }
    if (text !== generated) changes.push({ file, generated });
  }
  // Validate every document before writing any changes.
  if (!check) for (const { file, generated } of changes) writeFileSync(resolve(root, file), generated);
  return changes.map(({ file }) => file);
}

export function main(check, args = process.argv.slice(2)) {
  if (args.length && (args.length !== 2 || args[0] !== '--root')) throw new Error('Usage: node scripts/freshness/{sync,check}.mjs [--root directory]');
  const changed = synchronize(args.length ? resolve(args[1]) : defaultRoot, { check });
  for (const file of changed) console.log(`${check ? 'drift' : 'updated'}: ${file}`);
  if (check && changed.length) process.exitCode = 1;
  else console.log(`freshness: ${check ? 'in sync' : 'synchronized'}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(false); } catch (error) { console.error(`freshness: ${error.message}`); process.exitCode = 1; }
}
