import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readEnvironmentCredential } from '../src/core/integrations/secrets.js';

const sourceRoot = fileURLToPath(new URL('../src', import.meta.url));
const credentialModule = 'core/integrations/secrets.ts';
const credentialName = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|API_KEY|ACCESS_KEY|PRIVATE_KEY|PAT)(?:_|$)/;

function hasCredentialCandidate(source: string): boolean {
  // Filter complete environment accesses before building an AST. Parsing every
  // large module which merely mentions TOKEN elsewhere makes this lint costly.
  const constants = new Set<string>();
  for (const match of source.matchAll(/\b(?:const|let|var)\s+([\w$]+)\s*=\s*(['"`])([^'"`\r\n]+)\2/g)) {
    if (credentialName.test(match[3]!)) constants.add(match[1]!);
  }
  const env = String.raw`\bprocess\s*(?:\.\s*env|\[\s*['"]env['"]\s*\])`;
  const access = new RegExp(`${env}\\s*(?:(?:\\?\\.|\\.)\\s*([\\w$]+)|(?:\\?\\.)?\\s*\\[\\s*['"\x60]?([\\w$]+)['"\x60]?\\s*\\])`, 'g');
  for (const match of source.matchAll(access)) {
    const key = match[1] ?? match[2]!;
    if (credentialName.test(key) || constants.has(key)) return true;
  }
  // Destructuring has the credential name before process.env.
  const binding = new RegExp(`\\{([^{}]*)\\}\\s*=\\s*${env}`, 'g');
  for (const match of source.matchAll(binding)) {
    if ((match[1]!.match(/[\w$]+/g) ?? []).some(name => credentialName.test(name))) return true;
  }
  return false;
}

function memberName(node: ts.Node): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (ts.isElementAccessExpression(node) && node.argumentExpression && ts.isStringLiteralLike(node.argumentExpression)) {
    return node.argumentExpression.text;
  }
  return undefined;
}

function isProcessEnvironment(node: ts.Node): boolean {
  return (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
    memberName(node) === 'env' && ts.isIdentifier(node.expression) && node.expression.text === 'process';
}

/** Grep statically named credential reads, using syntax to ignore comments and fixture strings. */
function credentialReads(source: string, sourceName = 'source.ts'): number[] {
  if (!source.includes('process') || !hasCredentialCandidate(source)) return [];
  const file = ts.createSourceFile(sourceName, source, ts.ScriptTarget.Latest, true);
  const constants = new Map<string, string>();
  function collect(node: ts.Node): void {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isStringLiteralLike(node.initializer)) {
      constants.set(node.name.text, node.initializer.text);
    }
    ts.forEachChild(node, collect);
  }
  collect(file);
  const lines: number[] = [];
  function note(node: ts.Node, name: string | undefined): void {
    if (name && credentialName.test(name)) lines.push(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);
  }
  function inspect(node: ts.Node): void {
    if ((ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) && isProcessEnvironment(node.expression)) {
      const parent = node.parent;
      // Clearing/setting credentials is not reading them; compound assignments still count.
      const writeOnly = ts.isDeleteExpression(parent) ||
        (ts.isBinaryExpression(parent) && parent.left === node && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken);
      if (!writeOnly) {
        const key = ts.isElementAccessExpression(node) ? node.argumentExpression : undefined;
        const name = memberName(node) ?? (key && ts.isIdentifier(key) ? constants.get(key.text) ?? key.text : undefined);
        note(node, name);
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer && isProcessEnvironment(node.initializer)) {
      for (const element of node.name.elements) {
        const key = element.propertyName ?? element.name;
        note(element, ts.isIdentifier(key) || ts.isStringLiteralLike(key) ? key.text : undefined);
      }
    }
    ts.forEachChild(node, inspect);
  }
  inspect(file);
  return lines;
}

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sourceFiles(path) : /\.[cm]?[jt]sx?$/.test(entry.name) ? [path] : [];
  });
}

afterEach(() => vi.unstubAllEnvs());

describe('credential environment boundary', () => {
  it('keeps statically named token/key reads in the allowlisted Secrets module', () => {
    const violations = sourceFiles(sourceRoot).flatMap(path => {
      const name = relative(sourceRoot, path).replaceAll('\\', '/');
      if (name === credentialModule) return [];
      const source = readFileSync(path, 'utf8');
      return credentialReads(source, name).map(line => `${name}:${line}`);
    });
    expect(violations, `Use ${credentialModule} for credential reads`).toEqual([]);
  });

  it.each([
    'const token = process.env.GH_TOKEN;',
    'const token = process.env["GITHUB_TOKEN"];',
    'const key = process["env"]["OPENAI_API_KEY"];',
    'const token = process.env?.GH_TOKEN;',
    'const { GH_TOKEN: token } = process.env;',
    'const { "TELEGRAM_BOT_TOKEN": token } = process["env"];',
    'const keyName = "GH_TOKEN"; const token = process.env[keyName];',
    'const token = process.env[PULSE_FLEET_PAT_ENV];',
    'process.env.GH_TOKEN ||= "fallback";',
  ])('recognizes a credential read: %s', source => {
    expect(credentialReads(source)).toEqual([1]);
  });

  it('ignores comments, fixture strings, ordinary configuration, assignment and deletion', () => {
    expect(credentialReads(`
      // process.env.GH_TOKEN
      const fixture = 'process.env.GH_TOKEN';
      const path = process.env.PATH;
      const budget = process.env.ASHLR_MAX_TOKENS;
      process.env.GH_TOKEN = 'synthetic';
      delete process.env.GH_TOKEN;
    `)).toEqual([]);
  });

  it.each([undefined, '', '  ', 'synthetic-token', 'phm_synthetic_reference'])('preserves existing caller validation semantics for %s', value => {
    vi.stubEnv('ASHLR_CREDENTIAL_BOUNDARY_TEST_TOKEN', value);
    expect(readEnvironmentCredential('ASHLR_CREDENTIAL_BOUNDARY_TEST_TOKEN')).toBe(value);
  });

  it('reads on demand without caching or modifying credentials', () => {
    vi.stubEnv('ASHLR_CREDENTIAL_BOUNDARY_TEST_TOKEN', 'synthetic-first');
    expect(readEnvironmentCredential('ASHLR_CREDENTIAL_BOUNDARY_TEST_TOKEN')).toBe('synthetic-first');
    vi.stubEnv('ASHLR_CREDENTIAL_BOUNDARY_TEST_TOKEN', 'synthetic-second');
    expect(readEnvironmentCredential('ASHLR_CREDENTIAL_BOUNDARY_TEST_TOKEN')).toBe('synthetic-second');
    expect(process.env.ASHLR_CREDENTIAL_BOUNDARY_TEST_TOKEN).toBe('synthetic-second');
  });
});
