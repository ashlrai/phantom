import { readFileSync, readdirSync } from 'node:fs';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import * as contracts from '../src/core/types.js';

const root = new URL('../src/core/', import.meta.url);
const read = (path: string): string => readFileSync(new URL(path, root), 'utf8');
const parse = (path: string): ts.SourceFile =>
  ts.createSourceFile(path, read(path), ts.ScriptTarget.ES2022, true);
const domains = readdirSync(new URL('types/', root)).filter((name) => name.endsWith('.ts')).sort();

describe('shared contract domain boundaries', () => {
  it('re-exports every domain exactly once using erased type-only exports', () => {
    const barrel = parse('types.ts');
    const exports = barrel.statements.filter(ts.isExportDeclaration);
    expect(exports.map((node) => {
      expect(node.isTypeOnly).toBe(true);
      expect(node.exportClause).toBeUndefined();
      expect(node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)).toBe(true);
      return (node.moduleSpecifier as ts.StringLiteral).text;
    }).sort()).toEqual(domains.map((name) => `./types/${name.replace(/\.ts$/, '.js')}`));
    expect(barrel.statements.every((node) =>
      ts.isExportDeclaration(node) || ts.isVariableStatement(node))).toBe(true);
  });

  it('owns each type in one domain and introduces no runtime statements or barrel cycles', () => {
    const names = new Set<string>();
    for (const domain of domains) {
      const source = parse(`types/${domain}`);
      for (const node of source.statements) {
        if (ts.isImportDeclaration(node)) {
          expect(node.importClause?.isTypeOnly, domain).toBe(true);
          expect((node.moduleSpecifier as ts.StringLiteral).text, domain).not.toBe('../types.js');
          continue;
        }
        expect(ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node), domain).toBe(true);
        if (!ts.isInterfaceDeclaration(node) && !ts.isTypeAliasDeclaration(node)) continue;
        // This base interface was private in the original shared contract.
        const exported = node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false;
        expect(exported, node.name.text).toBe(node.name.text !== 'AgentSemanticEventBaseV1');
        expect(names.has(node.name.text), `duplicate contract: ${node.name.text}`).toBe(false);
        names.add(node.name.text);
      }
      // Type-only domains must stay safe for browser consumers and authority imports.
      expect(ts.transpileModule(source.text, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, removeComments: true },
      }).outputText.trim(), domain).toBe('export {};');
    }
    for (const name of ['AshlrConfig', 'Proposal', 'WorkSource', 'RunState', 'EngineSpec', 'Goal', 'DaemonState']) {
      expect(names.has(name), name).toBe(true);
    }
  });

  it('preserves the complete runtime namespace and the diagnostic drain default', () => {
    expect({ ...contracts }).toEqual({ DEFAULT_DIAGNOSTIC_RESLICE_DRAIN_LIMIT: 3 });
    expect(ts.transpileModule(read('types.ts'), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022, removeComments: true },
    }).outputText.trim()).toBe('export const DEFAULT_DIAGNOSTIC_RESLICE_DRAIN_LIMIT = 3;');
  });

  it('keeps the relocated safety documentation attached to the actual fields', () => {
    const config = read('types/config.ts');
    const proposals = read('types/proposals.ts');
    expect(config).toMatch(/protected PR handoff; never merges the hosted PR[^\n]*\n\s*pushToRemote\?: boolean/);
    expect(config).toMatch(/M183: frontier TASTE critic for best-of-N SELECTION\.[\s\S]{0,600}Does NOT add any merge gate[\s\S]{0,200}safety floor[\s\S]{0,150}tasteCritic\?: boolean/);
    expect(proposals).toMatch(/M183: Frontier TASTE critic scores[\s\S]{0,600}Does NOT affect the safety merge gate\.\s*\*\/\s*taste\?:/);
    for (const domain of domains) expect(read(`types/${domain}`)).not.toContain('hostAutoMerge');
  });
});
