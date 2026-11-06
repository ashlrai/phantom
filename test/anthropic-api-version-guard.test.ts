import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { ANTHROPIC_API_VERSION } from '../src/core/run/model-catalog.js';

const ROOT = join(import.meta.dirname, '..');
const CANONICAL = 'src/core/run/model-catalog.ts';
const VERSION = '2026-10-21';
const LEGACY = '2023-06-01';
const FORBIDDEN = /anthropic-version|2023-06-01|2026-10-21/i;

function literals(source: string, path = 'fixture.ts'): Array<{ value: string; line: number }> {
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  const found: Array<{ value: string; line: number }> = [];
  function visit(node: ts.Node): void {
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) {
      found.push({ value: node.text, line: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1 });
    }
    ts.forEachChild(node, visit);
  }
  visit(file);
  return found;
}

function violations(source: string, path = 'fixture.ts'): string[] {
  // Decode only for candidate selection; the AST still decides what is a literal.
  // This avoids parsing every large module that merely contains a Unicode regex.
  const candidate = source.replace(/\\(?:u\{([\da-f]{1,6})\}|u([\da-f]{4})|x([\da-f]{2}))/gi,
    (escape, braced: string | undefined, unicode: string | undefined, hex: string | undefined) => {
      const point = Number.parseInt(braced ?? unicode ?? hex!, 16);
      return point <= 0x10ffff ? String.fromCodePoint(point) : escape;
    });
  if (!FORBIDDEN.test(candidate)) return [];
  return literals(source, path)
    .filter(({ value }) => FORBIDDEN.test(value))
    .map(({ line }) => `${path}:${line}`);
}

function productionFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : productionFiles(path);
    if (!entry.isFile() || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(entry.name)) return [];
    return /\.[cm]?[jt]sx?$/.test(entry.name) || !entry.name.includes('.') ? [path] : [];
  });
}

describe('Anthropic API version source guard', () => {
  it.each([
    `const headers = { 'anthropic-version': '${LEGACY}' };`,
    `const headers = { ['Anthropic-Version']: '2099-01-01' };`,
    'headers.set("anthropic-version", version);',
    'headers.append(`anthropic-version`, version);',
    'const header = `anthropic-version: ${version}`;',
    'headers.set("anthropic\\u002dversion", version);',
    'headers.set("anthropic\\x2dversion", version);',
    "const duplicate = '2023\\u{002d}06\\u002d01';",
    `const duplicate = '${VERSION}';`,
    `const duplicate = \`${LEGACY}\`;`,
  ])('rejects a duplicate or inline header: %s', source => {
    expect(violations(source)).not.toEqual([]);
  });

  it('ignores comments, unrelated dates and calls to the shared helper', () => {
    expect(violations([
      `// anthropic-version: ${LEGACY}`,
      `/* '${VERSION}' */`,
      "const capturedAt = '2026-10-20';",
      "const headers = { ...anthropicVersionHeaders('anthropic') };",
    ].join('\n'))).toEqual([]);
  });

  it('pins the sole version literal to the exported constant', () => {
    const source = readFileSync(join(ROOT, CANONICAL), 'utf8');
    const file = ts.createSourceFile(CANONICAL, source, ts.ScriptTarget.Latest, true);
    const declarations = file.statements.filter(ts.isVariableStatement)
      .filter(statement => statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword))
      .filter(statement => (statement.declarationList.flags & ts.NodeFlags.Const) !== 0)
      .flatMap(statement => statement.declarationList.declarations)
      .filter(declaration => ts.isIdentifier(declaration.name) && declaration.name.text === 'ANTHROPIC_API_VERSION');
    expect(declarations).toHaveLength(1);
    const initializer = declarations[0]?.initializer;
    expect(initializer && ts.isStringLiteral(initializer) ? initializer.text : null).toBe(VERSION);
    expect(literals(source).filter(({ value }) => value === VERSION || value === LEGACY).map(({ value }) => value)).toEqual([VERSION]);
    expect(ANTHROPIC_API_VERSION).toBe(VERSION);
  });

  it('requires all production callers to use the shared version helper', () => {
    const paths = ['src', 'scripts', 'bin'].flatMap(directory => productionFiles(join(ROOT, directory)));
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.flatMap(path => {
      const name = relative(ROOT, path).replaceAll('\\', '/');
      return name === CANONICAL ? [] : violations(readFileSync(path, 'utf8'), name);
    })).toEqual([]);
  });
});
