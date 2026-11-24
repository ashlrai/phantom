#!/usr/bin/env node
/**
 * check-test-names.mjs
 *
 * Finds duplicate test names across test/ that confuse reports:
 *
 *   - cross-file: the same full name (describe path + it/test title) in two or
 *     more test files. JUnit/JSON reporters and `vitest -t` key on the name, so
 *     a failure reported as `suite > does a thing` is ambiguous when two files
 *     emit the identical string.
 *   - within-file: the same full name twice in one file. Vitest runs both and
 *     prints two identical lines with no way to tell which failed. This also
 *     catches literal `it('x')` calls inside loops and `it.each` titles with no
 *     placeholders, which emit the identical name for every iteration.
 *
 * `it.each`/`test.each`/`describe.each` titles are rendered before comparison:
 * `%s`/`%d`/`%i`/`%f`/`%j`/`%o`/`%O` consume row elements, `%#` is the row
 * index, `%%` is a literal percent, and `$name`/`$#` read object rows, matching
 * vitest. A row renders only when every referenced element is a string, number
 * or unquoted-template literal; otherwise the raw template is kept as the name
 * (so two identical templates with opaque rows still collide).
 *
 * Usage:
 *   node scripts/check-test-names.mjs [--dir test] [--bare-it] [--verbose]
 *                                      [--baseline FILE] [--no-baseline]
 *                                      [--base REF]
 *
 *   --dir DIR       scan DIR instead of test/ (fixtures, node_modules and
 *                   dist directories are always skipped)
 *   --bare-it       also flag it/test titles that repeat across files even
 *                   when the surrounding describe path differs (advisory;
 *                   exit stays 0)
 *   --baseline FILE read known-collision names from FILE instead of the
 *                   default scripts/check-test-names-baseline.json
 *   --no-baseline   report every collision, ignoring any baseline
 *   --base REF      diff scope: scan the worktree as usual, then archive the
 *                   same directory at REF and fail only on collisions whose
 *                   full name occurs MORE often than it did at REF. Collisions
 *                   inherited unchanged from the base (including every
 *                   baseline-known name) do not fail, so a branch can be gated
 *                   on the duplicates it introduces instead of the legacy
 *                   debt already on the base. Stale baseline entries still
 *                   fail. File renames and moves of an unchanged collision
 *                   keep the same occurrence count and pass.
 *   --verbose, -v   list baseline-known collision sites instead of a count
 *
 * Names in the baseline file are pre-existing duplicates that live in
 * owner-locked files and cannot be renamed here; they are reported under
 * "known" and do not fail the check. Baseline entries that no longer collide
 * are stale and DO fail, so the list must be pruned when a duplicate is
 * fixed. Without --base, exit code is 0 with no new collisions and no stale
 * entries, 1 otherwise. With --base, exit code is 0 when no collision grew
 * past its base count and no baseline entry is stale, 1 otherwise, and 2
 * when REF cannot be resolved or archived.
 */

import ts from 'typescript';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const args = process.argv.slice(2);
let scanDir = 'test';
let bareIt = false;
let verbose = false;
let baselinePath = 'scripts/check-test-names-baseline.json';
let baseRef = null;
for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--dir') {
    scanDir = args[i + 1];
    i += 1;
  } else if (args[i] === '--bare-it') {
    bareIt = true;
  } else if (args[i] === '--baseline') {
    baselinePath = args[i + 1];
    i += 1;
  } else if (args[i] === '--no-baseline') {
    baselinePath = null;
  } else if (args[i] === '--base') {
    baseRef = args[i + 1];
    i += 1;
    if (!baseRef || baseRef.startsWith('--')) {
      console.error('--base needs a git ref');
      process.exit(2);
    }
  } else if (args[i] === '--verbose' || args[i] === '-v') {
    verbose = true;
  } else if (args[i] === '--help' || args[i] === '-h') {
    console.log('usage: node scripts/check-test-names.mjs [--dir test] [--bare-it] [--verbose] [--baseline FILE] [--no-baseline] [--base REF]');
    process.exit(0);
  } else {
    console.error(`unknown argument: ${args[i]}`);
    process.exit(2);
  }
}

