#!/usr/bin/env node
/**
 * web-route-audit.mjs — finds desktop (src/web-ui) reads of `/api/...` routes
 * that no server code answers.
 *
 * Many web-ui queries map a 404 to "no data" or "not in this build", so a
 * route the server never registers looks like an empty, healthy pane. This
 * audit compares the paths the client names with the routes the server code
 * declares, statically: it reads files, never starts a server.
 *
 * It is a heuristic, not a router. A small lexer masks comments and string,
 * template and regex literals, so the route forms below are matched on code
 * only, and `const NAME = '...'` / `` const NAME = `${OTHER}/x` `` string
 * constants are resolved across files. Server routes it recognises:
 *   (a) `prefixes: [...]` entries of the workbench family table
 *       (segment boundary, like verse-api.ts's workbenchFamilyFor);
 *   (b) `<path> === X`, `<path> !== X` and `<path>.startsWith(X)`, where
 *       <path> is an identifier or member named like `path`/`pathname` and X
 *       is a literal, template or resolved constant;
 *   (c) exported `*_PATH` constants;
 *   (d) regex literals that begin with `^\/api\/`.
 * Template holes that do not resolve become a `:param` wildcard segment.
 *
 * CLI: `node scripts/web-route-audit.mjs [root]` prints unserved paths as JSON.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const CLIENT_ROOTS = ['src/web-ui'];
export const SERVER_ROOTS = ['src/core/web', 'src/core/verse'];
export const PARAM = ':param';

const SOURCE = /\.tsx?$/;
const TEST = /\.(?:test|spec|test-support)\.tsx?$|\.fixtures?\.tsx?$/;
const IDENT = /[A-Za-z0-9_$]/;
/** After one of these (or a keyword below) a `/` starts a regex, not a division. */
const REGEX_AFTER = new Set(['', '(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^']);
const REGEX_KEYWORDS = new Set(['return', 'typeof', 'case', 'do', 'else', 'in', 'of', 'new', 'delete', 'void', 'throw', 'yield', 'await']);

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

/**
 * Masks one source file. Returns `masked`, the code with every comment
 * blanked and every literal replaced by a `«n»` marker, and `literals[n]`:
 * `{ kind: 'string', value }`, `{ kind: 'template', quasis, holes }` (holes
 * are trimmed expression text) or `{ kind: 'regex', source, flags }`.
 */
export function lex(text) {
  const literals = [];
  let i = 0;

  // The previous significant character of the ORIGINAL text before `at`: a
  // `/` after punctuation or a keyword starts a regex, after a value divides.
  const regexAllowedAt = (at) => {
    let j = at - 1;
    while (j >= 0 && /\s/.test(text[j])) j -= 1;
    if (j < 0) return true;
    if (!IDENT.test(text[j])) return REGEX_AFTER.has(text[j]);
    let k = j;
    while (k > 0 && IDENT.test(text[k - 1])) k -= 1;
    return REGEX_KEYWORDS.has(text.slice(k, j + 1));
  };

  const readQuoted = (quote) => {
    const start = i + 1;
    i = start;
    while (i < text.length && text[i] !== quote && text[i] !== '\n') i += text[i] === '\\' ? 2 : 1;
    const value = text.slice(start, i);
    i += 1;
    return value;
  };

  const readRegex = () => {
    let inClass = false;
    const start = i + 1;
    i = start;
    while (i < text.length && text[i] !== '\n') {
      const ch = text[i];
      if (ch === '\\') { i += 2; continue; }
      if (ch === '[') inClass = true;
      else if (ch === ']') inClass = false;
      else if (ch === '/' && !inClass) break;
      i += 1;
    }
    const source = text.slice(start, i);
    i += 1;
    const flagStart = i;
    while (i < text.length && /[a-z]/.test(text[i])) i += 1;
    return { kind: 'regex', source, flags: text.slice(flagStart, i) };
  };

  const special = /[/'"`{}]/g;
  const literalMarker = (literal) => {
    literals.push(literal);
    return `«${literals.length - 1}»`;
  };

  // Code until `stop` ('}' closing a template hole) at depth 0, or end of file.
  const readCode = (stop) => {
    const out = [];
    let depth = 0;
    while (i < text.length) {
      special.lastIndex = i;
      const found = special.exec(text);
      const at = found ? found.index : text.length;
      out.push(text.slice(i, at));
      i = at;
      if (!found) break;
      const ch = text[i];
      const next = text[i + 1];
      if (stop && ch === '}' && depth === 0) return out.join('');
      if (ch === '/' && next === '/') {
        const end = text.indexOf('\n', i);
        i = end < 0 ? text.length : end;
        out.push(' ');
      } else if (ch === '/' && next === '*') {
        const end = text.indexOf('*/', i + 2);
        i = end < 0 ? text.length : end + 2;
        out.push(' ');
      } else if (ch === '\'' || ch === '"') {
        out.push(literalMarker({ kind: 'string', value: readQuoted(ch) }));
      } else if (ch === '`') {
        out.push(literalMarker(readTemplate()));
      } else if (ch === '/' && regexAllowedAt(i)) {
        out.push(literalMarker(readRegex()));
      } else {
        if (ch === '{') depth += 1;
        else if (ch === '}') depth -= 1;
        out.push(ch);
        i += 1;
      }
    }
    return out.join('');
  };

  const readTemplate = () => {
    const quasis = [''];
    const holes = [];
    i += 1;
    while (i < text.length && text[i] !== '`') {
      if (text[i] === '\\') { quasis[quasis.length - 1] += text.slice(i, i + 2); i += 2; continue; }
      if (text[i] === '$' && text[i + 1] === '{') {
        i += 2;
        holes.push(readCode(true).trim());
        i += 1;
        quasis.push('');
        continue;
      }
      quasis[quasis.length - 1] += text[i];
      i += 1;
    }
    i += 1;
    return { kind: 'template', quasis, holes };
  };

  const masked = readCode(false);
  return { masked, literals };
}

// ---------------------------------------------------------------------------
// String constants
// ---------------------------------------------------------------------------

const LITERAL_REF = /^«(\d+)»$/;
const CONST_DECL = /\bconst\s+([A-Za-z_$][\w$]*)\s*(?::\s*string\s*)?=\s*(«\d+»|[A-Za-z_$][\w$]*)(?=\s*(?:as\s+const\s*)?[;,\n)])/g;

