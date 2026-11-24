#!/usr/bin/env node
// Advisory only: no candidate code is executed and no files are deleted.
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const CODE = /\.(?:[cm]?[jt]sx?)$/;
const TEST = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
const EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const OMIT = new Set(['node_modules', '.git', 'dist', 'target', 'coverage', '.ashlr-gate', '.ashlrcode']);
const sorted = (values) => [...new Set(values)].sort();
const slash = (path) => path.replaceAll('\\', '/');

function inventory(root, directory = root) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (OMIT.has(entry.name) || (entry.name.startsWith('.') && entry.name !== '.github')) return [];
    const path = join(directory, entry.name);
    // Do not follow symlinks outside the requested tree.
    return entry.isDirectory() ? inventory(root, path) : entry.isFile() ? [slash(relative(root, path))] : [];
  }).sort();
}

/** Report source reachability in a checkout (including uncommitted changes).
 * Extra roots deliberately overestimate liveness: exports, scripts, Raycast,
 * HTML modules, declarations and contracts. Tests remain roots, even when a
 * module has no production consumer. A report is evidence for review, not a
 * deletion instruction: computed loaders are listed as unresolved diagnostics.
 */
export function deadCodeReport(root = resolve(dirname(fileURLToPath(import.meta.url)), '..')) {
  root = resolve(root);
  const files = inventory(root);
  const known = new Set(files);
  const modules = files.filter((path) => CODE.test(path) || path.startsWith('bin/'));
  const graph = new Map(modules.map((path) => [path, new Set()]));
  const roots = new Map();
  const diagnostics = [];
  const resolutions = new Map();
  const protect = (path, reason) => {
    if (!graph.has(path)) return;
    if (!roots.has(path)) roots.set(path, new Set());
    roots.get(path).add(reason);
  };
  const resolvePath = (from, specifier) => {
    const key = `${dirname(from)}\0${specifier}`;
    if (resolutions.has(key)) return resolutions.get(key);
    const spec = specifier.replace(/[?#].*$/, '');
    const bases = spec.startsWith('.') ? [join(dirname(from), spec), spec] : [spec.replace(/^\//, '')];
    const candidates = bases.flatMap((base) => {
      const source = slash(base).replace(/^\.\//, '').replace(/^dist\//, 'src/');
      const names = [source];
      if (/\.[cm]?js$/.test(source)) {
        names.push(source.replace(/\.js$/, '.ts'), source.replace(/\.js$/, '.tsx'),
          source.replace(/\.mjs$/, '.mts'), source.replace(/\.cjs$/, '.cts'));
      }
      if (!extname(source)) for (const extension of EXTENSIONS) names.push(source + extension, `${source}/index${extension}`);
      return names.filter((path) => known.has(path) && graph.has(path));
    });
    const result = sorted(candidates);
    resolutions.set(key, result);
    return result;
  };
  const addReference = (from, spec, reason) => {
    const targets = resolvePath(from, spec);
    for (const target of targets) {
      graph.get(from)?.add(target);
      if (reason) protect(target, reason);
    }
    return targets;
  };

  for (const path of modules) {
    if (TEST.test(path) || path.startsWith('test/')) protect(path, 'test');
    else if (path.startsWith('scripts/')) protect(path, 'script');
    else if (path.startsWith('desktop/')) protect(path, 'desktop');
    else if (!path.startsWith('src/') && !path.startsWith('bin/')) protect(path, 'tooling');
    if (/(?:^|\/)[^/]*config\.[cm]?[jt]s$/.test(path)) protect(path, 'configuration');
    if (path.split('/').includes('contracts') || /\.d\.[cm]?ts$/.test(path)) protect(path, 'contract-or-declaration');
    if (path.includes('/public/')) protect(path, 'public-asset');
    const text = readFileSync(join(root, path), 'utf8');
    const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false);
    if (source.parseDiagnostics.length) {
      protect(path, 'unparsed-source');
      diagnostics.push({ path, reason: 'parse-error' });
    }
    const unwrap = (node) => {
      while (node && (ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) ||
        ts.isParenthesizedExpression(node) || ts.isSatisfiesExpression(node) || ts.isNonNullExpression(node))) node = node.expression;
      return node;
    };
    const literal = (node) => {
      node = unwrap(node);
      return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : null;
    };
    const protectTemplate = (argument) => {
      argument = unwrap(argument);
      if (!argument || !ts.isTemplateExpression(argument) || !argument.head.text.startsWith('.')) return;
      const marker = '__DEAD_CODE_TEMPLATE__';
      const template = argument.head.text + argument.templateSpans.map((span) => marker + span.literal.text).join('');
      const pattern = slash(join(dirname(path), template)).replace(/^dist\//, 'src/');
      const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(`^${pattern.split(marker).map(escape).join('[^/]*')}$`);
      for (const target of modules) {
        if (regex.test(target) || regex.test(target.replace(/\.tsx?$/, '.js'))) {
          graph.get(path).add(target);
          protect(target, 'computed-loader-template');
        }
      }
    };
    const visit = (node) => {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) {
        const spec = literal(node.moduleSpecifier);
        if (spec !== null && spec.startsWith('.') && !addReference(path, spec).length &&
            (!extname(spec) || CODE.test(spec))) {
          diagnostics.push({ path, reason: 'unresolved-relative-import', specifier: spec });
        } else if (spec !== null) addReference(path, spec);
      }
      if (ts.isCallExpression(node)) {
        const expression = node.expression;
        const dynamic = expression.kind === ts.SyntaxKind.ImportKeyword;
        const require = ts.isIdentifier(expression) && expression.text === 'require';
        const glob = ts.isPropertyAccessExpression(expression) && expression.name.text === 'glob';
        if (dynamic || require) {
          if (dynamic) protect(path, 'dynamic-import-owner');
          const spec = literal(node.arguments[0]);
          if (spec === null) {
            protectTemplate(node.arguments[0]);
            diagnostics.push({ path, reason: 'computed-loader' });
          }
          else addReference(path, spec, dynamic ? 'dynamic-import' : undefined);
        }
        if (glob) {
          protect(path, 'dynamic-glob-owner');
          // Preserve the entire literal glob directory, including future file
          // extensions. Broad protection is preferable to a false deletion.
          const args = node.arguments[0];
          const patterns = args && ts.isArrayLiteralExpression(args) ? args.elements : [args];
          for (const pattern of patterns) {
            const spec = literal(pattern);
            if (spec === null) { diagnostics.push({ path, reason: 'computed-glob' }); continue; }
            const prefix = slash(join(dirname(path), spec.split(/[*?{[]/, 1)[0]));
            for (const target of modules) if (target.startsWith(prefix)) {
              graph.get(path).add(target);
              protect(target, 'dynamic-glob');
            }
          }
        }
      }
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL') {
        protectTemplate(node.arguments?.[0]);
      }
      // Worker URLs, fs reads, fork paths, import types, require/mock calls and
      // dist paths embedded in launch bootstraps are also dependency evidence.
      const value = literal(node);
      if (value !== null && value.length < 500 && !value.includes('\n') && (value.includes('/') || CODE.test(value))) addReference(path, value);
      ts.forEachChild(node, visit);
    };
    visit(source);
  }

  const strings = (value) => typeof value === 'string' ? [value]
    : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
  for (const path of files.filter((path) => path.endsWith('package.json'))) {
    const manifest = JSON.parse(readFileSync(join(root, path), 'utf8'));
    for (const field of ['bin', 'main', 'module', 'exports']) {
      for (const entry of strings(manifest[field])) {
        for (const target of resolvePath(path, entry.startsWith('.') ? entry : `./${entry}`)) protect(target, `package-${field}`);
      }
    }
    for (const command of manifest.commands ?? []) {
      for (const target of resolvePath(path, `./src/${command.name}`)) protect(target, 'raycast-command');
    }
  }
  for (const path of files.filter((path) => path.endsWith('.html'))) {
    const html = readFileSync(join(root, path), 'utf8');
    for (const match of html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["']/g)) {
      for (const target of resolvePath(path, match[1].startsWith('.') ? match[1] : `./${match[1]}`)) protect(target, 'html-entry');
    }
  }
  // Operator guides can expose standalone source commands outside the CLI
  // dispatcher. Preserve those entries as well as their dependencies.
  for (const path of files.filter((path) => path.endsWith('.md'))) {
    for (const match of readFileSync(join(root, path), 'utf8').matchAll(/\b(?:tsx|node)\s+(src\/[\w./-]+\.[cm]?[jt]sx?)/g)) {
      for (const target of resolvePath('', match[1])) protect(target, 'documented-command');
    }
  }
  // The installed CLI shim computes its import from a file URL; the source
  // entry is also the desktop sidecar and npm's dev entry.
  if (known.has('bin/ashlr')) protect('src/cli/index.ts', 'cli-sidecar');
  const closure = (entries) => {
    const seen = new Set();
    const queue = [...entries];
    for (const path of queue) if (!seen.has(path)) {
      seen.add(path);
      queue.push(...(graph.get(path) ?? []));
    }
    return seen;
  };
  const reachable = closure(roots.keys());
  const preservation = new Set(['test', 'dynamic-import', 'dynamic-import-owner', 'dynamic-glob',
    'dynamic-glob-owner', 'computed-loader-template', 'unparsed-source']);
  const production = closure([...roots].filter(([, reasons]) => [...reasons].some((reason) => !preservation.has(reason))).map(([path]) => path));
  const tested = closure([...roots].filter(([, reasons]) => reasons.has('test')).map(([path]) => path));
  const sources = modules.filter((path) => path.startsWith('src/') && !TEST.test(path));
  return {
    schema: 'phantom-dead-code-report/v1', advisoryOnly: true,
    roots: [...roots].sort(([a], [b]) => a.localeCompare(b)).map(([path, reasons]) => ({ path, reasons: sorted(reasons) })),
    unreachable: sources.filter((path) => !reachable.has(path)),
    testOnly: sources.filter((path) => tested.has(path) && !production.has(path)),
    diagnostics: [...new Map(diagnostics.map((row) => [JSON.stringify(row), row])).values()]
      .sort((a, b) => a.path.localeCompare(b.path) || a.reason.localeCompare(b.reason)),
  };
}

export function reportJson(args = []) {
  if (args.length && (args.length !== 2 || args[0] !== '--root')) throw new Error('Usage: node scripts/dead-code-report.mjs [--root DIRECTORY]');
  return JSON.stringify(deadCodeReport(args[1]), null, 2);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    console.log(reportJson(process.argv.slice(2)));
  } catch (error) {
    console.error(`Dead-code report failed: ${error.message}`);
    process.exitCode = 1;
  }
}
