/**
 * RQ-PHX-REDDESKFIXC212: regression pin for the #5266 bridge re-land.
 *
 * #5266 (RECUTDESKS0C206) wired /api/ui-settings through the real handleApi
 * dispatcher and added dispatcher-level coverage, but its
 * test/fixtures/authority/tier1-closure.json snapshot predated the ui-settings
 * Tier-1 roots, so test/authority-tier1-closure-310b.test.ts failed inside the
 * "Quick typecheck" check while tsc itself stayed green.
 *
 * This pins both halves of the corrected state through the real code path:
 *   1. src/core/web/api.ts keeps a runtime (not type-only) import of
 *      ./ui-settings-api.js — parsed with the TypeScript compiler.
 *   2. The Tier-1 closure snapshot names every ui-settings module the route
 *      pulls in.
 *   3. writeUiSettings/readUiSettings merge a patch around a wrong-type group
 *      and keep the file's existing values for the rest — the behavior the
 *      re-landed route depends on.
 *
 * Hermetic: writes only under mkdtemp; reads repo files read-only.
 */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readUiSettings, writeUiSettings } from '../src/core/ui-settings.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const API = 'src/core/web/api.ts';
const CLOSURE_FILES = [
  'src/core/ui-settings-schema.ts',
  'src/core/ui-settings.ts',
  'src/core/web/ui-settings-api.ts',
] as const;

/** True when `file` has a runtime import of `specifier` (mirrors the closure test's rules). */
function importsAtRuntime(file: string, specifier: string): boolean {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
  let found = false;
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.moduleSpecifier.text === specifier) {
      const clause = node.importClause;
      const allTypeOnly =
        clause?.isTypeOnly === true ||
        (clause !== undefined && clause !== null && !clause.name &&
          clause.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings) &&
          clause.namedBindings.elements.length > 0 &&
          clause.namedBindings.elements.every((element) => element.isTypeOnly));
      if (!allTypeOnly) found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

let home: string;
let realHome: string | undefined;
beforeEach(() => {
  realHome = process.env['HOME'];
  home = mkdtempSync(join(tmpdir(), 'reddesk-fix-c212-'));
  process.env['HOME'] = home;
});
afterEach(() => {
  if (realHome === undefined) delete process.env['HOME'];
  else process.env['HOME'] = realHome;
  rmSync(home, { recursive: true, force: true });
});

describe('RQ-PHX-REDDESKFIXC212 (#5266 closure fix)', () => {
  it('api.ts runtime-imports the ui-settings API module', () => {
    expect(importsAtRuntime(join(ROOT, API), './ui-settings-api.js')).toBe(true);
  });

  it('the Tier-1 closure snapshot names every ui-settings module', () => {
    const snapshot = JSON.parse(
      readFileSync(join(ROOT, 'test', 'fixtures', 'authority', 'tier1-closure.json'), 'utf8'),
    ) as { closure: string[] };
    for (const file of CLOSURE_FILES) expect(snapshot.closure).toContain(file);
  });

  it('writeUiSettings merges around a wrong-type group and keeps file values', () => {
    writeUiSettings({ appearance: { theme: 'dark' }, layout: { sidebarWidth: 300 } });
    const patched = writeUiSettings({ appearance: 'dark', layout: { railExpanded: true } });
    expect(patched.problems).toEqual(['"appearance" must be an object']);
    expect(patched.settings.appearance['theme']).toBe('dark');
    expect(patched.settings.layout).toMatchObject({ sidebarWidth: 300, railExpanded: true });
    const reread = readUiSettings();
    expect(reread.parsed).toBe(true);
    expect(reread.settings.appearance['theme']).toBe('dark');
    expect(reread.settings.layout['railExpanded']).toBe(true);
  });
});
