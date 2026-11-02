/**
 * RQ-TIER1CLOSURE2Q8 — guards the boundary that keeps core/ask/fanout.ts out
 * of the Tier-1 authority import closure.
 *
 * fleet/router-queue.ts is inside the closure, so every module it loads can
 * change what a gate does. The ask.v1 fanout projection must stay outside it:
 * `routerQueueAskFanout` receives the projection as an injected parameter and
 * the module may carry only a type-only import of core/ask/fanout.ts.
 *
 * The specifier scan reuses the 310b closure test's runtime rules: static
 * imports that survive compilation, re-exports and literal dynamic import()s
 * count; type-only imports and all-type-only named bindings are erased.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fanoutAskV1, type AskFanoutQueueV1 } from '../src/core/ask/fanout.js';
import { routerQueueAskFanout } from '../src/core/fleet/router-queue.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FROM = join(ROOT, 'src', 'core', 'fleet', 'router-queue.ts');
const CUT_SPECIFIER = '../ask/fanout.js';

const REPOS = ['phantom', 'phantom-secrets', 'locus', 'lexicon', 'ashlr-stack', 'ashlr-cortex', 'ashlr-md']
  .map((name) => `ashlrai/${name}`);

/** The same runtime-specifier rules as test/authority-tier1-closure-310b.test.ts. */
function runtimeSpecifiers(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      let runtime = true;
      if (clause?.isTypeOnly) runtime = false;
      else if (clause && !clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        const elements = clause.namedBindings.elements;
        if (elements.length > 0 && elements.every((element) => element.isTypeOnly)) runtime = false;
      }
      if (runtime) out.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const elements = node.exportClause && ts.isNamedExports(node.exportClause) ? node.exportClause.elements : null;
      if (!node.isTypeOnly && !(elements && elements.length > 0 && elements.every((element) => element.isTypeOnly))) {
        out.push(node.moduleSpecifier.text);
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const first = node.arguments[0];
      if (first && ts.isStringLiteralLike(first)) out.push(first.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

function importClausesFor(file: string, specifier: string): ts.ImportClause[] {
  const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.ES2022, true);
  const clauses: ts.ImportClause[] = [];
  ts.forEachChild(source, (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) &&
      node.moduleSpecifier.text === specifier && node.importClause) clauses.push(node.importClause);
  });
  return clauses;
}

describe('the router-queue → ask/fanout edge stays cut', () => {
  it('carries no runtime specifier for the projection module', () => {
    expect(runtimeSpecifiers(FROM)).not.toContain(CUT_SPECIFIER);
  });

  it('keeps only a type-only import for the injected signature', () => {
    const clauses = importClausesFor(FROM, CUT_SPECIFIER);
    expect(clauses.length).toBeGreaterThan(0);
    for (const clause of clauses) {
      const allTypeOnlyNamed = !clause.name && clause.namedBindings !== undefined &&
        ts.isNamedImports(clause.namedBindings) && clause.namedBindings.elements.length > 0 &&
        clause.namedBindings.elements.every((element) => element.isTypeOnly);
      expect(clause.isTypeOnly || allTypeOnlyNamed).toBe(true);
    }
  });
});

describe('the injected fanout boundary', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'tier1-cut-'));
    writeFileSync(join(root, 'config.json'), JSON.stringify({ v: 1, repositories: REPOS }), { mode: 0o600 });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('routes through the injected projection over the configured allowlist', () => {
    const sentinel: AskFanoutQueueV1 = { schema: 'queue.v1', jobs: [] };
    const seen: { ask: unknown; repos: ReadonlySet<string> }[] = [];
    const stub = (ask: unknown, allowedRepos: ReadonlySet<string>): AskFanoutQueueV1 => {
      seen.push({ ask, repos: allowedRepos });
      return sentinel;
    };
    const ask = { schema: 'ask.v1' };
    expect(routerQueueAskFanout(ask, stub, root)).toBe(sentinel);
    expect(seen).toEqual([{ ask, repos: new Set(REPOS) }]);
  });

  it('fails closed before the projection when the queue is unconfigured', () => {
    rmSync(join(root, 'config.json'));
    const stub = vi.fn();
    expect(() => routerQueueAskFanout({}, stub, root)).toThrow();
    expect(stub).not.toHaveBeenCalled();
  });

  it('composes with the real fanoutAskV1 the CLI injects', () => {
    const ask = { schema: 'ask.v1', id: 'ASK-CUT-1', tier: 'work', pool: 'devin', priority: 'P1', repos: [REPOS[0]], task: 'Ship it.' };
    const result = routerQueueAskFanout(ask, fanoutAskV1, root);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]!.repo).toBe('phantom');
  });
});
