#!/usr/bin/env node
/** Offline aggregation: node scripts/generate-ecosystem-changelog.mjs INPUT_ROOT [OUTPUT] */
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const TIERS = [
  ['phantom'],
  ['phantom-secrets', 'locus'],
  ['ashlr-md', 'ashlr-stack', 'lexicon', 'ashlr-plugin'],
];
const repos = TIERS.flat();
const repoUrl = (repo) => `https://github.com/ashlrai/${repo}`;

// Existing Markdown links, URLs and inline code are opaque to reference expansion.
function linkReferences(line, repo) {
  return line.split(/(`+[^`]*`+|!?\[[^\]]*\]\([^)]*\)|https?:\/\/[^\s)]+)/g)
    .map((part, index) => index % 2 ? part : part.replace(
      /(?:\bashlrai\/([a-z][a-z0-9-]*)|\b(phantom-secrets|phantom|locus|ashlr-md|ashlr-stack|lexicon|ashlr-plugin))?#([1-9][0-9]*)\b/g,
      (match, qualified, short, number) => {
        const target = qualified ?? short ?? repo;
        return `[${match}](${repoUrl(target)}/pull/${number})`;
      },
    )).join('');
}

function renderRepo(repo, input) {
  const lines = input.replace(/\r\n?/g, '\n').replace(/\u2014/g, '-').split('\n');
  let fence;
  let hasRelease = false;
  const body = [];
  for (const line of lines) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      if (hasRelease) body.push(line);
      continue;
    }
    if (fence) {
      if (hasRelease) body.push(line);
      continue;
    }
    if (/^##\s+\S/.test(line)) hasRelease = true;
    if (!hasRelease) continue;
    const crossRepo = /\[cross-repo\]/i.test(line) || repos.some((other) =>
      other !== repo && (line.includes(`${other}#`) || line.includes(`${repoUrl(other)}/`)));
    let rendered = linkReferences(line, repo);
    if (crossRepo && !/\[cross-repo\]/i.test(rendered)) rendered += ' [cross-repo]';
    // Nest source release and category headings under the repository heading.
    rendered = rendered.replace(/^(#{2,4}) /, '$1## ');
    body.push(rendered);
  }
  if (!hasRelease) throw new Error(`${repo}: expected at least one level-two release heading`);
  if (!body.some((line) => line.trim() && !/^#/.test(line))) {
    throw new Error(`${repo}: changelog has no release content`);
  }
  return `### [${repo}](${repoUrl(repo)})\n\n${body.join('\n').trim()}`;
}

export function generateEcosystemChangelog(inputs) {
  const sections = TIERS.map((tier, index) => {
    const entries = tier.map((repo) => {
      if (typeof inputs[repo] !== 'string') throw new Error(`${repo}: missing CHANGELOG.md input`);
      return renderRepo(repo, inputs[repo]);
    });
    return `## Tier ${index + 1}\n\n${entries.join('\n\n')}`;
  });
  return '# Ecosystem changelog\n\nGenerated from seven local CHANGELOG.md inputs. Source order is preserved within each repo.\n'
    + 'Entries marked [cross-repo] explicitly declare coordination or reference another ecosystem repo.\n\n'
    + sections.join('\n\n') + '\n';
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2);
    if (args.length < 1 || args.length > 2 || args[0].startsWith('-')) {
      throw new Error('usage: node scripts/generate-ecosystem-changelog.mjs INPUT_ROOT [OUTPUT]');
    }
    // Read and validate all seven before opening the output. No partial write on bad input.
    const paths = repos.map((repo) => join(resolve(args[0]), repo, 'CHANGELOG.md'));
    const destination = resolve(args[1] ?? 'ECOSYSTEM_CHANGELOG.md');
    if (existsSync(destination) && paths.some((path) => realpathSync(path) === realpathSync(destination))) {
      throw new Error('output must not overwrite an input CHANGELOG.md');
    }
    const inputs = Object.fromEntries(repos.map((repo, index) => [repo,
      readFileSync(paths[index], 'utf8'),
    ]));
    const output = generateEcosystemChangelog(inputs);
    writeFileSync(destination, output, 'utf8');
  } catch (error) {
    // File contents are never included in diagnostics.
    console.error(`ecosystem-changelog: ${error.code ?? error.message}`);
    process.exitCode = 1;
  }
}
