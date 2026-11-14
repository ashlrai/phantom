// Runtime edge semantics copied verbatim from authority-tier1-closure-310b.test.ts.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { isTier1ClosureRoot } from '../src/core/authority/protected-paths.js';
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
function listSource(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSource(full));
    else if (/\.(ts|tsx|mts)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) out.push(full);
  }
  return out;
}

export function runtimeSpecifiers(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
  const out: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const clause = node.importClause;
      let runtime = true;
      if (clause?.isTypeOnly) runtime = false;
      else if (clause && !clause.name && clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        const elements = clause.namedBindings.elements;
        if (elements.length > 0 && elements.every((element) => element.isTypeOnly)) runtime = false;
      }
      if (runtime) out.push(node.moduleSpecifier.text);
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
      const elements = node.exportClause && ts.isNamedExports(node.exportClause) ? node.exportClause.elements : null;
      if (!node.isTypeOnly && !(elements && elements.length > 0 && elements.every((element) => element.isTypeOnly))) {
        out.push(node.moduleSpecifier.text);
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
      const first = node.arguments[0];
      if (first && ts.isStringLiteralLike(first)) out.push(first.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

function resolveLocal(from: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  const base = resolve(dirname(from), specifier);
  const candidates = [
    base.replace(/\.js$/, '.ts'),
    base.replace(/\.js$/, '.tsx'),
    base.replace(/\.mjs$/, '.mts'),
    `${base}.ts`,
    join(base, 'index.ts'),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

export function computeClosure(): { roots: string[]; closure: string[] } {
  const roots = listSource(join(ROOT, 'src'))
    .map((file) => relative(ROOT, file).split('\\').join('/'))
    .filter((path) => isTier1ClosureRoot(path))
    .sort();
  const seen = new Set<string>();
  const stack = roots.map((path) => join(ROOT, path));
  while (stack.length > 0) {
    const file = stack.pop()!;
    const rel = relative(ROOT, file).split('\\').join('/');
    if (seen.has(rel)) continue;
    seen.add(rel);
    for (const specifier of runtimeSpecifiers(file)) {
      const target = resolveLocal(file, specifier);
      if (target) stack.push(target);
    }
  }
  return { roots, closure: [...seen].sort() };
}


export function shortestTier1Chain(target: string): string[] | null {
  const wanted = relative(ROOT, resolve(ROOT, target)).split('\\').join('/');
  const roots = listSource(join(ROOT, 'src')).map(file => relative(ROOT, file).split('\\').join('/')).filter(isTier1ClosureRoot).sort();
  const queue = roots.map(root => [root]);
  const seen = new Set(roots);
  for (let i = 0; i < queue.length; i++) {
    const chain = queue[i]!;
    const file = chain[chain.length - 1]!;
    if (file === wanted) return chain;
    for (const specifier of runtimeSpecifiers(join(ROOT, file))) {
      const resolved = resolveLocal(join(ROOT, file), specifier);
      if (!resolved) continue;
      const next = relative(ROOT, resolved).split('\\').join('/');
      if (!seen.has(next)) { seen.add(next); queue.push([...chain, next]); }
    }
  }
  return null;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const files = args.filter(arg => arg !== '--json');
  if (files.length !== 1 || args.some(arg => arg.startsWith('--') && arg !== '--json')) {
    console.error('Usage: npx tsx scripts/tier1-why.ts <file> [--json]');
    process.exitCode = 2;
  } else {
    const file = files[0]!;
    const chain = shortestTier1Chain(file);
    console.log(args.includes('--json') ? JSON.stringify({ file, reachable: chain !== null, chain }) : chain ? chain.join(' -> ') : `${file}: unreachable from Tier-1 roots`);
  }
}
