import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { FLEET_SUBCOMMAND_LOADERS } from '../src/cli/fleet-subcommand-registry.js';

const REPO_ROOT = dirname(fileURLToPath(import.meta.url));
const CLI_DIR = resolve(REPO_ROOT, '../src/cli');

/** Check if a source file contains any one-line help constant (usage / USAGE / *_USAGE). */
function hasOneLineHelp(source: string): { found: boolean; text: string } {
  const patterns: RegExp[] = [
    // const usage = '...'  (single/double quote, single line)
    /(?:const|readonly)\s+(?:usage|USAGE)\s*=\s*['"]([^'"]+)/,
    // const usage = `...`  (template literal, single line)
    /(?:const|readonly)\s+(?:usage|USAGE)\s*=\s*`([^\`]+)/,
    // export const FLEET_*_USAGE = '...'  (exported, multi-line string)
    /export\s+const\s+\w*USAGE\s*=\s*(["'])((?:.|\n)*?)(?<!\\)\1/,
    // export const FLEET_*_USAGE = \`...\`  (exported template literal)
    /export\s+const\s+\w*USAGE\s*=\s*\`([^\`]+)/,
  ];

  for (const pattern of patterns) {
    const m = source.match(pattern);
    if (!m) continue;
    let raw = '';
    for (let g = 1; g < m.length; g++) {
      if (m[g] && m[g].length > raw.length) raw = m[g];
    }
    if (raw.length === 0) continue;
    const firstLine = raw.split('\n')[0].trim();
    return { found: true, text: firstLine };
  }
  return { found: false, text: '' };
}

describe('fleet-registry-help: every loaded verb has one-line help', () => {
  it.each(Object.keys(FLEET_SUBCOMMAND_LOADERS))('verb "%s" has non-empty help text', async (verb) => {
    const loader = FLEET_SUBCOMMAND_LOADERS[verb];
    expect(typeof loader, `loader for ${verb}`).toBe('function');

    const filePath = resolve(CLI_DIR, `fleet-${verb}.ts`);
    const source = readFileSync(filePath, 'utf8');
    const { found, text } = hasOneLineHelp(source);

    expect(found, `${verb}: missing help text`).toBe(true);
    expect(text.length > 0, `${verb}: empty help text`).toBe(true);
    expect(text, `${verb}`).toMatch(/^Usage:|^usage:|^ashlr|^phm/);
  });
});