/** `name -> raw operand` per file; operands are a `«n»` marker or an identifier. */
function constDecls(lexed) {
  const decls = new Map();
  for (const match of lexed.masked.matchAll(CONST_DECL)) decls.set(match[1], match[2]);
  return decls;
}

/**
 * A resolver over every lexed file: `resolve(file, operand)` gives the string
 * an operand evaluates to (holes that do not resolve become `:param`), or null.
 * Identifiers resolve in their own file first, then by a globally unique name.
 */
function makeResolver(lexedFiles) {
  const local = new Map();
  const global = new Map();
  for (const [file, lexed] of lexedFiles) {
    const decls = constDecls(lexed);
    local.set(file, decls);
    for (const name of decls.keys()) global.set(name, global.has(name) ? null : file);
  }
  const memo = new Map();
  const resolveIdent = (file, name, seen) => {
    const owner = local.get(file)?.has(name) ? file : global.get(name);
    if (!owner) return null;
    const key = `${owner}\0${name}`;
    if (memo.has(key)) return memo.get(key);
    if (seen.has(key)) return null;
    seen.add(key);
    const value = resolveOperand(owner, local.get(owner).get(name), seen);
    memo.set(key, value);
    return value;
  };
  const resolveOperand = (file, operand, seen = new Set()) => {
    const ref = LITERAL_REF.exec(operand);
    if (!ref) return /^[A-Za-z_$][\w$]*$/.test(operand) ? resolveIdent(file, operand, seen) : null;
    const literal = lexedFiles.get(file).literals[Number(ref[1])];
    if (literal.kind === 'string') return literal.value;
    if (literal.kind !== 'template') return null;
    return literal.quasis.reduce((acc, quasi, index) => {
      if (index === 0) return quasi;
      const hole = literal.holes[index - 1];
      const value = /^[A-Za-z_$][\w$]*$/.test(hole) ? resolveIdent(file, hole, seen) : null;
      return acc + (value ?? PARAM) + quasi;
    }, '');
  };
  return resolveOperand;
}

// ---------------------------------------------------------------------------
// Collectors
// ---------------------------------------------------------------------------

/** A client or server path with its query string dropped and holes normalised. */
export function normalizePath(value) {
  return value.split('?')[0].split('#')[0];
}

const isApi = (value) => typeof value === 'string' && /^\/api\/\S+$/.test(value);

function lexAll(files) {
  return new Map(files.map(({ file, text }) => [file, lex(text)]));
}

