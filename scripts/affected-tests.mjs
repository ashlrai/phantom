#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const slash = (path) => path.split(sep).join('/');
const isTest = (path) => /(?:^test\/.*\.test\.ts|^src\/web-ui\/.*\.test\.[jt]sx?)$/.test(path);

// Unknown changes and changes with no provable test coverage require the full suite.
export function selectTests({ directory, files, changed, map }) {
  if (!changed.length) return [];
  const allFiles = new Set(files);
  const reverse = new Map();
  const options = { allowJs: true, moduleResolution: ts.ModuleResolutionKind.Bundler, jsx: ts.JsxEmit.Preserve };
  const host = ts.sys;
  for (const file of files) {
    if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
    const absolute = resolve(directory, file);
    if (!existsSync(absolute)) continue;
    const source = ts.createSourceFile(file, readFileSync(absolute, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      let specifier;
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) specifier = node.moduleSpecifier.text;
      if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference) && node.moduleReference.expression && ts.isStringLiteral(node.moduleReference.expression)) specifier = node.moduleReference.expression.text;
      if (specifier?.startsWith('.')) {
        const resolved = ts.resolveModuleName(specifier, absolute, options, host).resolvedModule?.resolvedFileName;
        if (resolved) {
          const target = slash(relative(directory, resolved));
          if (allFiles.has(target)) {
            if (!reverse.has(target)) reverse.set(target, new Set());
            reverse.get(target).add(file);
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
  }
  const selected = new Set();
  for (const path of changed) {
    if (!allFiles.has(path) || (!path.startsWith('src/') && !isTest(path)) || /(?:^|\/)(?:setup|helpers?|fixtures?|config)(?:\/|\.)/i.test(path) || /(?:^|\/)[^/]*(?:config|helper|fixture)\.[^/]+$/i.test(path)) return 'ALL';
    const found = new Set(map[path] ?? []);
    const pending = [path];
    const seen = new Set();
    while (pending.length) {
      const current = pending.pop();
      if (seen.has(current)) continue;
      seen.add(current);
      if (isTest(current)) found.add(current);
      for (const dependent of reverse.get(current) ?? []) pending.push(dependent);
    }
    if (!found.size || [...found].some((test) => !allFiles.has(test) || !isTest(test))) return 'ALL';
    for (const test of found) selected.add(test);
  }
  return [...selected].sort();
}

export function affected(base = 'origin/master') {
  try {
    const files = execFileSync('git', ['ls-files', '-z'], { cwd: root }).toString().split('\0').filter(Boolean);
    const changed = execFileSync('git', ['diff', '--name-only', '-z', '--no-renames', `${base}...HEAD`], { cwd: root }).toString().split('\0').filter(Boolean);
    const map = JSON.parse(readFileSync(resolve(root, 'ci/affected-map.json'), 'utf8'));
    return selectTests({ directory: root, files, changed, map });
  } catch (error) {
    console.error(`Affected test selection failed: ${error.message}; running all tests.`);
    return 'ALL';
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--base')) {
    console.error('Usage: node scripts/affected-tests.mjs [--base REF]');
    process.exitCode = 2;
  } else {
    const result = affected(args[1]);
    console.log(result === 'ALL' ? result : result.join('\n'));
  }
}
