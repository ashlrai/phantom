import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const readmePath = fileURLToPath(new URL('../src/core/fleet/bus-adapters/README.md', import.meta.url));
const readme = readFileSync(readmePath, 'utf8');
const blocks = [...readme.matchAll(/```ts\n([\s\S]*?)```/g)].map(match => match[1]!);

// Inspect the documented imports against declarations, including erased type exports,
// without launching an adapter or depending on a full-prose snapshot.
describe('bus adapter documentation contract', () => {
  it('imports existing named exports from all six source modules', () => {
    const sample = ts.createSourceFile('imports.ts', blocks[0]!, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    const imports = sample.statements.filter(ts.isImportDeclaration);
    const expectedModules = [
      './codex.js', './devin.js', './grok.js', '../bus-envelope.js', '../bus-inbox.js', '../bus-wake.js',
    ];
    expect(imports.map(node => (node.moduleSpecifier as ts.StringLiteral).text)).toEqual(expectedModules);
    const names = new Set<string>();
    for (const node of imports) {
      const path = (node.moduleSpecifier as ts.StringLiteral).text;
      const sourcePath = resolve(dirname(readmePath), path.replace(/\.js$/, '.ts'));
      const source = ts.createSourceFile(sourcePath, readFileSync(sourcePath, 'utf8'), ts.ScriptTarget.Latest, true);
      const typeOnly = new Set(source.statements.flatMap(statement =>
        (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) ? [statement.name.text] : []));
      const exported = new Set(source.statements.flatMap(statement => {
        if (!ts.canHaveModifiers(statement) || !ts.getModifiers(statement)?.some(mod => mod.kind === ts.SyntaxKind.ExportKeyword)) return [];
        if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement) || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) && statement.name) return [statement.name.text];
        if (ts.isVariableStatement(statement)) return statement.declarationList.declarations.flatMap(declaration => ts.isIdentifier(declaration.name) ? [declaration.name.text] : []);
        return [];
      }));
      const bindings = node.importClause?.namedBindings;
      expect(bindings && ts.isNamedImports(bindings)).toBe(true);
      if (!bindings || !ts.isNamedImports(bindings)) throw new Error(`Missing named imports in ${path}`);
      for (const element of bindings.elements) {
        const name = (element.propertyName ?? element.name).text;
        expect(exported.has(name), `${path} must export ${name}`).toBe(true);
        expect(element.isTypeOnly || !!node.importClause?.isTypeOnly, `${name} import kind`).toBe(typeOnly.has(name));
        names.add(name);
      }
    }
    for (const name of ['runCodexBusAdapter', 'CodexBusPorts', 'runDevinBusAdapter', 'DevinBusRequest',
      'runGrokBusAdapter', 'GrokBusRequest', 'validateBusEnvelope', 'parseBusEnvelope',
      'appendBusInbox', 'listBusInboxAfter', 'createBusWakeHook', 'sendWithBusWake']) {
      expect(names.has(name), `README must document ${name}`).toBe(true);
    }
  });

  it('keeps its TypeScript examples syntactically valid', () => {
    expect(blocks).toHaveLength(2);
    for (const block of blocks) {
      const result = ts.transpileModule(block, { reportDiagnostics: true });
      expect(result.diagnostics).toEqual([]);
    }
  });

  it('describes the host boundary without obsolete absence claims', () => {
    expect(readme).not.toMatch(/RQ-BUS-3A[^\n]*(?:not present|absent|unavailable)/i);
    expect(readme).not.toMatch(/(?:transport|inbox|envelope)[^\n]*(?:not yet|unmerged|not present|absent)/i);
    expect(readme).toMatch(/Grok is\s+unavailable for this deployment/i);
    expect(readme).toMatch(/no built-in authentication/i);
    expect(readme).toMatch(/verified\s+identities and admission checks/i);
    expect(readme).toMatch(/not a delivery daemon/i);
    expect(readme).toMatch(/accounting\s+is awaited before outbox send/i);
    expect(readme).toMatch(/durable acknowledgement/i);
    expect(readme).toMatch(/nextCursor.*expired/i);
  });
});
