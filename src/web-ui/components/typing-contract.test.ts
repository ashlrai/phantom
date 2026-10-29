import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import runStreamPanel from './stream/RunStreamPanel.tsx?raw';
import chartMath from './charts/chart-math.ts?raw';

function typingEscapes(name: string, source: string): string[] {
  const file = ts.createSourceFile(name, source, ts.ScriptTarget.Latest, true);
  const escapes: string[] = [];
  function visit(node: ts.Node): void {
    if (node.kind === ts.SyntaxKind.AnyKeyword) escapes.push(node.getText(file));
    ts.forEachChild(node, visit);
  }
  visit(file);
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.JSX, source);
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) {
      escapes.push(...scanner.getTokenText().match(/@ts-(?:ignore|expect-error)\b/g) ?? []);
    }
  }
  return escapes;
}

describe('stream and chart typing contract', () => {
  it.each([
    ['RunStreamPanel.tsx', runStreamPanel],
    ['chart-math.ts', chartMath],
  ])('%s uses real types without suppressions', (name, source) => {
    expect(typingEscapes(name, source)).toEqual([]);
  });

  it('detects explicit types, casts, and both suppression directives', () => {
    expect(typingEscapes('example.ts', [
      'let value: any;',
      'value as any;',
      '// @ts-ignore',
      '/* @ts-expect-error */',
    ].join('\n'))).toEqual(['any', 'any', '@ts-ignore', '@ts-expect-error']);
  });

  it('allows prose and string literals mentioning typing terms', () => {
    expect(typingEscapes('example.ts', '// any finite value\nconst label = "any @ts-ignore";')).toEqual([]);
  });
});
