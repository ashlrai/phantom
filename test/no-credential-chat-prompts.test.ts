import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

// Check literal prompt text, including JSX text. Dynamic provider text is not
// covered by this static check and must be handled at its own trust boundary.
function asksForCredentialInChat(text: string): boolean {
  return /\bpaste\b(?=[^.\n]{0,160}\b(?:key|token|code|password|credential)\b)(?=[^.\n]{0,160}\b(?:chat|conversation|message)\b)/i.test(text)
    && !/\b(?:do not|don't|never|cannot|must not)\s+paste\b/i.test(text);
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /(?<!\.test)\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe('credential chat prompts', () => {
  it('detects a request to submit a credential to chat', () => {
    expect(asksForCredentialInChat('Please paste your API key into chat.')).toBe(true);
    expect(asksForCredentialInChat('Never paste a password into chat.')).toBe(false);
    expect(asksForCredentialInChat('Enter the code on the provider website.')).toBe(false);
  });

  it('does not include such literal prompts in application source', () => {
    const violations: string[] = [];
    for (const path of sourceFiles('src')) {
      const contents = readFileSync(path, 'utf8');
      if (!/\bpaste\b/i.test(contents)) continue;
      const source = ts.createSourceFile(path, contents, ts.ScriptTarget.Latest, true,
        path.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
      function visit(node: ts.Node): void {
        if ((ts.isStringLiteralLike(node) || ts.isJsxText(node)) && asksForCredentialInChat(node.text)) {
          violations.push(`${path}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
        }
        ts.forEachChild(node, visit);
      }
      visit(source);
    }
    expect(violations).toEqual([]);
  }, 30_000);
});