const SKIP_DIRS = new Set(['fixtures', 'node_modules', 'dist']);
const TEST_FILE = /\.test\.(?:ts|mts|cts|js|mjs)$/;

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (!SKIP_DIRS.has(entry)) yield* walk(p);
    } else if (TEST_FILE.test(entry)) {
      yield p;
    }
  }
}

/** Resolve the root identifier of a callee: `it.each(t)('x')` -> `it`. */
function calleeRoot(expr) {
  while (ts.isCallExpression(expr) || ts.isPropertyAccessExpression(expr)) {
    expr = expr.expression;
  }
  return ts.isIdentifier(expr) ? expr.text : null;
}

/**
 * The static title of an it/test/describe call, or null when the title is
 * dynamic (interpolated template, identifier, computed expression).
 */
function titleArg(call) {
  for (const arg of call.arguments) {
    if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
      return arg.text;
    }
    if (ts.isTemplateExpression(arg)) return null;
  }
  return null;
}

/**
 * For `x.each(TABLE)('title', fn)` return TABLE when it is an array literal,
 * else undefined. Detects `.skipIf(c).each(t)` and `.runIf(c).each(t)` chains:
 * the outer call's callee is a call whose property is named `each`.
 */
/** Strip `as T`, `satisfies T`, `<T>x` and parens so table literals are seen. */
function unwrap(expr) {
  while (
    ts.isAsExpression(expr) ||
    ts.isSatisfiesExpression(expr) ||
    ts.isParenthesizedExpression(expr) ||
    ts.isTypeAssertionExpression(expr) ||
    ts.isNonNullExpression(expr)
  ) {
    expr = expr.expression;
  }
  return expr;
}

function eachTable(call) {
  const inner = call.expression;
  if (
    ts.isCallExpression(inner) &&
    ts.isPropertyAccessExpression(inner.expression) &&
    inner.expression.name.text === 'each'
  ) {
    const table = inner.arguments[0] && unwrap(inner.arguments[0]);
    return table && ts.isArrayLiteralExpression(table) ? table : undefined;
  }
  return null; // null = not an each call
}

/**
 * The `%j`/`%o`/`%O` (JSON.stringify) form of a literal expression, matching
 * vitest: strings keep their quotes, literal arrays/objects nest recursively.
 * Returns null when any part is not a static literal.
 */
function jsonText(expr) {
  expr = unwrap(expr);
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return JSON.stringify(expr.text);
  }
  if (ts.isNumericLiteral(expr)) return expr.text;
  if (
    ts.isPrefixUnaryExpression(expr) &&
    (expr.operator === ts.SyntaxKind.MinusToken || expr.operator === ts.SyntaxKind.PlusToken) &&
    ts.isNumericLiteral(expr.operand)
  ) {
    return (expr.operator === ts.SyntaxKind.MinusToken ? '-' : '') + expr.operand.text;
  }
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return 'true';
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return 'false';
  if (expr.kind === ts.SyntaxKind.NullKeyword) return 'null';
  if (ts.isArrayLiteralExpression(expr)) {
    const parts = [];
    for (const el of expr.elements) {
      const v = jsonText(el);
      if (v == null) return null;
      parts.push(v);
    }
    return `[${parts.join(',')}]`;
  }
  if (ts.isObjectLiteralExpression(expr)) {
    const parts = [];
    for (const p of expr.properties) {
      if (
        !ts.isPropertyAssignment(p) ||
        (!ts.isIdentifier(p.name) && !ts.isStringLiteral(p.name))
      ) {
        return null;
      }
      const v = jsonText(p.initializer);
      if (v == null) return null;
      parts.push(`${JSON.stringify(p.name.text)}:${v}`);
    }
    return `{${parts.join(',')}}`;
  }
  return null;
}

