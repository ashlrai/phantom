import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const code = /\.(?:[cm]?[jt]sx?)$/;
const testFile = /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/;

function files(root, dir) {
  const absolute = path.join(root, dir);
  if (!fs.existsSync(absolute)) return [];
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const name = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return files(root, name);
    return entry.isFile() && code.test(name) ? [name] : [];
  }).sort();
}

function imports(file, text) {
  const kind = file.endsWith('.tsx') ? ts.ScriptKind.TSX : file.endsWith('.jsx') ? ts.ScriptKind.JSX : /\.[cm]?ts$/.test(file) ? ts.ScriptKind.TS : ts.ScriptKind.JS;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, kind);
  if (source.parseDiagnostics.length) throw new Error(`Cannot parse ${file}`);
  const found = [];
  const visit = (node) => {
    let spec;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) spec = node.moduleSpecifier;
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) spec = node.moduleReference.expression;
    if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) spec = node.arguments[0];
    if (spec && (ts.isStringLiteral(spec) || ts.isNoSubstitutionTemplateLiteral(spec))) found.push(spec.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

export function audit(root) {
  const all = [...files(root, 'src'), ...files(root, 'test')];
  const available = new Set(all);
  const sources = all.filter((file) => file.startsWith('src/') && !testFile.test(file));
  const tests = all.filter((file) => testFile.test(file));
  const mapping = Object.fromEntries(sources.map((file) => [file, []]));
  const orphanTests = [];
  for (const test of tests) {
    const found = new Set();
    for (const spec of imports(test, fs.readFileSync(path.join(root, test), 'utf8'))) {
      if (!spec.startsWith('.')) continue;
      const raw = path.posix.normalize(path.posix.join(path.posix.dirname(test), spec));
      const base = raw.replace(/\.[cm]?js$/, '');
      const candidates = [raw, ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts', '.cjs', '.cts'].flatMap((ext) => [base + ext, `${raw}/index${ext}`])];
      const target = candidates.find((candidate) => available.has(candidate) && Object.hasOwn(mapping, candidate));
      if (target) found.add(target);
    }
    if (!found.size) orphanTests.push(test);
    for (const source of found) mapping[source].push(test);
  }
  return { unmappedSources: sources.filter((file) => !mapping[file].length), orphanTests };
}

export function compare(current, baseline) {
  const result = {};
  for (const key of ['unmappedSources', 'orphanTests']) {
    if (!Array.isArray(baseline[key]) || baseline[key].some((item) => typeof item !== 'string')) throw new Error(`Invalid baseline: ${key}`);
    const known = new Set(baseline[key]);
    result[key] = current[key].filter((item) => !known.has(item));
  }
  return result;
}

function main() {
  const root = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const current = audit(root);
  const baseline = JSON.parse(fs.readFileSync(path.join(root, 'ci/affected-map.json'), 'utf8'));
  const added = compare(current, baseline);
  for (const key of ['unmappedSources', 'orphanTests']) {
    console.log(`${key} (${current[key].length}, ${added[key].length} new):`);
    for (const item of current[key]) console.log(`  ${added[key].includes(item) ? '+ ' : '  '}${item}`);
  }
  if (added.unmappedSources.length || added.orphanTests.length) process.exitCode = 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
