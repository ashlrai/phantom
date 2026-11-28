import { existsSync, readFileSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const doc = readFileSync('docs/PARITY.md', 'utf8');
const source = ts.createSourceFile('adapters.ts', readFileSync('src/core/agents/bus-cli-adapters.ts', 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

function providers(cli: string): string[] {
  let found: string[] = [];
  function visit(node: ts.Node): void {
    if (ts.isPropertyAssignment(node) && node.name.getText(source) === cli && ts.isObjectLiteralExpression(node.initializer)) {
      const field = node.initializer.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText(source) === 'providers');
      if (field && ts.isPropertyAssignment(field) && ts.isArrayLiteralExpression(field.initializer)) {
        found = field.initializer.elements.filter(ts.isStringLiteral).map(e => e.text);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return found;
}

describe('recovered capability audit', () => {
  it('covers the original agent classes', () => {
    for (const name of ['codex-cmp', 'codex-personal', 'codex-local', 'claude-api', 'zai', 'gemini', 'agy',
      'grok', 'cursor', 'devin', 'devin-flash', 'Sandboxed fleet engine', 'Node-pool workers',
      'iMessage teammates', 'Desktop apps', 'Interactive sessions']) expect(doc).toContain(name);
  });
  it('references existing source paths and absolute links', () => {
    const paths = [...doc.matchAll(/`((?:src|contrib)\/[\w./-]+\.\w+)`/g)].map(m => m[1]!);
    expect(paths.length).toBeGreaterThan(5);
    for (const path of paths) expect(existsSync(path), path).toBe(true);
    expect(doc).not.toMatch(/\]\((?!https?:|#)[^)]+\)/);
  });
  it('separates declarations, live tools, receipts, claims and authority', () => {
    expect(doc).toMatch(/declaration does not prove/);
    expect(doc).toMatch(/Slack receipt or claim notice is a message, not a live claim/);
    expect(doc).toMatch(/grants no tool,[\s\S]*execution authority/);
    expect(doc).toContain('fleet_bus_claims');
    expect(doc).toContain('Unknown until observed per session');
  });
  it('matches the actual adapter descriptors for GLM and local', () => {
    expect(providers('claude')).toContain('glm');
    expect(providers('codex')).toContain('local');
    expect(doc).toMatch(/Claude provider `glm`/);
    expect(doc).toMatch(/Codex provider `local`/);
    expect(doc).not.toMatch(/support is \*\*pending\*\*/);
  });
});
