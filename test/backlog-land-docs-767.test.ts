import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// @ts-expect-error Standalone documentation checker has no declaration output.
import { checkDocumentation } from '../scripts/check-documentation.mjs';

const root = resolve(__dirname, '..');
const path = resolve(root, 'CONTRIBUTING.md');
const guide = readFileSync(path, 'utf8');
const gate = guide.split('### What Merge Gate requires\n')[1]?.split('\n---\n')[0] ?? '';

describe('PR #7188 contributor documentation preservation', () => {
  it('keeps the missing clone, check table and commit guidance', () => {
    expect(existsSync(path)).toBe(true);
    expect(guide).toContain('Use a full-history clone so diff-based\n   checks have a merge base');
    const checks = [...gate.matchAll(/^\| ([^|]+) \|/gm)].map((match) => match[1].trim());
    expect(checks).toEqual([
      'Check', 'Secret-shape scan, Secret scan (diff)', 'Classify PR site lane',
      'Check generated files', 'Fast gate (typecheck + affected tests)',
    ]);
    expect(gate).toContain('canonical launcher digests');
    expect(gate).toContain('node scripts/generate-docs-llms.mjs');
    expect(gate).toContain('doc-reading tests for docs-only changes');
    expect(gate).toContain('full suites, which build first');
    expect(gate).not.toContain('docs-only diffs run no tests');
    expect(guide).toContain('[Conventional Commits](https://www.conventionalcommits.org/) syntax: `type(scope): imperative summary`');
    expect(guide).toContain('Fleet agents use the `bridge(<job>):` type');
    expect(guide).toContain('seven daily slices');
  });

  it('resolves every relative file and anchor link in the carried guide', () => {
    const result = checkDocumentation({ root, mode: 'source', entrypoints: ['CONTRIBUTING.md'] });
    expect(result.errors).toEqual([]);
    expect(result.localLinks).toBeGreaterThan(0);
    expect(result.externalRequests).toBe(0);
    expect(readFileSync(resolve(root, 'llms.txt'), 'utf8').startsWith('# Phantom\n')).toBe(true);
  });
});
