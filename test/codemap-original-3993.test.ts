/**
 * Marker-integrity semantics recovered from PR #3993 (scripts/lib/codemap.mjs
 * + its docs-sync.test.ts cases) onto today's scripts/codemap.mjs generator:
 * every encountered known section must have exactly one matched start/end
 * pair with matching names and no nesting; documents with no codemap markers
 * at all fail closed instead of passing through untouched.
 *
 * Tests drive the real regenerateCodemap / codemapInventory / syncCodemap
 * exports against fixture checkouts in tmp dirs — no source-text assertions.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { codemapInventory, regenerateCodemap, syncCodemap } from '../scripts/codemap.mjs';

const CODEMAP_DOC = `# Source code map

Manual prose stays put.

<!-- codemap:src:start -->
- \`src/old/\`
<!-- codemap:src:end -->

<!-- codemap:core:start -->
- \`src/core/old/\`
<!-- codemap:core:end -->

Trailing manual notes.
`;

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Fixture checkout: src dirs for codemap plus docs/CODEMAP.md. */
function fixtureRoot(doc: string = CODEMAP_DOC): string {
  const root = mkdtempSync(join(tmpdir(), 'codemap-3993-'));
  roots.push(root);
  for (const dir of ['src/alpha', 'src/beta', 'src/core/gamma', 'src/core/delta', 'docs']) {
    mkdirSync(join(root, dir), { recursive: true });
  }
  writeFileSync(join(root, 'docs', 'CODEMAP.md'), doc);
  return root;
}

describe('codemap marker integrity (PR #3993 semantics)', () => {
  it('renders sorted src/core inventories and preserves surrounding manual text', () => {
    const root = fixtureRoot();
    const out = regenerateCodemap(CODEMAP_DOC, root);
    expect(out).toContain('Manual prose stays put.');
    expect(out).toContain('Trailing manual notes.');
    expect(out).toContain('<!-- codemap:src:start -->\n- `src/alpha/`\n- `src/beta/`\n- `src/core/`\n<!-- codemap:src:end -->');
    expect(out).toContain('<!-- codemap:core:start -->\n- `src/core/delta/`\n- `src/core/gamma/`\n<!-- codemap:core:end -->');
    expect(out).not.toContain('src/old');
    expect(codemapInventory(root, 'src')).toEqual(['- `src/alpha/`', '- `src/beta/`', '- `src/core/`']);
    expect(codemapInventory(root, 'src/core')).toEqual(['- `src/core/delta/`', '- `src/core/gamma/`']);
  });

  it('rejects repeated complete blocks for the same section', () => {
    const root = fixtureRoot();
    const pair = '<!-- codemap:src:start -->\nx\n<!-- codemap:src:end -->\n';
    expect(() => regenerateCodemap(`# map\n\n${pair}\n${pair}`, root)).toThrow(/Duplicate codemap section: src/);
    // A second pair for a different section alongside is still fine.
    const mixed = `# map\n\n${pair}\n<!-- codemap:core:start -->\ny\n<!-- codemap:core:end -->\n`;
    expect(() => regenerateCodemap(mixed, root)).not.toThrow();
  });

  it('rejects documents with no codemap markers but keeps partial maps', () => {
    const root = fixtureRoot();
    expect(() => regenerateCodemap('# no markers\n', root)).toThrow(/No codemap markers/);
    // A doc covering only one known section still regenerates that block.
    const partial = '# map\n\n<!-- codemap:src:start -->\n- `src/old/`\n<!-- codemap:src:end -->\n';
    const out = regenerateCodemap(partial, root);
    expect(out).toContain('- `src/alpha/`');
    expect(out).not.toContain('codemap:core');
  });

  it('rejects mismatched and crossed close names', () => {
    const root = fixtureRoot();
    expect(() =>
      regenerateCodemap('<!-- codemap:src:start -->\nx\n<!-- codemap:core:end -->', root),
    ).toThrow(/Mismatched codemap end: src closed by core/);
    expect(() =>
      regenerateCodemap('<!-- codemap:core:start -->\nx\n<!-- codemap:src:end -->', root),
    ).toThrow(/Mismatched codemap end: core closed by src/);
  });

  it('rejects duplicate, nested, unmatched and malformed markers', () => {
    const root = fixtureRoot();
    expect(() =>
      regenerateCodemap('<!-- codemap:src:start -->\n<!-- codemap:src:start -->\n<!-- codemap:src:end -->', root),
    ).toThrow(/Nested/);
    expect(() => regenerateCodemap('<!-- codemap:src:end -->', root)).toThrow(/Unmatched/);
    expect(() => regenerateCodemap('<!-- codemap:src:start -->\n<!-- codemap:src:end -->\n<!-- codemap:src:end -->', root))
      .toThrow(/Unmatched/);
    expect(() => regenerateCodemap('<!--codemap:src:start-->', root)).toThrow(/Malformed/);
    expect(() => regenerateCodemap('<!-- codemap:SRC:start -->', root)).toThrow(/Malformed/);
    expect(() =>
      regenerateCodemap('<!-- codemap:bogus:start -->\nx\n<!-- codemap:bogus:end -->', root),
    ).toThrow(/Unknown codemap section/);
  });

  it('check mode never writes; write mode is idempotent', () => {
    const root = fixtureRoot();
    const path = join(root, 'docs', 'CODEMAP.md');
    const before = readFileSync(path, 'utf8');
    expect(syncCodemap(root, { check: true })).toEqual(['docs/CODEMAP.md']);
    expect(readFileSync(path, 'utf8')).toBe(before);
    syncCodemap(root);
    const written = readFileSync(path, 'utf8');
    expect(written).toContain('- `src/alpha/`');
    expect(syncCodemap(root, { check: true })).toEqual([]);
    syncCodemap(root);
    expect(readFileSync(path, 'utf8')).toBe(written);
  });

  it('invalid markers leave input bytes unchanged through syncCodemap', () => {
    const broken = [
      '# no markers\n',
      '<!-- codemap:src:start -->\nx\n<!-- codemap:src:end -->\n\n<!-- codemap:src:start -->\ny\n<!-- codemap:src:end -->\n',
      '<!-- codemap:src:start -->\nx\n<!-- codemap:core:end -->\n',
      '<!-- codemap:src:start -->\n',
      '<!--codemap:src:start-->\n',
    ];
    for (const doc of broken) {
      const root = fixtureRoot(doc);
      const path = join(root, 'docs', 'CODEMAP.md');
      const before = readFileSync(path, 'utf8');
      expect(() => syncCodemap(root)).toThrow();
      expect(() => syncCodemap(root, { check: true })).toThrow();
      expect(readFileSync(path, 'utf8')).toBe(before);
    }
  });
});
