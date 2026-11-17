/**
 * verse-client-route-parity-408.test.ts — every literal `/api/verse/fleet/*`
 * path the desktop bundle calls must exist somewhere in server code.
 *
 * Desktop query modules turn an HTTP 404 into `null`, which hides the card
 * instead of surfacing an error, so a client/server path mismatch ships
 * silently — both entries in KNOWN_UNSERVED were live examples on master.
 * A plain fs+regex scan (no parser, no deps) fails on any NEW unserved path
 * so the next typo is caught before merge. RQ-PHX-VERSEROUTEPARITY408C.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = join(__dirname, '..');
const CLIENT_ROOT = join(ROOT, 'src', 'web-ui');
const SERVER_ROOT = join(ROOT, 'src', 'core');
const FAMILIES_FILE = join(SERVER_ROOT, 'verse', 'workbench-types.ts');

/**
 * Client paths with no server evidence today, each owned by the fix job named
 * beside it. Never add entries: the "still unserved" test below fails the
 * moment a fix lands (or the call site disappears), so this map only shrinks.
 */
const KNOWN_UNSERVED = new Map<string, string>([
]);

/** '/api/verse/fleet/...' at the start of any quote style; `${}` filtered after. */
const PATH_LITERAL = /(['"`])(\/api\/verse\/fleet\/[^'"`]*)\1/g;
/** `const X = 'lit'` or `export const X = `tpl`` — same-file template env. */
const CONST_DECL = /(?:export\s+)?const\s+([A-Za-z_$][\w$]*)\s*(?::[^=\n]+)?=\s*(['"`])([^'"`]*)\2/g;
const TEMPLATE = /`([^`]*)`/g;
const IDENT = /\$\{([A-Za-z_$][\w$]*)\}/g;
/** Test files and fixtures describe or stub calls; they neither ship nor serve. */
const SKIP_FILE = /\.test\.|test-support|fixtures/;
const TS_FILE = /\.tsx?$/;
const stripTail = (path: string): string => path.replace(/[?#].*$/, '');
/** Query/fragment, then one stray trailing '/' — checked after the raw
 * literal's own trailing-'/' test so '…/x/?q' normalizes to the exact '/x'. */
const normalize = (path: string): string => stripTail(path).replace(/\/$/, '');

function* walk(dir: string): Generator<string> {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) yield* walk(p);
    else if (TS_FILE.test(name) && !SKIP_FILE.test(p)) yield p;
  }
}

/** Resolve `${X}` segments from file-local const declarations (transitively). */
function resolveTemplate(tpl: string, env: Map<string, string>): string | null {
  let out = tpl;
  for (let depth = 0; depth < 8 && out.includes('${'); depth++) {
    let missing = false;
    out = out.replace(IDENT, (whole, id: string) => {
      const value = env.get(id);
      if (value === undefined) { missing = true; return whole; }
      return value;
    });
    if (missing) return null;
  }
  return out.includes('${') ? null : out;
}

interface Scan {
  clientPaths: Map<string, Set<string>>;
  clientPrefixes: Map<string, Set<string>>;
  serverPaths: Set<string>;
  /** Source literals ending in '/' — the ONLY trusted prefix evidence. A
   * `${X}/` template in `startsWith` is not: it may just forward to a module
   * that 404s (the runtime-identity family proves this). */
  serverPrefixes: Set<string>;
  families: { module: string; prefixes: string[] }[];
  moduleSource: Map<string, string | null>;
}

function buildScan(): Scan {
  const scan: Scan = {
    clientPaths: new Map(), clientPrefixes: new Map(),
    serverPaths: new Set(), serverPrefixes: new Set(),
    families: [], moduleSource: new Map(),
  };
  const collect = (map: Map<string, Set<string>>, path: string, file: string): void => {
    const set = map.get(path) ?? new Set<string>();
    set.add(file);
    map.set(path, set);
  };
  for (const file of walk(CLIENT_ROOT)) {
    const rel = relative(ROOT, file);
    for (const m of readFileSync(file, 'utf8').matchAll(PATH_LITERAL)) {
      const raw = m[2];
      if (raw.includes('${')) continue; // interpolated template: not a literal path
      // A raw trailing '/' means the call site appends an id: a client prefix.
      collect(raw.endsWith('/') ? scan.clientPrefixes : scan.clientPaths,
        raw.endsWith('/') ? raw : normalize(raw), rel);
    }
  }
  for (const file of walk(SERVER_ROOT)) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(PATH_LITERAL)) {
      const raw = m[2];
      if (raw.includes('${')) continue;
      if (raw.endsWith('/')) scan.serverPrefixes.add(stripTail(raw));
      else scan.serverPaths.add(normalize(raw));
    }
    const env = new Map<string, string>();
    for (const m of src.matchAll(CONST_DECL)) env.set(m[1], m[3]);
    for (const m of src.matchAll(TEMPLATE)) {
      const resolved = m[1].includes('${') ? resolveTemplate(m[1], env) : null;
      if (resolved === null || !resolved.startsWith('/api/verse/fleet/')) continue;
      scan.serverPaths.add(normalize(resolved));
    }
  }
  // Workbench route families mount by prefix, but a prefix alone does not
  // prove a sub-path is served — the module file must name the suffix.
  for (const block of readFileSync(FAMILIES_FILE, 'utf8').matchAll(/\{[^{}]*\}/g)) {
    const mod = /module:\s*'([^']+)'/.exec(block[0]);
    const prefs = /prefixes:\s*\[([^\]]*)\]/.exec(block[0]);
    if (mod && prefs) {
      scan.families.push({ module: mod[1]!, prefixes: [...prefs[1].matchAll(/'([^']+)'/g)].map((x) => x[1]!) });
    }
  }
  return scan;
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Module-file evidence for one family suffix: a quoted literal ending with
 * '/sub/path', or exactly 'sub/path' / 'path' (a bare-suffix dispatch). */
function moduleServesSuffix(scan: Scan, module: string, suffix: string): boolean {
  let src = scan.moduleSource.get(module);
  if (src === undefined) {
    try { src = readFileSync(join(ROOT, module), 'utf8'); }
    catch { src = null; } // module not landed: its family 404s wholesale
    scan.moduleSource.set(module, src);
  }
  if (src === null) return false;
  return new RegExp(`['"\`][^'"\`]*${escapeRe(suffix)}['"\`]`).test(src)
    || new RegExp(`['"\`]${escapeRe(suffix.slice(1))}['"\`]`).test(src);
}

function isServed(scan: Scan, path: string): boolean {
  if (scan.serverPaths.has(path)) return true;
  for (const pre of scan.serverPrefixes) if (path.startsWith(pre)) return true;
  for (const fam of scan.families) {
    for (const pre of fam.prefixes) {
      if (path.startsWith(`${pre}/`) && moduleServesSuffix(scan, fam.module, path.slice(pre.length))) return true;
    }
  }
  return false;
}

let cached: Scan | null = null;
const scan = (): Scan => (cached ??= buildScan());

function unservedClientPaths(): Map<string, Set<string>> {
  const s = scan();
  const out = new Map<string, Set<string>>();
  for (const [path, files] of s.clientPaths) if (!isServed(s, path)) out.set(path, files);
  // A client prefix ('…/…/' — an id appended at the call site) is served only
  // inside a server literal prefix; anything weaker cannot be proven static.
  for (const [prefix, files] of s.clientPrefixes) {
    if (![...s.serverPrefixes].some((pre) => prefix.startsWith(pre))) out.set(prefix, files);
  }
  return out;
}

describe('verse client/server route parity (/api/verse/fleet/*)', () => {
  it('every literal fleet path the desktop calls exists in server code', () => {
    const unknown = [...unservedClientPaths()]
      .filter(([path]) => !KNOWN_UNSERVED.has(path))
      .map(([path, files]) => `${path}  <-  ${[...files].sort().join(', ')}`);
    expect(unknown).toEqual([]);
  });

  it('KNOWN_UNSERVED entries stay unserved — delete each once its fix lands', () => {
    const stale = [...KNOWN_UNSERVED]
      .filter(([path]) => !unservedClientPaths().has(path))
      .map(([path, job]) => `${path}  (${job}) — now served or no longer called; remove this KNOWN_UNSERVED entry`);
    expect(stale).toEqual([]);
  });
});
