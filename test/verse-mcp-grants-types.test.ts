import { readFileSync } from 'node:fs';
import ts from 'typescript';
import { expect, it } from 'vitest';

it('keeps MCP grants free of explicit any types and suppressed type errors', () => {
  const source = readFileSync(new URL('../src/core/verse/verse-mcp-grants.ts', import.meta.url), 'utf8');
  const file = ts.createSourceFile('verse-mcp-grants.ts', source, ts.ScriptTarget.Latest, true);
  const unsafeLines: number[] = [];
  const visit = (node: ts.Node): void => {
    if (node.kind === ts.SyntaxKind.AnyKeyword) {
      unsafeLines.push(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  expect(unsafeLines).toEqual([]);

  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.Standard, source);
  const suppressions: string[] = [];
  for (let kind = scanner.scan(); kind !== ts.SyntaxKind.EndOfFileToken; kind = scanner.scan()) {
    if (kind === ts.SyntaxKind.SingleLineCommentTrivia || kind === ts.SyntaxKind.MultiLineCommentTrivia) {
      const comment = scanner.getTokenText();
      if (/@ts-(?:ignore|expect-error)\b/.test(comment)) suppressions.push(comment);
    }
  }
  expect(suppressions).toEqual([]);
});
