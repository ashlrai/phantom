import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CLI_DIR = resolve(fileURLToPath(import.meta.url), '..', '..', 'src', 'cli');
const REGISTRY_FILE = 'fleet-subcommand-registry.ts';
const REGISTRY_PATH = join(CLI_DIR, REGISTRY_FILE);

/** Compute verbs that the generator script would actually include:
 *  - skip test files and the registry itself
 *  - a file counts when it has `export async function` or exports
 *    `cmdFleet<PascalCase>` as an async arrow const — the same two shapes
 *    scripts/gen-fleet-registry.mjs accepts
 */
function cliVerbs(): string[] {
  return readdirSync(CLI_DIR)
    .filter(file => /^fleet-.*\.ts$/.test(file) && !file.endsWith('.test.ts'))
    .flatMap(file => {
      const verb = file.slice('fleet-'.length, -3);
      // Skip infrastructure files the generator intentionally skips
      if (verb === 'subcommand-registry' || verb === 'subcommand-resolve') return [];
      const exportName = 'cmdFleet' + verb.split('-').map(part =>
        part[0].toUpperCase() + part.slice(1)
      ).join('');
      const content = readFileSync(resolve(CLI_DIR, file), 'utf8');
      return new RegExp(`\\bexport\\s+(?:async\\s+function\\s+|const\\s+${exportName}\\s*=\\s*async\\s*\\()`).test(content)
        ? [verb]
        : [];
    })
    .sort();
}

/** Pull every verb key from the generated registry source. */
function registryVerbs(source: string): string[] {
  const re = /'([^']+)'\s*:\s*\(\)\s*=>\s*import\(/g;
  const verbs: string[] = [];
  for (const m of source.matchAll(re)) {
    verbs.push(m[1]);
  }
  return verbs.sort();
}

describe(REGISTRY_FILE + ' completeness', () => {
  it('every convention-based CLI verb appears in the registry', () => {
    const registry = readFileSync(REGISTRY_PATH, 'utf8');
    const cli = cliVerbs();
    const reg = registryVerbs(registry);

    const missing = cli.filter(v => !reg.includes(v));
    if (missing.length > 0) {
      expect(missing).toEqual([]); // fails with list of missing verbs
    }
  });

  it('no orphaned verb in the registry without a convention-based CLI file', () => {
    const registry = readFileSync(REGISTRY_PATH, 'utf8');
    const cli = cliVerbs();
    const reg = registryVerbs(registry);

    const extra = reg.filter(v => !cli.includes(v));
    expect(extra).toEqual([]);
  });
});
