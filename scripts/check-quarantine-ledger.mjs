#!/usr/bin/env node
/**
 * check-quarantine-ledger.mjs — CI-gate verifier for flaky-test quarantines.
 *
 * A test may be silenced only through the ledger: every .skip/.todo/x-prefixed
 * marker ADDED by a change needs a live row in queue/quarantine.tsv, and every
 * row must track a real marker. The check is diff-scoped for markers and
 * tree-scoped for rows, so it fails CI Gate on:
 *
 *   untracked-skip      added skip marker with no valid row covering it
 *   expired-skip        added skip whose only covering rows have lapsed
 *   addition-only-skip  a skip that is only an addition: the marker's test was
 *                       never running (its unskipped call does not appear in
 *                       the removed lines). Quarantine retires a running test;
 *                       it is not a way to land a born-disabled one.
 *   only-additions      a ledger row added by the change that covers no live
 *                       marker (rows may only be added together with, or for,
 *                       an existing skip)
 *   stale-row           a pre-existing row whose tracked marker is gone
 *   focused-test        an added .only — it silently unschedules every other
 *                       test and can never be a ledgered quarantine
 *   dynamic-title       an added skip whose title is not a literal, so no row
 *                       could ever name it
 *   unverifiable-skip   an added marker line in a test file that cannot be read
 *   non-quarantinable   Security R8: secret-shape, gitleaks, cargo-deny and
 *                       ci-gate can never be quarantined — enforced here, in
 *                       the verifier, for both skips and ledger rows
 *   invalid-row         malformed ledger row (never covers anything)
 *   expired-row         a row whose expiry has passed; renew or delete it
 *   invalid-ledger      the ledger has no header row
 *
 * Ledger format — first non-comment line must be the header
 * "test\trepo\tlead\texpiry", then one row per marker:
 *   test    "<repo-relative test file>" or "<repo-relative test file> > <full name>"
 *           (full name = describe path joined with ' > ', as Vitest reports it;
 *           a file-only row covers every marker in that file)
 *   repo    owner/name the row applies to (default check: ashlrai/phantom;
 *           rows for other repos are shape-checked only — their trees are not
 *           visible here)
 *   lead    accountable owner (person or team handle)
 *   expiry  YYYY-MM-DD (end of that UTC day) or ISO-8601 datetime with offset;
 *           must be after now and no more than 7 days out — quarantines are
 *           short leases, not permanent exemptions
 *
 * Usage:
 *   node scripts/check-quarantine-ledger.mjs [--base REF | --diff FILE]
 *       [--ledger PATH] [--repo OWNER/NAME] [--now ISO] [--json]
 *
 *   --base REF    verify `git diff REF` plus untracked files (what the gate passes)
 *   --diff FILE   verify a stored unified diff; "-" reads stdin
 *   (neither)     validate the ledger alone: shape, expiry, protection and
 *                 whether each row still covers a live marker
 *
 * Exit: 0 no violations, 1 violations found, 2 usage or input error.
 */
import ts from 'typescript';
import { spawnSync } from 'node:child_process';
import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const LEDGER_PATH = 'queue/quarantine.tsv';
export const DEFAULT_REPO = 'ashlrai/phantom';
export const QUARANTINE_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
// Security R8: these checks are non-quarantinable and the verifier enforces it.
export const NON_QUARANTINABLE = Object.freeze(['secret-shape', 'gitleaks', 'cargo-deny', 'ci-gate']);

const TEST_FILE = /(?:^|\/)[^/\s]+\.(?:test|spec)\.[cm]?[jt]sx?$/;
const REPO_SHAPE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ISO_DATETIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;
const LIMITS = { diffBytes: 64 * 1024 * 1024, fileBytes: 4 * 1024 * 1024, ledgerBytes: 1024 * 1024, rows: 1000, files: 5000 };

class InputError extends Error {}
const need = (condition, message) => { if (!condition) throw new InputError(message); };

// ---------------------------------------------------------------------------
// Names: protected checks and callee vocabulary
// ---------------------------------------------------------------------------

const normalizeName = (value) => String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const PROTECTED_TOKENS = NON_QUARANTINABLE.map((name) => normalizeName(name).split('-'));