/** The `%s`/`%d`/`%i`/`%f` (String()) form of a literal expression. */
function strText(expr) {
  expr = unwrap(expr);
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return expr.text;
  }
  if (ts.isNumericLiteral(expr)) return expr.text;
  if (
    ts.isPrefixUnaryExpression(expr) &&
    (expr.operator === ts.SyntaxKind.MinusToken || expr.operator === ts.SyntaxKind.PlusToken) &&
    ts.isNumericLiteral(expr.operand)
  ) {
    return (expr.operator === ts.SyntaxKind.MinusToken ? '-' : '') + expr.operand.text;
  }
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return 'true';
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return 'false';
  if (expr.kind === ts.SyntaxKind.NullKeyword) return 'null';
  if (ts.isArrayLiteralExpression(expr)) {
    const parts = [];
    for (const el of expr.elements) {
      const v = strText(el);
      if (v == null) return null;
      parts.push(v);
    }
    return parts.join(',');
  }
  if (ts.isObjectLiteralExpression(expr)) return '[object Object]';
  return null;
}

/** The util.inspect-style form vitest uses for `$name` object-row lookups. */
function inspectText(expr) {
  expr = unwrap(expr);
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return `'${expr.text}'`;
  }
  const j = jsonText(expr);
  if (j != null && j[0] !== '"') return j;
  return null;
}

/** Look up `$a.b` style paths in an object-literal row. */
function objectPath(row, path) {
  let cur = unwrap(row);
  for (const seg of path.split('.')) {
    if (!ts.isObjectLiteralExpression(cur)) return null;
    const prop = cur.properties.find(
      (p) =>
        ts.isPropertyAssignment(p) &&
        (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) &&
        p.name.text === seg,
    );
    if (!prop) return null;
    cur = unwrap(prop.initializer);
  }
  return inspectText(cur);
}

/**
 * Render one each-row title the way vitest does: `%`-placeholders consume row
 * elements positionally, `%#` is the row index, `%%` is a literal percent, and
 * `$path` reads object rows (`$#` is left untouched, as vitest does). Returns
 * null when any consumed element is not a static literal.
 */
