/**
 * test/phx-needsyoudoc31.test.ts — ensures docs/NEEDS-YOU.md stays in sync
 * with fleet-needs-you.ts.
 *
 * Reads the source file from disk, collects every `id: '...'` or
 * `id: \`...\`` literal (stripping the `:${...}` suffix to the prefix,
 * e.g. `lane-held:${l.lane}` → `lane-held`), and asserts the doc
 * mentions each unique prefix.
 */

import { strict as assert } from 'node:assert';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = resolve(__filename, '..');
const PROJECT_ROOT = resolve(__dirname, '..');

function extractFleetNeedYouIds(sourcePath: string): Set<string> {
  const content = readFileSync(sourcePath, 'utf-8');
  // Match both: id: 'literal' and id: `template:${...}`
  const idRegex = /id:\s*['"`]([^'"`]+)['"`]/g;
  const prefixes = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = idRegex.exec(content)) !== null) {
    const raw = m[1];
    // Strip everything from the first `:` (template suffix)
    const prefix = raw.split(':')[0];
    if (prefix) prefixes.add(prefix);
  }
  return prefixes;
}

function readDocsPath(): string {
  return readFileSync(resolve(PROJECT_ROOT, 'docs', 'NEEDS-YOU.md'), 'utf-8');
}

describe('phx-needsyoudoc31 — NEEDS-YOU.md stays in sync', () => {
  const sourceFile = resolve(
    PROJECT_ROOT,
    'src',
    'web-ui',
    'routes',
    'verse',
    'shell',
    'fleet-needs-you.ts',
  );

  it('mentions every fleet-needs-you.ts id prefix', () => {
    const prefixes = extractFleetNeedYouIds(sourceFile);
    const doc = readDocsPath();
    const missing: string[] = [];
    for (const prefix of prefixes) {
      // Use a word-boundary match to avoid partial matches
      const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`(?:^|\\s|>)${escaped}(?:\\s|<|$|:)`);
      if (!regex.test(doc)) {
        missing.push(prefix);
      }
    }
    assert.strictEqual(
      missing.length,
      0,
      `NEEDS-YOU.md is missing these fleet prefixes: ${missing.join(', ')}`,
    );
  });
});
