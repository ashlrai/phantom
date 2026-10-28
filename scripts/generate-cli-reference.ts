import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';

/** Keep formatting stable across terminals and platforms; preserve command text. */
export function renderCliReference(summary: string, commands: string): string {
  const normalize = (text: string): string => stripVTControlCharacters(text)
    .replace(/\r\n/g, '\n')
    .replace(/\u2014/g, '-')
    .split('\n').map(line => line.trimEnd()).join('\n').trim();
  return `# CLI reference

Generated from the source CLI's \`phm --help\` and \`phm help --all\` output.
For command-specific options, run \`phm help <topic>\` or \`phm <command> --help\`.
This describes the checkout; an installed older binary may differ.

Regenerate from the repository root with:

\`\`\`sh
node --import tsx scripts/generate-cli-reference.ts
\`\`\`

Check without writing with the same command followed by \`--check\`.
Terminal colors and trailing whitespace are removed, and em dashes become hyphens.

## Overview

\`\`\`text
${normalize(summary)}
\`\`\`

## All commands

\`\`\`text
${normalize(commands)}
\`\`\`
`;
}

function main(): void {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const target = resolve(root, 'docs/CLI-REFERENCE.md');
  const help = (args: string[]): string => execFileSync(process.execPath,
    ['--import', 'tsx', 'src/cli/index.ts', ...args], {
      cwd: root, encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, NO_COLOR: '1', FORCE_COLOR: '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  const reference = renderCliReference(help(['--help']), help(['help', '--all']));
  if (process.argv.includes('--check')) {
    if (readFileSync(target, 'utf8') !== reference) {
      throw new Error('CLI reference drift: run node --import tsx scripts/generate-cli-reference.ts');
    }
  } else {
    writeFileSync(target, reference);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
