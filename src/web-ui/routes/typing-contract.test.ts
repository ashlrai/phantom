import { describe, expect, it } from 'vitest';
import ts from 'typescript';
import seatStrip from './verse/command/seat-strip-model.ts?raw';
import activity from './verse/chat/activity-model.ts?raw';
import liveNow from './journal/LiveNowStrip.tsx?raw';

function typingEscapes(source: string): string[] {
  const scanner = ts.createScanner(ts.ScriptTarget.Latest, false, ts.LanguageVariant.JSX, source);
  const escapes: string[] = [];
  for (let token = scanner.scan(); token !== ts.SyntaxKind.EndOfFileToken; token = scanner.scan()) {
    if (token === ts.SyntaxKind.AnyKeyword) escapes.push(scanner.getTokenText());
    if (token === ts.SyntaxKind.SingleLineCommentTrivia || token === ts.SyntaxKind.MultiLineCommentTrivia) {
      const directives = scanner.getTokenText().match(/@ts-(?:ignore|expect-error)\b/g);
      if (directives) escapes.push(...directives);
    }
  }
  return escapes;
}

describe('route typing contracts', () => {
  it.each([
    ['seat-strip-model.ts', seatStrip],
    ['activity-model.ts', activity],
    ['LiveNowStrip.tsx', liveNow],
  ])('%s uses checked types without escape hatches', (_name, source) => {
    expect(typingEscapes(source)).toEqual([]);
  });

  it('detects explicit types, casts and suppression comments while allowing prose', () => {
    expect(typingEscapes('let value: any; value as any; // @ts-ignore\n/* @ts-expect-error */'))
      .toEqual(['any', 'any', '@ts-ignore', '@ts-expect-error']);
    expect(typingEscapes('// any run\nconst label = "any @ts-ignore";')).toEqual([]);
  });
});