/** Does a file name, path segment or title name one of the R8 protected checks? */
export function isProtected(value) {
  const tokens = normalizeName(value).split('-').filter(Boolean);
  return PROTECTED_TOKENS.some((protectedTokens) => {
    const n = protectedTokens.length;
    for (let i = 0; i + n <= tokens.length; i += 1) {
      if (tokens.slice(i, i + n).join('-') === protectedTokens.join('-')) return true;
    }
    return false;
  });
}

const CALLEE_ROOTS = new Set(['it', 'test', 'describe', 'suite', 'specify',
  'xit', 'xtest', 'xdescribe', 'xsuite', 'xspecify', 'fit', 'fdescribe']);
const DESCRIBE_ROOTS = new Set(['describe', 'suite', 'xdescribe', 'xsuite', 'fdescribe']);
const SKIP_MEMBERS = new Set(['skip', 'skipIf', 'todo']);
// A removed line that still shows a test/suite call opener.
const CALLEE_CALL = /(?:^|[^\w$])(?:[fx]?(?:it|test|describe|suite|specify))\s*(?:\.\s*[A-Za-z_$][\w$]*)*\s*\(/;
// Degraded marker detection for files that cannot be read (fail closed).
const DEGRADED_MARKER = /(?:^|[^\w$])(?:x?it|x?test|x?describe|x?suite|x?specify|fit|fdescribe)\s*\.\s*(?:skip|skipIf|todo|only)\b|(?:^|[^\w$])(?:xit|xtest|xdescribe|xsuite|xspecify)\s*\(/;

// ---------------------------------------------------------------------------
// Ledger parsing (pure)
// ---------------------------------------------------------------------------

function parseExpiry(value) {
  if (DATE_ONLY.test(value)) {
    const ms = Date.parse(`${value}T00:00:00.000Z`);
    if (!Number.isFinite(ms)) return null;
    const day = new Date(ms);
    const [y, m, d] = value.split('-').map(Number);
    if (day.getUTCFullYear() !== y || day.getUTCMonth() !== m - 1 || day.getUTCDate() !== d) return null;
    return ms + 86_399_999; // a bare date covers the whole UTC day
  }
  if (!ISO_DATETIME.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function validRepoPath(file) {
  return typeof file === 'string' && file.length > 0 && file.length <= 1024 &&
    !file.includes('\\') && !file.startsWith('/') && !/^[A-Za-z]:/.test(file) &&
    file.split('/').every((part) => part && part !== '.' && part !== '..');
}

/**
 * @returns {{ headerOk: boolean, rows: object[] }} row: { line, text, test, file, name,
 *   repo, lead, expiry, expiryMs, state: 'valid'|'expired'|'invalid', reason?, added }
 */
export function parseLedger(text, { now = Date.now() } = {}) {
  const rows = [];
  let headerOk = false;
  const seen = new Set();
  for (const [index, raw] of String(text).split('\n').entries()) {
    const line = raw.replace(/\r$/, '');
    const trimmed = line.trim();
    const lineNo = index + 1;
    if (!trimmed || trimmed.startsWith('#')) continue;
    if (!headerOk) {
      need(trimmed.split('\t').map((f) => f.trim()).join('\t') === 'test\trepo\tlead\texpiry',
        `${LEDGER_PATH}:${lineNo}: first row must be the header "test repo lead expiry" (tab-separated)`);
      headerOk = true;
      continue;
    }
    need(rows.length < LIMITS.rows, `quarantine ledger exceeds ${LIMITS.rows} rows`);
    const row = { line: lineNo, text: trimmed, added: false };
    const fields = line.split('\t').map((f) => f.trim());
    const invalid = (reason) => rows.push({ ...row, state: 'invalid', reason });
    if (fields.length !== 4 || fields.some((f) => f === '')) { invalid(`expected 4 non-empty tab-separated fields`); continue; }
    const [test, repo, lead, expiry] = fields;
    Object.assign(row, { test, repo, lead, expiry });
    const split = test.indexOf(' > ');
    row.file = split === -1 ? test : test.slice(0, split);
    row.name = split === -1 ? null : test.slice(split + 3);
    if (!validRepoPath(row.file)) { invalid(`invalid test path "${row.file}"`); continue; }
    if (row.name !== null && (!row.name || row.name.length > 4096)) { invalid(`invalid test name`); continue; }
    if (!REPO_SHAPE.test(repo)) { invalid(`invalid repo "${repo}"`); continue; }
    if (seen.has(`${repo}${row.test}`)) { invalid(`duplicate row for ${repo}:${test}`); continue; }
    seen.add(`${repo}${row.test}`);
    const expiryMs = parseExpiry(expiry);
    if (expiryMs === null) { invalid(`expiry "${expiry}" is not a YYYY-MM-DD date or ISO-8601 datetime`); continue; }
    row.expiryMs = expiryMs;
    if (DATE_ONLY.test(expiry)) {
      // A bare date compares by UTC day: expiring "today" is already lapsed and
      // today+7 is the longest lease a row may hold.
      const daysOut = Math.floor(expiryMs / 86_400_000) - Math.floor(now / 86_400_000);
      if (daysOut <= 0) { rows.push({ ...row, state: 'expired' }); continue; }
      if (daysOut > 7) { invalid(`expiry "${expiry}" is more than 7 days out`); continue; }
    } else {
      if (expiryMs <= now) { rows.push({ ...row, state: 'expired' }); continue; }
      if (expiryMs - now > QUARANTINE_WINDOW_MS) { invalid(`expiry "${expiry}" is more than 7 days out`); continue; }
    }
    rows.push({ ...row, state: 'valid' });
  }
  return { headerOk, rows };
}

// ---------------------------------------------------------------------------
// Unified-diff parsing (pure)
// ---------------------------------------------------------------------------

function unquotePath(path) {
  return path.replace(/^"|"$/g, '').replace(/\\(.)/g, '$1');
}

/**
 * @returns {Map<string, {path, addedLines:Set<number>, addedText:string[],
 *   removedText:string[], isNew:boolean, isDeleted:boolean, allAdded:boolean}>}
 */
export function parseUnifiedDiff(diffText) {
  const files = new Map();
  const entry = (path) => {
    if (!files.has(path)) files.set(path, { path, addedLines: new Set(), addedText: [], removedText: [], isNew: false, isDeleted: false, allAdded: false });
    return files.get(path);
  };
  let current = null;
  let pending = null;
  let lineNo = 0;
  for (const line of String(diffText).split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      pending = m ? unquotePath(m[2]) : null;
      current = null;
      lineNo = 0;
      continue;
    }
    if (line.startsWith('rename to ')) { pending = unquotePath(line.slice(10)); continue; }
    if (line.startsWith('--- ')) {
      if (pending && line.slice(4) === '/dev/null') entry(pending).isNew = true;
      continue;
    }
    if (line.startsWith('+++ ')) {
      const p = line.slice(4);
      if (p === '/dev/null') {
        if (pending) entry(pending).isDeleted = true;
        current = null;
      } else {
        pending = unquotePath(p.startsWith('b/') ? p.slice(2) : p);
        current = entry(pending);
      }
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      lineNo = Number(hunk[1]);
      if (!current && pending) current = entry(pending);
      continue;
    }
    if (!current || lineNo === 0) continue;
    if (line.startsWith('+')) { current.addedLines.add(lineNo); current.addedText.push(line.slice(1)); lineNo += 1; }
    else if (line.startsWith('-')) current.removedText.push(line.slice(1));
    else if (line.startsWith('\\')) { /* "\ No newline at end of file" */ }
    else lineNo += 1;
  }
  return files;
}

// ---------------------------------------------------------------------------
// Skip-marker extraction from a test file (TypeScript AST)
// ---------------------------------------------------------------------------

/** Resolve a call's callee chain: root identifier + property members seen. */
function calleeChain(expression) {
  let node = expression;
  const members = [];
  while (node) {
    if (ts.isCallExpression(node)) { node = node.expression; continue; }
    if (ts.isPropertyAccessExpression(node)) { members.push(node.name.text); node = node.expression; continue; }
    if (ts.isIdentifier(node)) return { root: node, members };
    return null;
  }
  return null;
}

function literalTitle(node) {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return { title: node.text, literal: node.getText() };
  }
  return undefined; // present but not literal
}

/**
 * @returns {Array<{kind:'skip'|'todo'|'focused', title:string|null, literal:string|null,
 *   full:string|null, line:number}>} every .skip/.skipIf/.todo/.only/x-prefixed marker.
 */
export function collectSkips(fileName, source) {
  const sf = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true);
  const markers = [];
  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      // Only the outermost call of a registration: `it.each(xs)` inside
      // `it.each(xs)('t')` and `it.skipIf(c)` inside `it.skipIf(c)('t')` are
      // callee positions, not the marker itself.
      const inCalleePosition = ts.isCallExpression(node.parent) && node.parent.expression === node;
      if (!inCalleePosition) {
        const chain = calleeChain(node.expression);
        if (chain && CALLEE_ROOTS.has(chain.root.text)) {
          let kind = null;
          if (chain.members.includes('only') || chain.root.text === 'fit' || chain.root.text === 'fdescribe') kind = 'focused';
          else if (chain.members.includes('todo')) kind = 'todo';
          else if (chain.members.some((m) => SKIP_MEMBERS.has(m)) || chain.root.text.startsWith('x')) kind = 'skip';
          if (kind) {
            const arg = literalTitle(node.arguments[0]);
            const prefix = [];
            let p = node.parent;
            while (p) {
              if (ts.isCallExpression(p)) {
                const parent = calleeChain(p.expression);
                if (parent && DESCRIBE_ROOTS.has(parent.root.text)) {
                  const dt = literalTitle(p.arguments[0]);
                  if (dt) prefix.unshift(dt.title);
                }
              }
              p = p.parent;
            }
            const line = sf.getLineAndCharacterOfPosition(chain.root.getStart()).line + 1;
            markers.push({
              kind,
              title: arg ? arg.title : null,
              literal: arg ? arg.literal : null,
              full: arg ? [...prefix, arg.title].join(' > ') : null,
              line,
            });
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return markers;
}

// ---------------------------------------------------------------------------
// The verifier (pure; file reads injected)
// ---------------------------------------------------------------------------

const push = (violations, code, message, file, line) => violations.push({ code, message, ...(file ? { file } : {}), ...(line ? { line } : {}) });

/**
 * Verify a change's added skip markers against the quarantine ledger.
 * @param {{ diffText?: string|null, untrackedFiles?: string[], ledgerText?: string,
 *   readFile?: (repoPath: string) => (string|null|undefined), now?: number,
 *   repo?: string, ledgerPath?: string }} input
 *   `diffText` a unified diff (null = ledger-only validation); `readFile` reads a
 *   repo-relative file at its post-change state and returns text or null.
 * @returns {{ ok: boolean, repo: string, violations: object[], markers: object[],
 *   rows: { total: number, valid: number, expired: number, invalid: number } }}
 */
export function verifyQuarantine({ diffText = null, untrackedFiles = [], ledgerText = '', readFile = () => null, now = Date.now(), repo = DEFAULT_REPO, ledgerPath = LEDGER_PATH } = {}) {
  const violations = [];
  const markers = [];

  let ledger;
  try {
    ledger = parseLedger(ledgerText, { now });
    if (!ledger.headerOk) {
      push(violations, 'invalid-ledger', `${ledgerPath}: first non-comment line must be the header "test repo lead expiry"`, ledgerPath);
    }
  } catch (error) {
    need(error instanceof InputError, 'unreachable');
    push(violations, 'invalid-ledger', `${ledgerPath}: ${error.message}`, ledgerPath);
    ledger = { headerOk: false, rows: [] };
  }

  const files = diffText === null ? new Map() : parseUnifiedDiff(diffText);
  need(files.size <= LIMITS.files, `diff touches more than ${LIMITS.files} files`);
  for (const file of untrackedFiles) {
    if (!files.has(file)) files.set(file, { path: file, addedLines: new Set(), addedText: [], removedText: [], isNew: true, isDeleted: false, allAdded: true });
    else files.get(file).allAdded = true;
  }

  // Which ledger rows this change adds (for the only-additions rule).
  const ledgerEntry = files.get(ledgerPath);
  const addedRowText = new Set((ledgerEntry?.addedText ?? []).map((line) => line.trim()).filter((line) => line && !line.startsWith('#')));
  for (const row of ledger.rows) row.added = !!(ledgerEntry && (ledgerEntry.allAdded || ledgerEntry.isNew)) || addedRowText.has(row.text);

  const fileMarkers = new Map();
  const markersOf = (file) => {
    if (!fileMarkers.has(file)) {
      const source = readFile(file);
      fileMarkers.set(file, typeof source === 'string' ? collectSkips(file, source) : []);
    }
    return fileMarkers.get(file);
  };

  const covers = (row, marker) => row.file === marker.file &&
    (row.name === null || row.name === marker.full);
  const rowCovers = (row) => {
    if (!TEST_FILE.test(row.file)) return false;
    return markersOf(row.file).some((marker) => covers(row, { ...marker, file: row.file }));
  };
  const validRows = ledger.rows.filter((row) => row.state === 'valid');
  const expiredRows = ledger.rows.filter((row) => row.state === 'expired');

  // --- Marker checks: every skip added by the change --------------------------
  for (const file of files.values()) {
    if (file.isDeleted || !TEST_FILE.test(file.path)) continue;
    const source = readFile(file.path);
    if (typeof source !== 'string') {
      // Fail closed: a test file we cannot read can still hide an added marker.
      for (const line of file.addedText) {
        if (DEGRADED_MARKER.test(line)) {
          push(violations, 'unverifiable-skip', `${file.path}: added skip marker in an unreadable test file — a skip is allowed only with a tracked ledger row`, file.path);
        }
      }
      continue;
    }
    for (const marker of collectSkips(file.path, source)) {
      if (!(file.allAdded || file.addedLines.has(marker.line))) continue;
      const where = `${file.path}:${marker.line}`;
      const record = { file: file.path, line: marker.line, kind: marker.kind, name: marker.full, status: null };
      markers.push(record);
      if (marker.kind === 'focused') {
        record.status = 'focused';
        push(violations, 'focused-test', `${where}: .only added — a focused test silently unschedules every other test and cannot be quarantined`, file.path, marker.line);
        continue;
      }
      if (isProtected(file.path) || (marker.full && isProtected(marker.full))) {
        record.status = 'non-quarantinable';
        push(violations, 'non-quarantinable', `${where}: "${marker.full ?? file.path}" names a check that can never be quarantined (${NON_QUARANTINABLE.join(', ')})`, file.path, marker.line);
        continue;
      }
      if (!marker.literal) {
        record.status = 'dynamic-title';
        push(violations, 'dynamic-title', `${where}: skip marker has no literal title — no ledger row could ever name it`, file.path, marker.line);
        continue;
      }
      const conversion = file.removedText.some((line) => line.includes(marker.literal) && CALLEE_CALL.test(line));
      if (!conversion) {
        record.status = 'addition-only';
        push(violations, 'addition-only-skip', `${where}: "${marker.full}" is only an addition — quarantine retires a running test, it does not land a born-disabled one`, file.path, marker.line);
        continue;
      }
      if (validRows.some((row) => row.repo === repo && covers(row, { file: file.path, full: marker.full }))) {
        record.status = 'tracked';
      } else if (expiredRows.some((row) => row.repo === repo && covers(row, { file: file.path, full: marker.full }))) {
        record.status = 'expired';
        push(violations, 'expired-skip', `${where}: "${marker.full}" is covered only by an expired ledger row — renew the row or unskip the test`, file.path, marker.line);
      } else {
        record.status = 'untracked';
        push(violations, 'untracked-skip', `${where}: "${marker.full}" was silenced without a tracked row in ${ledgerPath} (test, repo, lead, expiry within 7 days)`, file.path, marker.line);
      }
    }
  }

  // --- Row checks: every row must be live -------------------------------------
  for (const row of ledger.rows) {
    const where = `${ledgerPath}:${row.line}`;
    if (row.state === 'invalid') {
      push(violations, 'invalid-row', `${where}: ${row.reason}`, ledgerPath, row.line);
      continue;
    }
    if (isProtected(row.test) || (row.name && isProtected(row.name))) {
      push(violations, 'non-quarantinable', `${where}: row names a check that can never be quarantined (${NON_QUARANTINABLE.join(', ')})`, ledgerPath, row.line);
      continue;
    }
    if (row.state === 'expired') {
      push(violations, 'expired-row', `${where}: row for "${row.test}" expired at ${row.expiry} — renew it or delete it with its marker`, ledgerPath, row.line);
      continue;
    }
    if (row.repo !== repo) continue; // foreign rows: shape-checked only
    if (!rowCovers(row)) {
      const code = row.added ? 'only-additions' : 'stale-row';
      const detail = row.added
        ? 'is only an addition — a row may be added only together with, or for, a live skip marker'
        : `covers no live skip marker — remove it or restore the marker it tracks`;
      push(violations, code, `${where}: row "${row.test}" ${detail}`, ledgerPath, row.line);
    }
  }

  return {
    ok: violations.length === 0,
    repo,
    violations,
    markers,
    rows: {
      total: ledger.rows.length,
      valid: validRows.length,
      expired: expiredRows.length,
      invalid: ledger.rows.filter((row) => row.state === 'invalid').length,
    },
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export const USAGE = `usage: node scripts/check-quarantine-ledger.mjs [options]

  --base REF      verify "git diff REF" plus untracked files against the ledger
  --diff FILE     verify a stored unified diff ("-" reads stdin)
  --ledger PATH   quarantine ledger file (default ${LEDGER_PATH})
  --repo NAME     owner/name this tree is gated as (default ${DEFAULT_REPO})
  --now ISO       verify as of a fixed instant (testing)
  --json          machine-readable result on stdout
  -h, --help      this help

With neither --base nor --diff the ledger file is validated alone.`;

function git(args, cwd) {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: LIMITS.diffBytes });
  need(res.status === 0, `git ${args.join(' ')} failed: ${(res.stderr || '').trim() || `exit ${res.status}`}`);
  return res.stdout;
}

function readBounded(path, maximum) {
  const stat = lstatSync(path);
  need(stat.isFile() && !stat.isSymbolicLink() && stat.size <= maximum, `${path}: expected a regular file under ${maximum} bytes`);
  return readFileSync(path, 'utf8');
}

export function main(argv, { cwd = repoRoot, stdout = console.log, stderr = console.error, now = Date.now() } = {}) {
  const args = { base: null, diff: null, ledger: LEDGER_PATH, repo: DEFAULT_REPO, json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const take = () => {
      const value = argv[i + 1];
      need(value !== undefined && !value.startsWith('--'), `${arg} needs a value`);
      i += 1;
      return value;
    };
    if (arg === '-h' || arg === '--help') { stdout(USAGE); return 0; }
    else if (arg === '--base') args.base = take();
    else if (arg === '--diff') args.diff = take();
    else if (arg === '--ledger') args.ledger = take();
    else if (arg === '--repo') { args.repo = take(); need(REPO_SHAPE.test(args.repo), '--repo must be owner/name'); }
    else if (arg === '--now') { args.now = take(); need(Number.isFinite(Date.parse(args.now)), '--now must be an ISO timestamp'); }
    else if (arg === '--json') args.json = true;
    else throw new InputError(`unknown argument ${arg}`);
  }
  need(!(args.base && args.diff), 'use --base or --diff, not both');
  need(!isAbsolute(args.ledger) && validRepoPath(args.ledger), '--ledger must be a repo-relative path');
  if (args.now) now = Date.parse(args.now);

  let diffText = null;
  const untracked = [];
  if (args.diff) {
    diffText = args.diff === '-' ? readFileSync(0, 'utf8') : readBounded(resolve(cwd, args.diff), LIMITS.diffBytes);
  } else if (args.base) {
    diffText = git(['diff', '--find-renames', args.base], cwd);
    untracked.push(...git(['ls-files', '--others', '--exclude-standard'], cwd).split('\n').map((l) => l.trim()).filter(Boolean));
  }

  const ledgerAbs = resolve(cwd, args.ledger);
  let ledgerText = '';
  try {
    ledgerText = readBounded(ledgerAbs, LIMITS.ledgerBytes);
  } catch {
    // A missing ledger covers nothing: every added skip is untracked.
  }
  const root = realpathSync(cwd);
  const readFile = (repoPath) => {
    try {
      return readBounded(join(root, repoPath), LIMITS.fileBytes);
    } catch {
      return null;
    }
  };

  const result = verifyQuarantine({ diffText, untrackedFiles: untracked, ledgerText, readFile, now, repo: args.repo, ledgerPath: args.ledger });

  if (args.json) {
    stdout(JSON.stringify(result, null, 2));
  } else {
    for (const v of result.violations) stderr(`${v.code}  ${v.message}`);
    const tracked = result.markers.filter((m) => m.status === 'tracked').length;
    const summary = `quarantine: ${result.violations.length} violation(s), ${tracked} tracked skip(s), ledger ${result.rows.valid} valid/${result.rows.expired} expired/${result.rows.invalid} invalid row(s)`;
    (result.ok ? stdout : stderr)(summary);
  }
  return result.ok ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(`check-quarantine-ledger: ${error instanceof InputError ? error.message : 'input could not be verified'}`);
    process.exitCode = 2;
  }
}