function renderTitle(template, row, index) {
  const bare = unwrap(row);
  const args = ts.isArrayLiteralExpression(bare) ? [...bare.elements] : [bare];
  let argi = 0;
  let ok = true;
  const out = template.replace(
    /%([sdifoOj%#])|\$([A-Za-z_$][\w$]*(?:\.[\w$]+)*)/g,
    (match, pct, dollar) => {
      if (pct === '%') return '%';
      if (pct === '#') return String(index);
      if (dollar !== undefined) {
        const v = objectPath(row, dollar);
        if (v == null) ok = false;
        return v ?? match;
      }
      const el = args[argi];
      argi += 1;
      const v = el == null
        ? 'undefined'
        : (pct === 's' || pct === 'd' || pct === 'i' || pct === 'f'
          ? strText(el)
          : jsonText(el));
      if (v == null) ok = false;
      return v ?? match;
    },
  );
  return ok ? out : null;
}

/**
 * Every static name a call site can emit. Plain calls produce one entry;
 * `each` calls produce one rendered entry per row (unrenderable rows collapse
 * to the raw template once), and an each title with no placeholders yields the
 * title once per row, which intentionally self-collides.
 */
function nameVariants(call, title, sf) {
  const table = eachTable(call);
  const lineOf = (node) => sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  if (table === null) return [{ name: title, line: lineOf(call) }];
  if (table === undefined) return [{ name: title, line: lineOf(call) }];
  const hasPlaceholders = /%[sdifoOj#]|\$[#A-Za-z_$]/.test(title.replace(/%%/g, ''));
  if (!hasPlaceholders) {
    const n = Math.min(Math.max(table.elements.length, 1), 2);
    return Array.from({ length: n }, () => ({ name: title, line: lineOf(call) }));
  }
  const out = [];
  let templateEmitted = false;
  table.elements.forEach((row, i) => {
    const rendered = renderTitle(title, row, i);
    if (rendered == null) {
      if (!templateEmitted) {
        templateEmitted = true;
        out.push({ name: title, line: lineOf(call) });
      }
      return;
    }
    out.push({ name: rendered, line: lineOf(row) });
  });
  if (out.length === 0) out.push({ name: title, line: lineOf(call) });
  return out;
}

function collect(file) {
  const src = readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(file, src, ts.ScriptTarget.Latest, true);
  const found = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const root = calleeRoot(node.expression);
      if (root === 'it' || root === 'test') {
        const title = titleArg(node);
        if (title != null) {
          const path = [[]];
          let p = node.parent;
          while (p) {
            if (ts.isCallExpression(p) && calleeRoot(p.expression) === 'describe') {
              const dt = titleArg(p);
              if (dt != null) {
                const variants = nameVariants(p, dt, sf).map((v) => v.name);
                const next = [];
                for (const prefix of path.splice(0)) {
                  for (const v of variants.slice(0, 64)) next.push([v, ...prefix]);
                }
                path.push(...next);
              }
            }
            p = p.parent;
          }
          for (const v of nameVariants(node, title, sf)) {
            for (const prefix of path) {
              found.push({ title, full: [...prefix, v.name].join(' > '), line: v.line });
            }
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}

const absDir = isAbsolute(scanDir) ? scanDir : join(repoRoot, scanDir);

/**
 * Scan one tree: full-name -> occurrence sites for collision reporting, plus
 * the total emitted instances per full name that --base compares against the
 * archived base tree (occurrence count is file-rename stable).
 */
function scanNames(dir) {
  const byFull = new Map();
  const byBare = new Map();
  const totals = new Map();
  let fileCount = 0;
  let testCount = 0;

  for (const file of walk(dir)) {
    fileCount += 1;
    for (const t of collect(file)) {
      testCount += 1;
      const rel = relative(repoRoot, file);
      const push = (map, key) => {
        const arr = map.get(key) || [];
        arr.push({ file: rel, line: t.line });
        map.set(key, arr);
      };
      push(byFull, t.full);
      push(byBare, t.title);
      totals.set(t.full, (totals.get(t.full) ?? 0) + 1);
    }
  }
  return { byFull, byBare, totals, fileCount, testCount };
}

/**
 * Occurrence totals for every full name at REF. The scanned directory's
 * repo-relative subtree is archived out of the git worktree containing it, so
 * --dir fixtures inside throwaway repositories work unchanged. Realpaths on
 * both sides keep `relative` honest when tmpdir() crosses a symlink (macOS
 * /var -> /private/var).
 */
function baseTotals(ref, dir) {
  const top = execFileSync('git', ['-C', dir, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  const subtree = relative(realpathSync(top), realpathSync(dir)).split(sep).join('/');
  const tmp = mkdtempSync(join(tmpdir(), 'check-test-names-base-'));
  try {
    const archive = execFileSync('git', ['-C', top, 'archive', ref, ...(subtree ? [subtree] : [])], { maxBuffer: 1 << 30 });
    execFileSync('tar', ['-x', '-C', tmp], { input: archive, maxBuffer: 1 << 30 });
    return scanNames(subtree ? join(tmp, subtree) : tmp).totals;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Partition a name->occurrences map into cross-file and within-file hits. */
function collisions(map) {
  const cross = [];
  const intra = [];
  for (const [name, occ] of map) {
    const files = new Set(occ.map((o) => o.file));
    if (files.size > 1) cross.push({ name, occ });
    else if (occ.length > 1) intra.push({ name, occ });
  }
  const bySize = (a, b) => b.occ.length - a.occ.length || a.name.localeCompare(b.name);
  return { cross: cross.sort(bySize), intra: intra.sort(bySize) };
}

const format = (list) => {
  const out = [];
  for (const c of list) {
    out.push(`  "${c.name}" (${c.occ.length}x)`);
    for (const o of c.occ) out.push(`      ${o.file}:${o.line}`);
  }
  return out.join('\n');
};

const baseline = new Set();
if (baselinePath) {
  const abs = isAbsolute(baselinePath) ? baselinePath : join(repoRoot, baselinePath);
  if (existsSync(abs)) {
    const data = JSON.parse(readFileSync(abs, 'utf8'));
    const names = Array.isArray(data) ? data : data.names;
    if (!Array.isArray(names) || names.some((n) => typeof n !== 'string')) {
      console.error(`${baselinePath}: expected a JSON array of names or {"names": [...]}`);
      process.exit(2);
    }
    for (const n of names) baseline.add(n);
  }
}

const head = scanNames(absDir);
const full = collisions(head.byFull);
const stale = [...baseline].filter(
  (name) => !full.cross.some((c) => c.name === name) && !full.intra.some((c) => c.name === name),
);
let failed = false;
let knownCount = 0;
const scope = baseRef ? ` vs ${baseRef}` : '';

if (baseRef) {
  let base;
  try {
    base = baseTotals(baseRef, absDir);
  } catch (error) {
    console.error(`check-test-names: cannot read test tree at ${baseRef}: ${error.message}`);
    process.exit(2);
  }
  // Fail only collisions the change made worse: the full name must occur MORE
  // often in the worktree than at the base. Inherited collisions, including
  // baseline-known names and pure file renames, keep their count and pass.
  const grew = (list) => list.filter((c) => (head.totals.get(c.name) ?? 0) > (base.get(c.name) ?? 0));
  for (const [label, list] of [
    ['new duplicate test names across files', grew(full.cross)],
    ['new duplicate test names within one file', grew(full.intra)],
  ]) {
    if (list.length) {
      failed = true;
      console.log(`${label}${scope} (${list.length}):\n${format(list)}`);
    }
  }
} else {
  const split = (list) => ({
    known: list.filter((c) => baseline.has(c.name)),
    unknown: list.filter((c) => !baseline.has(c.name)),
  });
  const cross = split(full.cross);
  const intra = split(full.intra);
  knownCount = cross.known.length + intra.known.length;

  const report = (label, { known, unknown }) => {
    if (unknown.length) {
      failed = true;
      console.log(`${label} (${unknown.length}):\n${format(unknown)}`);
    }
    if (known.length) {
      const detail = verbose ? `\n${format(known)}` : ' (pass --verbose to list)';
      console.log(`${label.replace('duplicate', 'known duplicate')} (baseline, ${known.length}):${detail}`);
    }
  };
  report('duplicate test names across files', cross);
  report('duplicate test names within one file', intra);
}

if (stale.length) {
  failed = true;
  console.log(`stale baseline entries (${stale.length}):`);
  for (const name of stale) console.log(`  "${name}"`);
}

if (bareIt) {
  const bare = collisions(head.byBare);
  const advisory = bare.cross.filter(
    (c) => !full.cross.some((f) => f.name.endsWith(c.name)),
  );
  if (advisory.length) {
    console.log(`\nadvisory: it/test titles reused across files under different describes (${advisory.length}):\n${format(advisory)}`);
  }
}

console.log(
  failed
    ? `\ncheck-test-names: FAIL (${head.fileCount} files, ${head.testCount} tests scanned${scope})`
    : `\ncheck-test-names: OK (${head.fileCount} files, ${head.testCount} tests scanned${scope}, ` +
      `${knownCount ? `${knownCount} baseline-known, ` : ''}no new duplicate full names)`,
);
process.exit(failed ? 1 : 0);