/**
 * Every `/api/...` path the client names: string literals, and template
 * literals whose head (after resolving string constants) is `/api/...`.
 * `files` is `[{ file, text }]`. Returns `[{ path, files }]` sorted by path.
 */
export function collectClientPaths(files) {
  const lexedFiles = lexAll(files);
  const resolve = makeResolver(lexedFiles);
  const byPath = new Map();
  for (const [file, lexed] of lexedFiles) {
    lexed.literals.forEach((literal, index) => {
      if (literal.kind === 'regex') return;
      const value = resolve(file, `«${index}»`);
      if (!isApi(value)) return;
      const clientPath = normalizePath(value);
      if (!byPath.has(clientPath)) byPath.set(clientPath, new Set());
      byPath.get(clientPath).add(file);
    });
  }
  return [...byPath].map(([p, set]) => ({ path: p, files: [...set].sort() })).sort((a, b) => a.path.localeCompare(b.path));
}

/** A path-like subject: `path`, `pathname`, `url.pathname`, `requestPath`... */
const PATH_SUBJECT = /(?:^|\.)[\w$]*(?:path|Path)[\w$]*$/;
const OPERAND = String.raw`(«\d+»|[A-Za-z_$][\w$]*)`;
const COMPARE = new RegExp(String.raw`([\w$.]+)\s*[!=]==\s*${OPERAND}`, 'g');
const COMPARE_REVERSED = /(«\d+»)\s*[!=]==\s*([\w$.]+)/g;
const STARTS_WITH = new RegExp(String.raw`([\w$.]+)\.startsWith\(\s*${OPERAND}\s*[,)]`, 'g');
const EXPORTED_PATH = /\bexport\s+const\s+([A-Z][A-Z0-9_]*_PATH)\s*(?::\s*string\s*)?=\s*(«\d+»|[A-Za-z_$][\w$]*)/g;
const FAMILY_PREFIXES = /\bprefixes\s*:\s*\[([^\]]*)\]/g;

/**
 * Every route the server code declares. `files` is `[{ file, text }]`.
 * Returns `{ literals, prefixes, regexes }`: exact paths, raw `startsWith`
 * prefixes, and route regexes. A family prefix `p` contributes the literal
 * `p` and the prefix `p/` (segment boundary).
 */
export function collectServerRoutes(files) {
  const lexedFiles = lexAll(files);
  const resolve = makeResolver(lexedFiles);
  const literals = new Set();
  const prefixes = new Set();
  const regexes = new Map();
  for (const [file, lexed] of lexedFiles) {
    const { masked } = lexed;
    const routeOperands = [
      ...[...masked.matchAll(COMPARE)].map((match) => [match[1], match[2]]),
      ...[...masked.matchAll(COMPARE_REVERSED)].map((match) => [match[2], match[1]]),
    ];
    for (const [subject, operand] of routeOperands) {
      if (!PATH_SUBJECT.test(subject)) continue;
      const value = resolve(file, operand);
      if (isApi(value)) literals.add(value);
    }
    for (const match of masked.matchAll(STARTS_WITH)) {
      if (!PATH_SUBJECT.test(match[1])) continue;
      const value = resolve(file, match[2]);
      if (isApi(value)) prefixes.add(value);
    }
    for (const match of masked.matchAll(EXPORTED_PATH)) {
      const value = resolve(file, match[2]);
      if (isApi(value)) literals.add(value);
    }
    for (const match of masked.matchAll(FAMILY_PREFIXES)) {
      for (const ref of match[1].matchAll(/«\d+»|[A-Za-z_$][\w$]*/g)) {
        const value = resolve(file, ref[0]);
        if (!isApi(value)) continue;
        literals.add(value);
        prefixes.add(`${value}/`);
      }
    }
    for (const literal of lexed.literals) {
      if (literal.kind !== 'regex' || !literal.source.startsWith('^\\/api\\/')) continue;
      try {
        regexes.set(`/${literal.source}/${literal.flags}`, new RegExp(literal.source, literal.flags.replace(/[gy]/g, '')));
      } catch { /* not a route regex we can run */ }
    }
  }
  return { literals: [...literals].sort(), prefixes: [...prefixes].sort(), regexes: [...regexes.values()] };
}

// ---------------------------------------------------------------------------
// Matching
// ---------------------------------------------------------------------------

/** One segment matches another when equal or when either side is a hole. */
const segmentMatches = (a, b) => a === b || a.includes(PARAM) || b.includes(PARAM);

