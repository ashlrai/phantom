#!/usr/bin/env node
/**
 * Keep src/cli/help.ts HELP_ENTRIES and src/cli/completions.ts SUBCOMMANDS in
 * their merge-friendly layout (sorted, one entry per line).
 *
 *   node scripts/sort-cli-registries.mjs           # rewrite in place
 *   node scripts/sort-cli-registries.mjs --check   # exit 1 if a file would change
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sortHelpEntriesSource, sortSubcommandsSource } from './lib/cli-registry-sort.mjs';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const TARGETS = [
  ['src/cli/help.ts', sortHelpEntriesSource],
  ['src/cli/completions.ts', sortSubcommandsSource],
];

export function sortCliRegistries({ check = false, base = root } = {}) {
  const stale = [];
  for (const [file, sort] of TARGETS) {
    const path = resolve(base, file);
    const before = readFileSync(path, 'utf8');
    const after = sort(before);
    if (after === before) continue;
    stale.push(file);
    if (!check) writeFileSync(path, after);
  }
  return stale;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check');
  const stale = sortCliRegistries({ check });
  if (check && stale.length > 0) {
    console.error(`Not in merge-friendly order: ${stale.join(', ')}. Run node scripts/sort-cli-registries.mjs`);
    process.exitCode = 1;
  } else if (stale.length > 0) console.log(`sorted: ${stale.join(', ')}`);
}
