/**
 * RQ-PHX-REDTESTFIXC356 pin for Tier-1 coverage of approval decisions.
 *
 * #6737 extracted the shared HTTP mutation gate into api-http-helpers.ts
 * and intentionally shrank the closure, so the API route aggregator and its
 * approvals projection are no longer closure members. The authorization
 * helpers that gate HTTP mutations and derive/record team approvals remain
 * in the closure. Keep their relative runtime import edges inside the
 * snapshot so a future refactor cannot silently remove their protection.
 *
 * Self-contained on purpose: importing `src/core/authority/**` would make
 * this file a Tier-1 test and require a CODEOWNERS entry, so the import
 * scan is reimplemented minimally here instead of importing the module.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SNAPSHOT = join(ROOT, 'test', 'fixtures', 'authority', 'tier1-closure.json');

/** Authorization helpers that must remain in the Tier-1 closure. */
const CLOSURE_MEMBER_FILES = [
  'src/core/web/api-http-helpers.ts',
  'src/core/teams/identity.ts',
  'src/core/teams/workspace.ts',
];

/**
 * Runtime module specifiers — the same subset the closure test counts:
 * static imports/re-exports and literal dynamic `import()`s, minus
 * type-only imports (erased at compile time). Type-position `import()`
 * never reaches this walker because it parses as a type node.
 */
function relativeSpecifiers(file: string): string[] {
  const text = readFileSync(join(ROOT, file), 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
  const out = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      let runtime = true;
      if (clause?.isTypeOnly) runtime = false;
      else if (clause && !clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        const elements = clause.namedBindings.elements;
        if (elements.length > 0 && elements.every((element) => element.isTypeOnly)) runtime = false;
      }
      if (runtime) out.add(node.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)
    ) {
      out.add(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node)
      && node.expression.kind === ts.SyntaxKind.ImportKeyword
      && node.arguments.length === 1
      && ts.isStringLiteral(node.arguments[0]!)
    ) {
      out.add(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return [...out].filter((s) => s.startsWith('./') || s.startsWith('../'));
}

/** Resolve a relative specifier to a repo-relative .ts path (mirrors NodeNext `.js` → `.ts`). */
function resolveToRepoPath(fromFile: string, specifier: string): string | null {
  const baseDir = dirname(join(ROOT, fromFile));
  const abs = resolve(baseDir, specifier);
  const rel = abs.slice(ROOT.length + 1).split('\\').join('/');
  if (!rel || rel.includes('..')) return null;
  return rel.replace(/\.(?:js|mjs|cjs)$/, (ext) => (ext === '.mjs' ? '.mts' : ext === '.cjs' ? '.cts' : '.ts'));
}

describe('redtest-5038-c356: approval authorization stays in the Tier-1 closure', () => {
  const closure = new Set<string>(
    (JSON.parse(readFileSync(SNAPSHOT, 'utf8')) as { closure: string[] }).closure,
  );

  it('the authorization helpers are still closure members', () => {
    for (const file of CLOSURE_MEMBER_FILES) {
      expect(closure.has(file), `${file} left the Tier-1 closure snapshot`).toBe(true);
    }
  });

  it('every relative import edge resolves inside the Tier-1 closure snapshot', () => {
    const outside: string[] = [];
    for (const file of CLOSURE_MEMBER_FILES) {
      for (const specifier of relativeSpecifiers(file)) {
        const resolved = resolveToRepoPath(file, specifier);
        if (!resolved) continue;
        // Directory imports resolve to index.ts, same as the authority test.
        if (!closure.has(resolved) && !closure.has(`${resolved}/index.ts`)) {
          outside.push(`${file} -> ${specifier} (${resolved})`);
        }
      }
    }
    expect(
      outside,
      [
        'These authorization import edges point outside the Tier-1 closure snapshot.',
        'Review the change, then regenerate under review:',
        '  ASHLR_UPDATE_TIER1_CLOSURE=1 npx vitest run test/authority-tier1-closure-310b.test.ts',
      ].join('\n'),
    ).toEqual([]);
  });
});
