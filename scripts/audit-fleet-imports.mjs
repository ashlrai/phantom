/** Read-only fleet import inventory. Zero production importers is evidence, not deletion authority. */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/** Accept an in-memory tracked-file snapshot so the resolver can be tested without git or I/O. */
export function auditFleetImports(files) {
  const incoming = new Map();
  const unresolved = [];
  const code = /\.[cm]?[jt]sx?$/;
  for (const [file, text] of Object.entries(files)) {
    if (!code.test(file)) continue;
    const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    function visit(node) {
      let specifier;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier;
      if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) specifier = node.argument.literal;
      if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) specifier = node.moduleReference.expression;
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
        specifier = node.arguments[0];
        if (!specifier || !ts.isStringLiteralLike(specifier)) unresolved.push(file);
      }
      if (specifier && ts.isStringLiteralLike(specifier) && specifier.text.startsWith('.')) {
        const base = posix.normalize(posix.join(posix.dirname(file), specifier.text));
        const stem = base.replace(/\.(?:[cm]?js|jsx)$/, '');
        const target = [base, ...['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '/index.ts', '/index.js'].map(ext => stem + ext)]
          .find(candidate => Object.hasOwn(files, candidate));
        if (target) {
          if (!incoming.has(target)) incoming.set(target, new Set());
          incoming.get(target).add(file);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(tree);
  }
  const candidates = Object.keys(files).filter(file => file.startsWith('src/core/fleet/') && file.endsWith('.ts'))
    .filter(file => ![...(incoming.get(file) ?? [])].some(importer => importer.startsWith('src/')))
    .sort().map(file => {
      const basename = posix.basename(file, '.ts');
      const importers = [...(incoming.get(file) ?? [])].sort();
      // Include prose and source-reading tests, not just syntactic imports. Keep false positives for review.
      const references = Object.entries(files).filter(([other, text]) => other !== file && text.includes(basename)).map(([other]) => other).sort();
      return { file, productionImporters: [], importers, references };
    });
  return { candidates, unresolvedDynamicImports: [...new Set(unresolved)].sort() };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const paths = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const files = Object.fromEntries(paths.filter(file => /\.(?:[cm]?[jt]sx?|md|mjs)$/.test(file))
    .map(file => [file, readFileSync(file, 'utf8')]));
  console.log(JSON.stringify(auditFleetImports(files), null, 2));
}
