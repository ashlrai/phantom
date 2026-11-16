#!/usr/bin/env node
/* global process, console */
// Hashes the inputs of the fast jobs. The hash is a git tree listing, so it
// does not need every blob materialized in a sparse checkout.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { hashParts } from './ci-green-reuse.mjs';
import { changedPaths } from './ci-fast-select.mjs';
import { SCHEMA, affectedProjects, lintFiles } from './ci-dep-graph.mjs';

const CODE = /\.(?:[cm]?[jt]sx?)$/;

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function output(name, value) {
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${name}=${value}\n`);
  console.log(`${name}=${value}`);
}

function records(cwd, prefix) {
  const out = git(cwd, ['ls-tree', '-r', '-z', 'HEAD', '--', prefix]);
  const list = [];
  for (const record of out.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    if (tab === -1) continue;
    const path = record.slice(tab + 1);
    const oid = record.slice(record.lastIndexOf(' ', tab) + 1, tab);
    list.push(`${oid} ${path}`);
  }
  return list.sort();
}

function blob(cwd, path) {
  return git(cwd, ['rev-parse', `HEAD:${path}`]).trim();
}

function loadGraph(path) {
  if (!path) return null;
  try {
    const graph = JSON.parse(readFileSync(path, 'utf8'));
    return graph?.schema === SCHEMA ? graph : null;
  } catch {
    return null;
  }
}

function pathOf(line) {
  return line.slice(line.indexOf(' ') + 1);
}

function webClosure(graph, webLines, backendLines) {
  const backendFiles = backendLines.map(pathOf).filter((path) => CODE.test(path));
  if (!graph?.files || backendFiles.some((path) => !graph.files[path])) return null;
  const seen = new Set(webLines.map(pathOf));
  const stack = [...seen].filter((path) => graph.files[path]);
  while (stack.length) {
    const current = stack.pop();
    for (const imported of graph.files[current]?.imports ?? []) {
      if (seen.has(imported)) continue;
      seen.add(imported);
      if (graph.files[imported]) stack.push(imported);
    }
  }
  return seen;
}

export function typecheckHashes(cwd, graph) {
  const src = records(cwd, 'src');
  const backend = src.filter((line) => {
    const path = pathOf(line);
    return path.startsWith('src/') && !path.startsWith('src/web-ui/') && !path.startsWith('src/raycast/');
  });
  const web = src.filter((line) => pathOf(line).startsWith('src/web-ui/'));
  const lock = blob(cwd, 'package-lock.json');
  const pkg = blob(cwd, 'package.json');
  const rootConfig = blob(cwd, 'tsconfig.json');
  const webConfig = blob(cwd, 'src/web-ui/tsconfig.json');
  const closure = webClosure(graph, web, backend);
  const webLines = closure
    ? src.filter((line) => closure.has(pathOf(line)) || !CODE.test(pathOf(line)))
    : src;
  return {
    backend: hashParts(['backend', ...backend, lock, pkg, rootConfig]),
    web: hashParts(['web', ...webLines, lock, pkg, webConfig]),
  };
}

export function testsHash(cwd, planBytes) {
  return hashParts(['fast-tests', planBytes, ...records(cwd, 'src'), ...records(cwd, 'test')]);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const command = process.argv[2];
  const cwd = process.cwd();
  try {
    if (command === 'plan' || command === 'changed') {
      const paths = changedPaths({
        base: process.env.ASHLR_CI_BASE_SHA,
        head: process.env.ASHLR_CI_HEAD_SHA,
        cwd,
      });
      output('count', String(paths.length));
      const graph = loadGraph(process.env.CI_DEP_GRAPH);
      output('projects', affectedProjects(paths, graph));
      const lint = lintFiles(paths, graph);
      output('lint_count', String(lint.length));
      if (process.env.CI_CHANGED_LIST) writeFileSync(process.env.CI_CHANGED_LIST, `${paths.join('\n')}\n`);
      if (process.env.CI_LINT_LIST) writeFileSync(process.env.CI_LINT_LIST, lint.length ? `${lint.join('\n')}\n` : '');
      const hashes = typecheckHashes(cwd, graph);
      output('backend', hashes.backend);
      output('web', hashes.web);
    } else if (command === 'typecheck') {
      const hashes = typecheckHashes(cwd, loadGraph(process.env.CI_DEP_GRAPH));
      output('backend', hashes.backend);
      output('web', hashes.web);
    } else if (command === 'tests') {
      const planPath = process.argv[3];
      if (!planPath) throw new Error('tests needs the plan file');
      output('hash', testsHash(cwd, readFileSync(planPath)));
    } else if (command === 'paths') {
      const prefix = process.argv[3];
      if (!prefix) throw new Error('paths needs a tree prefix');
      output('hash', hashParts(records(cwd, prefix)));
    } else {
      throw new Error('usage: ci-fast-inputs.mjs plan|changed|typecheck|tests <plan>|paths <prefix>');
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