function literalMatches(clientPath, literal) {
  if (clientPath === literal) return true;
  const a = clientPath.split('/');
  const b = literal.split('/');
  return a.length === b.length && a.every((segment, index) => segmentMatches(segment, b[index]));
}

function prefixMatches(clientPath, prefix) {
  if (clientPath.startsWith(prefix)) return true;
  const a = clientPath.split('/');
  const b = prefix.split('/');
  const last = b.length - 1;
  if (a.length < b.length) return false;
  for (let index = 0; index < last; index += 1) if (!segmentMatches(a[index], b[index])) return false;
  // `startsWith('/api/run/')` leaves '' last: any following segment matches.
  return b[last] === '' ? a.length > last : a[last].startsWith(b[last]) || segmentMatches(a[last], b[last]);
}

const HOLE_SAMPLES = ['p', '1', 'p1', 'p-1'];

/** A hole stands for one segment: try a few plain ones and the regex's own `(a|b)` words. */
function regexMatches(clientPath, regex) {
  if (!clientPath.includes(PARAM)) return regex.test(clientPath);
  const words = [...regex.source.matchAll(/\(((?:[\w-]+\|)+[\w-]+)\)/g)].flatMap((match) => match[1].split('|'));
  return [...HOLE_SAMPLES, ...words].some((sample) => regex.test(clientPath.split(PARAM).join(sample)));
}

export function isServed(clientPath, server) {
  return server.literals.some((literal) => literalMatches(clientPath, literal))
    || server.prefixes.some((prefix) => prefixMatches(clientPath, prefix))
    || server.regexes.some((regex) => regexMatches(clientPath, regex));
}

/** `client` from collectClientPaths, `server` from collectServerRoutes. */
export function auditRoutes(client, server) {
  const unserved = client.filter(({ path: clientPath }) => !isServed(clientPath, server));
  return { unserved, served: client.length - unserved.length };
}

// ---------------------------------------------------------------------------
// Tree reading
// ---------------------------------------------------------------------------

function sourceFiles(root, dir) {
  const absolute = path.join(root, dir);
  if (!fs.existsSync(absolute)) return [];
  return fs.readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(root, rel);
    return entry.isFile() && SOURCE.test(entry.name) && !entry.name.endsWith('.d.ts') && !TEST.test(entry.name) ? [rel] : [];
  });
}

/** `[{ file, text }]` for every non-test .ts/.tsx under `dirs`; `keep` prefilters by text. */
export function readSources(root, dirs, keep = () => true) {
  return dirs.flatMap((dir) => sourceFiles(root, dir)).sort().flatMap((file) => {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    return keep(text) ? [{ file, text }] : [];
  });
}

/** Route modules and the constant files they name: `x-api.js`, `x-types.js`, `types.js`. */
const ROUTE_MODULE = /(?:^|[-/])(?:api|types)\.js$/;
const RELATIVE_IMPORT = /\b(?:from|import)\s*\(?\s*['"](\.{1,2}\/[^'"]+\.js)['"]/g;

/**
 * The server roots plus every route module they import, transitively. Route
 * families mount modules that live elsewhere (verse-api.ts loads
 * `../reasoning/reasoning-api.js`, `../devin/devin-api.js`...), and their
 * path constants often sit in a sibling `types.ts`.
 */
export function readServerSources(root, dirs = SERVER_ROOTS) {
  const files = readSources(root, dirs);
  const seen = new Set(files.map(({ file }) => file));
  for (let index = 0; index < files.length; index += 1) {
    const { file, text } = files[index];
    for (const match of text.matchAll(RELATIVE_IMPORT)) {
      if (!ROUTE_MODULE.test(match[1])) continue;
      const target = path.posix.join(path.posix.dirname(file), match[1]).replace(/\.js$/, '.ts');
      if (seen.has(target) || !target.startsWith('src/') || !fs.existsSync(path.join(root, target))) continue;
      seen.add(target);
      files.push({ file: target, text: fs.readFileSync(path.join(root, target), 'utf8') });
    }
  }
  return files;
}

/** Runs the whole audit over a checkout rooted at `root`. */
export function auditTree(root) {
  const client = collectClientPaths(readSources(root, CLIENT_ROOTS));
  const server = collectServerRoutes(readServerSources(root));
  return auditRoutes(client, server);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = path.resolve(process.argv[2] ?? path.join(path.dirname(fileURLToPath(import.meta.url)), '..'));
  const result = auditTree(root);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
