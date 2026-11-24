import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import ts from 'typescript';

const root = new URL('../', import.meta.url);
describe('M2-7 unsigned offline stub boundary', () => {
  it('keeps the design pending Security review', () => {
    const doc = readFileSync(new URL('docs/design/multi-owner-fleet.md', root), 'utf8');
    expect(doc).toContain('pending Security review');
    expect(doc).toContain('M2 adds no signing, key or network code path');
  });

  it('new modules contain no signing, key generation, network imports or dynamic network APIs', () => {
    const modules = ['src/core/fleet/grants.ts', 'src/cli/bundle.ts',
      ...readdirSync(new URL('src/core/bundles/', root)).filter(name => name.endsWith('.ts'))
        .map(name => join('src/core/bundles', name))];
    const forbiddenImports = /^(?:node:)?(?:https?|http2|net|tls|dns|dgram)(?:\/|$)|^(?:undici|axios|node-fetch|got|ws)(?:\/|$)/;
    for (const name of ['node:dns/promises', 'dns/promises', 'node:https', 'undici/lib']) expect(forbiddenImports.test(name)).toBe(true);
    const forbiddenCalls = /^(?:fetch|WebSocket|XMLHttpRequest|sign|createSign|generateKeyPair(?:Sync)?|generateKey|createPrivateKey)$/;
    const errors: string[] = [];
    for (const path of modules) {
      const source = ts.createSourceFile(path, readFileSync(new URL(path, root), 'utf8'), ts.ScriptTarget.Latest, true);
      const visit = (node: ts.Node): void => {
        if (ts.isStringLiteral(node) && forbiddenImports.test(node.text)) errors.push(`${path}: network module`);
        if (ts.isIdentifier(node) && (forbiddenCalls.test(node.text) || node.text === 'subtle')) errors.push(`${path}: ${node.text}`);
        // Bracket access must not evade the API-name check.
        if (ts.isElementAccessExpression(node) && ts.isStringLiteral(node.argumentExpression)
          && (forbiddenCalls.test(node.argumentExpression.text) || node.argumentExpression.text === 'subtle')) errors.push(`${path}: indirect API`);
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(errors).toEqual([]);
  });
});
