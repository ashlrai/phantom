#!/usr/bin/env node
/* global process, console */
// Incremental import graph for affected typecheck, lint, and test selection.
// An unknown module change fails closed to the full typecheck program.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SCHEMA = 'phantom-dep-graph.v1';
// Bumped when specifier resolution changes. Older graphs are rebuilt, not reused.
export const RESOLVER = 2;
const CODE = /\.(?:[cm]?[jt]sx?)$/;
const SPEC = /(?:^|[\s;])(?:import|export)\s+(?:type\s+)?(?:[^'";]*?\sfrom\s*)?['"](\.[^'"]+)['"]|import\(\s*['"](\.[^'"]+)['"]\s*\)|require\(\s*['"](\.[^'"]+)['"]\s*\)/g;

export function parseImports(text) {
  const found = [];
  SPEC.lastIndex = 0;
  let match;
  const source = String(text);
  while ((match = SPEC.exec(source)) !== null) {
    const spec = match[1] ?? match[2] ?? match[3];
    if (spec) found.push(spec);
  }
  return found;
}

export function resolveSpecifier(fromFile, spec, files) {
  const dir = fromFile.includes('/') ? fromFile.slice(0, fromFile.lastIndexOf('/')) : '';
  const joined = `${dir}/${spec}`.replace(/^\//, '');
  const raw = joined.split('/').reduce((acc, part) => {
    if (part === '' || part === '.') return acc;
    if (part === '..') {
      const slash = acc.lastIndexOf('/');
      return slash === -1 ? '' : acc.slice(0, slash);
    }
    return acc ? `${acc}/${part}` : part;
  }, '');
  const base = raw.replace(/\.(?:[cm]?js|[cm]?ts|tsx|jsx)$/, '');
  const exts = ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs', '.jsx'];
  const candidates = [raw];
  for (const ext of exts) {
    candidates.push(base + ext, `${raw}/index${ext}`, `${base}/index${ext}`);
  }
  return candidates.find((candidate) => files.has(candidate)) ?? null;
}

function emptyGraph() {
  return { schema: SCHEMA, files: {} };
}

const COMMIT = /^[0-9a-f]{40}$/;

function commitOf(value) {
  return typeof value === 'string' && COMMIT.test(value) ? value : '';
}

/** Exact HEAD pin with a non-empty file map from the current resolver. */
export function graphCoversCommit(graph, head) {
  return graph?.commit === head && COMMIT.test(head) && graph.resolver === RESOLVER
    && graph.files && Object.keys(graph.files).length > 0;
}

export function normalizeGraph(value) {
  if (!value || value.schema !== SCHEMA || !value.files || typeof value.files !== 'object' || Array.isArray(value.files)) return emptyGraph();
  const files = {};
  for (const [path, node] of Object.entries(value.files)) {
    if (!node || typeof node.hash !== 'string' || !Array.isArray(node.imports)) continue;
    const unresolved = Array.isArray(node.unresolved) ? node.unresolved.filter((item) => typeof item === 'string') : [];
    files[path] = {
      hash: node.hash,
      imports: node.imports.filter((item) => typeof item === 'string'),
      ...(unresolved.length ? { unresolved } : {}),
      ...(node.dynamic === true ? { dynamic: true } : {}),
    };
  }
  const commit = commitOf(value.commit);
  const resolver = value.resolver === RESOLVER ? RESOLVER : 0;
  return {
    schema: SCHEMA,
    files,
    ...(commit ? { commit } : {}),
    ...(resolver ? { resolver } : {}),
    ...(Object.values(files).some((node) => node.unresolved?.length) ? { unknown: true } : {}),
  };
}

const ASSET = /\.(?:css|scss|sass|less|svg|png|gif|webp|jpe?g|woff2?|mp3|mp4)$/i;

function importEdges(text, from, files) {
  const imports = [];
  const unresolved = [];
  for (const spec of parseImports(text)) {
    if (!spec.startsWith('.')) continue;
    const bare = spec.split('?')[0].split('#')[0];
    if (ASSET.test(bare)) continue;
    const target = resolveSpecifier(from, bare, files);
    if (target && target !== from) imports.push(target);
    else if (!target) unresolved.push(spec);
  }
  // A non-literal import() (template or expression) has no static target.
  // String-literal import() is already in SPEC. Kept off `unresolved` so one
  // dynamic file does not mark the whole graph unknown for typecheck.
  const dynamic = /import\s*\(\s*(?!['"])/.test(text);
  for (const match of text.matchAll(/\/\/\/\s*<reference\s+path="(\.[^"]+)"/g)) {
    if (!resolveSpecifier(from, match[1], files)) unresolved.push(match[1]);
  }
  return { imports, unresolved, dynamic };
}

/**
 * Rebuild edges for files whose blob hash changed. `listing` is the full
 * current file set. A changed file without text throws (fail closed).
 */
export function updateGraph(previous, listing) {
  const prior = normalizeGraph(previous);
  const available = new Set(listing.map((entry) => entry.path));
  const files = {};
  let reparsed = 0;
  for (const entry of listing) {
    const old = prior.files[entry.path];
    if (old && old.hash === entry.hash) {
      files[entry.path] = {
        hash: entry.hash,
        imports: old.imports.filter((item) => available.has(item)),
        ...(old.unresolved?.length ? { unresolved: old.unresolved } : {}),
        ...(old.dynamic === true ? { dynamic: true } : {}),
      };
      continue;
    }
    if (typeof entry.text !== 'string') throw new Error(`missing text for changed graph file ${entry.path}`);
    reparsed += 1;
    const edges = importEdges(entry.text, entry.path, available);
    files[entry.path] = {
      hash: entry.hash,
      imports: edges.imports,
      ...(entry.path.startsWith('src/') && edges.unresolved.length ? { unresolved: edges.unresolved } : {}),
      ...(entry.path.startsWith('src/') && edges.dynamic ? { dynamic: true } : {}),
    };
  }
  const unknown = Object.values(files).some((node) => node.unresolved?.length);
  return { graph: { schema: SCHEMA, files, ...(unknown ? { unknown: true } : {}) }, reparsed };
}

const TYPE_CONFIG = new Set(['package.json', 'package-lock.json', 'tsconfig.json']);

function codeLike(path) {
  return CODE.test(path) || /\.(?:json|css)$/.test(path);
}

/** @returns {'web' | 'backend' | 'both' | 'none'} */
export function affectedProjects(changed, graph) {
  if (!Array.isArray(changed)) return 'both';
  if (changed.length === 0) return 'none';
  if (changed.some((path) => TYPE_CONFIG.has(path))) return 'both';
  const known = graph?.schema === SCHEMA ? graph : null;
  if (!known) return changed.some((path) => path.startsWith('src/') || path.startsWith('package') || path.endsWith('tsconfig.json')) ? 'both' : 'none';
  if (known.unknown) return 'both';
  let web = changed.some((path) => path === 'src/web-ui/tsconfig.json');
  let backend = false;
  const reverse = new Map();
  for (const [file, node] of Object.entries(known.files)) {
    for (const imported of node.imports) {
      const list = reverse.get(imported);
      if (list) list.push(file);
      else reverse.set(imported, [file]);
    }
  }
  const reachesWeb = (start) => {
    const seen = new Set();
    const stack = [start];
    while (stack.length) {
      const current = stack.pop();
      if (seen.has(current)) continue;
      seen.add(current);
      if (current.startsWith('src/web-ui/')) return true;
      for (const next of reverse.get(current) ?? []) stack.push(next);
    }
    return false;
  };
  for (const path of changed) {
    if (path.startsWith('src/web-ui/')) {
      if (codeLike(path) || path.endsWith('tsconfig.json')) web = true;
      continue;
    }
    if (path.startsWith('src/raycast/')) continue;
    if (path.startsWith('src/') && codeLike(path)) {
      if (!known.files[path] && CODE.test(path)) return 'both';
      backend = true;
      if (reachesWeb(path)) web = true;
      continue;
    }
    if (path.startsWith('docs/') || path.startsWith('.github/') || path.startsWith('scripts/') || path.startsWith('test/') || /\.(?:md|mdx|txt|svg|png|gif|webp|yml|yaml)$/.test(path)) continue;
    return 'both';
  }
  if (web && backend) return 'both';
  if (web) return 'web';
  if (backend) return 'backend';
  return 'none';
}

const LINTABLE = /\.(?:[cm]?[jt]sx?)$/;

/** Changed lintable files plus their direct importers. */
export function lintFiles(changed, graph) {
  const files = new Set(changed.filter((path) => LINTABLE.test(path)));
  if (graph?.schema === SCHEMA) {
    for (const [file, node] of Object.entries(graph.files)) {
      if (!LINTABLE.test(file)) continue;
      if (node.imports.some((imported) => files.has(imported) || changed.includes(imported))) files.add(file);
    }
  }
  return [...files].sort();
}

function git(cwd, args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function listing(cwd) {
  const out = git(cwd, ['ls-tree', '-r', '-z', 'HEAD', '--', 'src', 'test', 'scripts']);
  const entries = [];
  for (const record of out.split('\0')) {
    if (!record) continue;
    const tab = record.indexOf('\t');
    if (tab === -1) continue;
    const path = record.slice(tab + 1);
    if (!CODE.test(path)) continue;
    const hash = record.slice(record.lastIndexOf(' ', tab) + 1, tab);
    entries.push({ path, hash });
  }
  return entries;
}

function ensureLocalBlobs(cwd, count) {
  // A partial clone fetches each missing blob on its own. A cold graph reads
  // every source file, so expand the checkout once and then read locally.
  if (count < 32) return;
  try {
    const sparse = execFileSync('git', ['config', '--bool', '--get', 'core.sparseCheckout'], { cwd, encoding: 'utf8' }).trim();
    if (sparse === 'true') execFileSync('git', ['sparse-checkout', 'disable'], { cwd, stdio: 'ignore' });
  } catch {
    // A full checkout has nothing to expand.
  }
}

function blobTexts(cwd, hashes) {
  if (hashes.length === 0) return new Map();
  const out = execFileSync('git', ['cat-file', '--batch'], {
    cwd, input: `${hashes.join('\n')}\n`, maxBuffer: 512 * 1024 * 1024,
  });
  const texts = new Map();
  let offset = 0;
  for (const hash of hashes) {
    const headerEnd = out.indexOf(0x0a, offset);
    const header = out.slice(offset, headerEnd).toString('utf8');
    const match = /^[0-9a-f]{40} blob (\d+)$/.exec(header);
    if (!match) throw new Error(`unexpected git object header: ${header}`);
    const size = Number(match[1]);
    const start = headerEnd + 1;
    texts.set(hash, out.slice(start, start + size).toString('utf8'));
    offset = start + size + 1;
  }
  return texts;
}

function headSha(cwd) {
  return git(cwd, ['rev-parse', 'HEAD']).trim();
}

function isAncestor(cwd, ancestor, descendant) {
  if (!/^[0-9a-f]{40}$/.test(ancestor) || !/^[0-9a-f]{40}$/.test(descendant)) return false;
  try {
    execFileSync('git', ['merge-base', '--is-ancestor', ancestor, descendant], { cwd, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function updateFromGit(cwd, outPath) {
  let previous = emptyGraph();
  try { previous = normalizeGraph(JSON.parse(readFileSync(outPath, 'utf8'))); } catch { /* first build */ }
  const head = headSha(cwd);
  // An exact pin for this checkout skips the reparse. A master-published
  // graph (ancestor of HEAD, current resolver) is updated incrementally.
  // Anything else is rebuilt so a foreign cache cannot keep stale edges.
  if (graphCoversCommit(previous, head)) {
    console.log(`dependency graph: reused ${Object.keys(previous.files).length} files at ${head}`);
    return previous;
  }
  const priorCommit = previous.commit ?? '';
  const sameHistory = priorCommit === head || isAncestor(cwd, priorCommit, head);
  if (previous.resolver !== RESOLVER || !sameHistory) previous = emptyGraph();
  const entries = listing(cwd);
  const prior = previous.files;
  const missing = entries.filter((entry) => prior[entry.path]?.hash !== entry.hash);
  ensureLocalBlobs(cwd, missing.length);
  const texts = blobTexts(cwd, missing.map((entry) => entry.hash));
  for (const entry of missing) entry.text = texts.get(entry.hash) ?? '';
  const { graph, reparsed } = updateGraph(previous, entries);
  const stamped = { ...graph, commit: head, resolver: RESOLVER };
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, JSON.stringify(stamped));
  console.log(`dependency graph: ${Object.keys(graph.files).length} files, ${reparsed} reparsed`);
  return stamped;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const command = process.argv[2];
  const cwd = process.cwd();
  const outFlag = process.argv.indexOf('--out');
  const outPath = outFlag === -1 ? '' : process.argv[outFlag + 1];
  try {
    if (command === 'update') {
      if (!outPath) throw new Error('update needs --out');
      updateFromGit(cwd, outPath);
    } else if (command === 'projects') {
      if (!outPath) throw new Error('projects needs --out');
      const graph = JSON.parse(readFileSync(outPath, 'utf8'));
      const list = process.argv.indexOf('--changed');
      const changed = list === -1 ? [] : process.argv[list + 1].split('\0').filter(Boolean);
      process.stdout.write(affectedProjects(changed, graph));
    } else {
      throw new Error('usage: ci-dep-graph.mjs update|projects --out <file>');
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
