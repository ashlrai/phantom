import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, posix } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import type { CloudGh } from '../cloud/pr-actions.js';
import { globMatches } from '../authority/protected-paths.js';
import { scrubSecrets } from '../util/scrub.js';
import { defaultCiGh } from './ci-failure-groups.js';
import { nextFixGeneration } from './ci-fix-generations.js';

type Failure = { testId: string; file: string; names: string; excerpt: string };
type Pr = { number: number; headRefOid: string; headRefName: string; files: { path: string }[] };
type Run = { id: number; head_sha: string; workflow_id: number; status: string; conclusion?: string };
type Job = { id: number; conclusion: string; head_sha: string };
type Observation = { pr: Pr; failure: Failure; touched: boolean | null; runId: number };

// Job conclusions that mean the check never reached a verdict: cancelled,
// timed out, awaiting action, failed to start, or marked stale. Their logs
// may be partial or absent, so they are incomplete evidence — the run
// cannot prove the ref's checks and reads unknown, never clean. `skipped`
// and `neutral` are deliberate non-verdicts (path filters, `if:` gates,
// required-check-neutral), not incomplete checks, and stay ignored.
const INCOMPLETE_CONCLUSIONS = new Set(['cancelled', 'timed_out', 'action_required', 'startup_failure', 'stale']);

const clean = (s: string) => scrubSecrets(stripVTControlCharacters(s)).slice(0, 2000);
const lines = (s: string) => stripVTControlCharacters(s).split('\n').map(l => l.replace(/^\d{4}-\d\d-\d\dT\S+\s+/, '').trim());

// Vitest runs under named projects (unit, real-io, serial-cpu on the backend;
// console, transcript on the web console), so failure and verbose pass lines
// carry a `|project|` label between the marker and the repo-relative test
// path. The vitest suites live under `test/` and `src/web-ui/`.
const FAIL_LINE = /^FAIL\s+(?:\|[^|]*\|\s+)?((?:test|src\/web-ui)\/[^\s>]+\.test\.[cm]?[jt]sx?)\s*>\s*(.+)$/;
// A suite that fails to load (transform, parse, or top-level throw during
// collection) never reaches a test, so vitest prints `FAIL  <file> [ <file> ]`
// with no `> name`. Without this shape those failures are invisible: every PR
// reads unknown and no master fix is ever queued for a broken suite.
const SUITE_FAIL_LINE = /^FAIL\s+(?:\|[^|]*\|\s+)?((?:test|src\/web-ui)\/[^\s>]+\.test\.[cm]?[jt]sx?)\s+\[[^\]]*\]\s*$/;
const SUITE_NAMES = '(suite)';
const PASS_LINE = /^[\u2713\u2714\u221a]\s+(?:\|[^|]*\|\s+)?((?:test|src\/web-ui)\/\S+)\s*>\s*(.+?)(?:\s+\d+(?:\.\d+)?m?s)?$/;

// The default reporter emits no per-test pass line for a green file; it
// summarizes the whole module instead:
//   ✓ |unit| test/example.test.ts (4 tests) 4ms
// A green module means every test it contains passed on that run -- the
// finest pass evidence the default reporter produces.
const FILE_PASS_LINE = /^[✓✔√]\s+(?:\|[^|]*\|\s+)?((?:test|src\/web-ui)\/[^\s>]+\.test\.[cm]?[jt]sx?)\s+\(\d+ tests?(?:\s*\|[^)]*)?\)(?:\s+\d+(?:\.\d+)?m?s)?$/;

// .github/scripts/ci-source-binding.mjs verifies `git rev-parse HEAD` equals
// the candidate revision and prints this receipt in every bound CI job:
//   Bound candidate <sha> to event tree <tree>
//   Bound candidate <sha> to event merge <sha> of base <sha>...
const BOUND_LINE = /^Bound candidate ([a-f0-9]{40}) to event (?:tree|merge) [a-f0-9]{40}/;

// Gate jobs that never run ci-source-binding.mjs (secret-shape, quick,
// clean-tree, authority-drift, fast-gate, secret-scan, the whole
// dependency-audit job) still prove their checkout through the runner's
// own echo of the checkout step's resolved inputs:
//
//   ##[group]Run actions/checkout@<pinned>
//   with:
//     ref: <resolved sha>
//     ...
//   ##[endgroup]
//
// Every analyzed `ref:` expression (`pull_request.head.sha`,
// `merge_group.head_sha`, `github.sha`) resolves to the run's head SHA, so
// the echo verifies exactly like the binding receipt -- but only when the
// log records at least one checkout and every checkout step pins `ref:` to
// that head. A checkout pinned to a branch, tag or PR ref resolves to a
// non-SHA value and never verifies; an unpinned checkout falls back to the
// event default (the merge commit on pull_request), and a second checkout
// of anything else makes the workspace ambiguous, so either leaves the
// job unverifiable.
const CHECKOUT_GROUP = /^##\[group\]Run actions\/checkout@\S/;
const CHECKOUT_GROUP_END = '##[endgroup]';
const CHECKOUT_WITH = 'with:';
const CHECKOUT_ENV = 'env:';
const CHECKOUT_REF = /^ref:\s*([a-f0-9]{40})$/;

function checkoutRefsVerify(output: string[], head: string): boolean {
  let groups = 0;
  let bad = false;
  let inCheckout = false;
  let inWith = false;
  let ref: string | null = null;
  const close = () => {
    if (!inCheckout) return;
    groups++;
    if (ref !== head) bad = true;
    inCheckout = false;
    inWith = false;
    ref = null;
  };
  for (const line of output) {
    if (CHECKOUT_GROUP.test(line)) {
      close();
      inCheckout = true;
      continue;
    }
    if (!inCheckout) continue;
    if (line === CHECKOUT_GROUP_END) {
      close();
      continue;
    }
    if (line === CHECKOUT_WITH) {
      inWith = true;
      continue;
    }
    if (inWith && line === CHECKOUT_ENV) {
      inWith = false;
      continue;
    }
    if (!inWith) continue;
    const found = CHECKOUT_REF.exec(line);
    if (found !== null) ref = found[1]!;
  }
  close();
  return groups > 0 && !bad;
}

// TypeScript diagnostics (tsc/tsgo non-pretty output, identical in CI) name a
// repo-relative file, position and diagnostic code:
//   src/core/foo.ts(41,9): error TS2322: Type 'string' is not assignable ...
// A typecheck or build break prints no vitest FAIL lines, so without this
// shape a red master marks every open PR unknown and queues no fix. Errors
// group per file under a `(typecheck)` identity: the file is the unit a
// master fix restores, positions shift as soon as any fix lands, and a
// vitest pass line can never resolve one -- a typecheck error is not a flake.
const TSC_ERROR_LINE = /^([^\s()]+)\(\d+,\d+\):\s*error\s+TS\d{4}:/;
const TSC_NAMES = '(typecheck)';

// The .github/tests/*.test.mjs contract suites run under `node --test`, which
// on the Node 22 CI image emits TAP: every result is an `ok|not ok N - name`
// line at the subtest's indent followed by a YAML-ish diagnostic block with
// `type` ('test'|'suite'), an absolute `location:` path, `failureType` and
// `error`. `# Subtest:` comments re-announce each subtest at the same indent,
// so nested describe paths rebuild as `suite > test > leaf`. Passing results
// carry no location, so TAP evidence can fail a suite but never prove an
// individual pass: these groups classify shared-baseline, pr-caused or
// unknown only. The absolute location resolves against the Actions checkout
// convention `/<work>/<repo>/<repo>/`; anything else stays unparsed.
const TAP_RESULT = /^(\s*)(not ok|ok)\s+\d+\s+-\s+(.*?)\s*$/;
const TAP_SUBTEST = /^\s*# Subtest:\s*(.+?)\s*$/;
const TAP_STREAM = /^\s*TAP version \d+/;
const TAP_COMMENT = /^\s*#(.*)$/;
const TAP_SCALAR = /^\s*[A-Za-z_$][\w$]*:\s*[|>][-+]?\d?\s*$/;
const TAP_FIELD = /^([A-Za-z_$][\w$]*):\s*(.*)$/;

const tapIndent = (line: string) => line.length - line.trimStart().length;
const unquote = (value: string | undefined) => {
  if (value === undefined) return undefined;
  const quoted = /^'(.*)'$/.exec(value) ?? /^"(.*)"$/.exec(value);
  return quoted ? quoted[1] : value;
};

// Diagnostics for one result live in the block after its line: keys sit two
// spaces deeper than the result, block-scalar bodies deeper still, and the
// first non-blank line back at or above the result indent ends the block.
function tapBlock(lines: string[], start: number, indent: number) {
  const fields = new Map<string, string>();
  let error = '';
  let end = start;
  for (; end < lines.length && end - start < 200; end++) {
    const line = lines[end]!;
    if (line.trim() !== '' && tapIndent(line) <= indent) break;
  }
  for (let k = start; k < end; k++) {
    const line = lines[k]!;
    if (tapIndent(line) !== indent + 2) continue;
    const field = TAP_FIELD.exec(line.trim());
    if (!field) continue;
    const key = field[1]!, raw = field[2]!.trim();
    if ((key === 'error' || key === 'stack') && /^[|>]/.test(raw)) {
      if (key !== 'error') continue;
      const body: string[] = [];
      for (let x = k + 1; x < end; x++) {
        const bodyLine = lines[x]!;
        if (bodyLine.trim() !== '' && tapIndent(bodyLine) <= indent + 2) break;
        body.push(bodyLine.trim());
      }
      error = body.join('\n').trim();
      continue;
    }
    fields.set(key, raw);
  }
  return { fields, error };
}

// `location:` is an absolute runner path (`.../<repo>/<repo>/<path>:L:C` on
// GitHub-hosted and default self-hosted Actions images). Only the doubled
// repo-name checkout marker resolves to a repo-relative path; anything else
// is left unparsed rather than guessed.
function tapRepoFile(location: string | undefined, repo: string | undefined): string | null {
  const raw = unquote(location);
  if (!raw) return null;
  let path = raw.replace(/\\/g, '/');
  if (path.startsWith('file://')) path = path.slice('file://'.length);
  const lineCol = /:\d+:\d+$/.exec(path);
  if (lineCol) path = path.slice(0, lineCol.index);
  const repoName = repo?.split('/')[1];
  if (!repoName) return null;
  const marker = `/${repoName}/${repoName}/`;
  const at = path.indexOf(marker);
  if (at < 0) return null;
  const rel = path.slice(at + marker.length);
  if (!rel || posix.normalize(rel) !== rel || rel.includes('..') || posix.isAbsolute(rel)) return null;
  return rel;
}

// A file-level failure (the test file's own process died: syntax error, throw
// at module load) is reported as a pseudo-test named by its invocation path at
// `:1:1` with an `exitCode` and `error: 'test failed'`; it groups under the
// same `(suite)` identity as a vitest suite-load failure.
function isTapFileResult(file: string, title: string, fields: Map<string, string>): boolean {
  const location = unquote(fields.get('location')) ?? '';
  if (!/:1:1$/.test(location)) return false;
  const name = posix.normalize(title);
  const titleMatch = name === file || name === posix.basename(file) || file.endsWith(`/${name}`) || name.endsWith(`/${file}`);
  const placeholder = fields.has('exitCode') && unquote(fields.get('error')) === 'test failed';
  return titleMatch || placeholder;
}

function parseTapFailures(log: string, repo: string | undefined): Failure[] {
  const out: Failure[] = [];
  const rawLines = stripVTControlCharacters(log).split('\n')
    // Timestamped job-log lines keep the result's own indentation: strip the
    // stamp and its single separating space only, or every nested `not ok`
    // collapses to column 0 and the suite hierarchy flattens away.
    .map(l => l.replace(/^\d{4}-\d\d-\d\dT\S+ /, ''));
  const pending = new Map<number, string>();
  const comments: string[] = [];
  let scalarIndent = -1;
  for (let i = 0; i < rawLines.length && out.length < 100; i++) {
    const line = rawLines[i]!;
    if (scalarIndent >= 0) {
      if (line.trim() === '' || tapIndent(line) > scalarIndent) continue;
      scalarIndent = -1;
    }
    if (TAP_STREAM.test(line)) { pending.clear(); comments.length = 0; continue; }
    const subtest = TAP_SUBTEST.exec(line);
    if (subtest !== null) {
      const indent = tapIndent(line);
      pending.set(indent, subtest[1]!.trim());
      for (const key of [...pending.keys()]) if (key > indent) pending.delete(key);
      continue;
    }
    const result = TAP_RESULT.exec(line);
    if (result !== null) {
      const indent = tapIndent(line);
      const title = result[3]!.trim();
      // A result closes its own level and every deeper open subtest.
      for (const key of [...pending.keys()]) if (key >= indent) pending.delete(key);
      const priorComments = comments.splice(0);
      if (result[2] === 'ok' || title === '') continue;
      const { fields, error } = tapBlock(rawLines, i + 1, indent);
      const type = unquote(fields.get('type'));
      const failureType = unquote(fields.get('failureType'));
      // cancelledByParent marks tests skipped because an ancestor suite
      // failed; subtestsFailed marks that ancestor. Both are derivative --
      // the suite's own hookFailed/testCodeFailure result carries the cause.
      if (failureType === 'cancelledByParent') continue;
      if (type === 'suite' && (failureType === undefined || failureType === 'subtestsFailed')) continue;
      if (type !== 'test' && type !== 'suite') continue;
      const file = tapRepoFile(fields.get('location'), repo);
      if (file === null) continue;
      const fileLevel = isTapFileResult(file, title, fields);
      const names = fileLevel ? SUITE_NAMES
        : [...[...pending.entries()].filter(([key]) => key < indent).sort((a, b) => a[0] - b[0]).map(([, name]) => name), title].join(' > ');
      const parts = [line.trim()];
      if (error) parts.push(error);
      else {
        const inline = unquote(fields.get('error'));
        if (inline && inline !== 'test failed') parts.push(inline);
      }
      if (fileLevel) {
        // A module-load failure reports only `error: 'test failed'`; the real
        // diagnostic is the runner's `#` comment block just above it.
        const tail: string[] = [];
        for (let x = priorComments.length - 1; x >= 0 && tail.length < 5; x--) {
          const comment = priorComments[x]!;
          if (!/^Node\.js v/.test(comment)) tail.unshift(comment);
        }
        if (tail.length) parts.push(tail.join('\n'));
      }
      out.push({ file, names, testId: `${file} > ${names}`, excerpt: clean(parts.join('\n')) });
      continue;
    }
    if (TAP_SCALAR.test(line)) { scalarIndent = tapIndent(line); continue; }
    const comment = TAP_COMMENT.exec(line);
    if (comment !== null) {
      comments.push(comment[1]!.trim());
      if (comments.length > 12) comments.shift();
    }
  }
  return out;
}

// `check:docs` (scripts/check-documentation.mjs) prints its whole verdict as
// one pretty-printed JSON document -- `{` at column 0, `}` at column 0 -- and
// exits 1 when `ok` is false. A broken documentation link on master fails the
// ci and docs jobs on every open PR, but no vitest, typecheck or TAP line
// names the file, so without this shape a red master marked every PR unknown
// and queued no fix. Errors group per entrypoint under a `(docs-check)`
// identity: the file is the unit a master fix restores, and like `(typecheck)`
// it can never resolve through a vitest pass line, so these groups classify
// shared-baseline, pr-caused or unknown -- never probable-flake. Passing
// reports carry an empty errors array; malformed blocks and unrelated JSON
// stay unparsed.
const DOCS_CHECK_NAMES = '(docs-check)';
const DOCS_CHECK_ERRORS_PER_FILE = 8;

function parseDocsCheckFailures(log: string): Failure[] {
  const out: Failure[] = [];
  // Timestamped job-log lines keep the document's own indentation: the strip
  // removes the stamp and its single separating space only, so a nested `}`
  // can never collapse into the column-0 close that ends the report.
  const raw = stripVTControlCharacters(log).split('\n')
    .map(l => l.replace(/^\d{4}-\d\d-\d\dT\S+ /, '').replace(/\r$/, ''));
  const byFile = new Map<string, string[]>();
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== '{' || !/"ok"\s*:/.test(raw[i + 1] ?? '')) continue;
    let end = i + 1;
    while (end < raw.length && end - i < 20000 && raw[end] !== '}') end++;
    if (end >= raw.length || raw[end] !== '}') continue;
    const block = raw.slice(i, end + 1).join('\n');
    i = end;
    let doc: unknown;
    try { doc = JSON.parse(block); } catch { continue; }
    const report = doc as { ok?: unknown; mode?: unknown; errors?: unknown } | null;
    if (typeof report?.ok !== 'boolean' || (report.mode !== 'source' && report.mode !== 'package') || !Array.isArray(report.errors)) continue;
    for (const entry of report.errors as unknown[]) {
      const e = entry as { file?: unknown; href?: unknown; reason?: unknown } | null;
      if (typeof e?.file !== 'string' || typeof e.reason !== 'string' || (e.href !== null && typeof e.href !== 'string')) continue;
      const file = e.file;
      if (posix.normalize(file) !== file || file.includes('..') || posix.isAbsolute(file)) continue;
      const parts = byFile.get(file) ?? [];
      if (parts.length < DOCS_CHECK_ERRORS_PER_FILE) parts.push(typeof e.href === 'string' && e.href !== '' ? `${e.href}: ${e.reason}` : e.reason);
      byFile.set(file, parts);
    }
  }
  for (const [file, parts] of byFile) {
    out.push({ file, names: DOCS_CHECK_NAMES, testId: `${file} > ${DOCS_CHECK_NAMES}`, excerpt: clean(parts.join('\n')) });
  }
  return out;
}

// The Merge Gate "Check generated files" job (clean-tree) reruns the
// tracked-file generators -- canonical launcher digests, docs/llms.txt and
// friends -- then fails on any dirty `git status --porcelain` path:
//   generated files are stale; commit the regenerated tree:
//    M docs/llms.txt
// Porcelain v1 rows are `XY <path>`: staged/unstaged/unmerged status pairs,
// `??` untracked, `R`/`C` renames printed as `XY <old> -> <new>`, and
// C-quoted paths when names carry specials. Each stale path groups under a
// `<file> > (generated)` identity: regenerating and committing the artifact
// is the unit a master fix restores. The same step's
// `canonical-launcher-digests.mjs --check` prints
// `current launcher digest <sha> is missing from the canonical launcher
// digest list` or `canonical launcher digest list is invalid`; the manifest
// that must be regenerated is the failure file, and `bin/ashlr` is its only
// content input. Like `(typecheck)` and `(docs-check)`, no vitest pass line
// can name these identities, so they classify shared-baseline, pr-caused or
// unknown -- never probable-flake.
const GENERATED_NAMES = '(generated)';
const GENERATED_DIGEST_FILE = 'scripts/canonical-launcher-digests.json';
// Static generator inputs per generated artifact. docs/llms.txt additionally
// depends on every public docs page, which dependencies() unions from the
// master tree listing at analysis time.
const GENERATED_FILE_INPUTS: Record<string, readonly string[]> = {
  'docs/llms.txt': ['docs/llms-source.txt', 'scripts/generate-docs-llms.mjs', 'scripts/lib/docs-pages.mjs'],
  [GENERATED_DIGEST_FILE]: ['bin/ashlr'],
};
const GENERATED_STALE_MARKER = /^\s*generated files are stale\b/;
const GENERATED_PORCELAIN = /^([ MADRCU?!]{2}) (.+)$/;
const GENERATED_DIGEST_LINE = /^(?:current launcher digest [a-f0-9]{64} is missing from the canonical launcher digest list|canonical launcher digest list is invalid|canonical launcher digest list differs from bin\/ashlr history)/;

// Git C-quotes a path containing specials and escapes `"`, `\`, newline, tab
// and return inside the quotes; octal byte escapes are left unparsed rather
// than guessed at.
function cUnquote(value: string): string | null {
  let out = '';
  for (let i = 1; i < value.length - 1; i++) {
    const c = value[i]!;
    if (c !== '\\') { out += c; continue; }
    const n = value[++i];
    if (n === 'n') out += '\n';
    else if (n === 't') out += '\t';
    else if (n === 'r') out += '\r';
    else if (n === '"' || n === '\\') out += n;
    else return null;
  }
  return out;
}

// Porcelain prints renames/copies as `<old> -> <new>` with each side
// C-quoted independently; a plain `M `/`??` row never contains the separator,
// so ` -> ` inside such a name stays part of the path. The separator itself
// is only trusted outside quotes.
function generatedPath(raw: string, rename: boolean): string | null {
  let path = raw.trim();
  if (rename) {
    let inQuote = false, escaped = false, split = -1;
    for (let i = 0; i + 3 < path.length; i++) {
      const c = path[i]!;
      if (escaped) { escaped = false; continue; }
      if (inQuote && c === '\\') { escaped = true; continue; }
      if (c === '"') { inQuote = !inQuote; continue; }
      if (!inQuote && path.startsWith(' -> ', i)) split = i;
    }
    if (split < 0) return null;
    path = path.slice(split + 4).trim();
  }
  if (path.length >= 2 && path.startsWith('"') && path.endsWith('"')) {
    const unquoted = cUnquote(path);
    if (unquoted === null) return null;
    path = unquoted;
  } else if (path.includes('"') || path.includes('\\')) return null;
  if (!path || posix.normalize(path) !== path || path.includes('..') || posix.isAbsolute(path)) return null;
  return path;
}

function parseGeneratedFailures(log: string): Failure[] {
  const out: Failure[] = [];
  // Timestamped job-log lines keep the porcelain row's own leading status
  // column: strip the stamp and its single separating space only, the same
  // convention as the check:docs report parser.
  const raw = stripVTControlCharacters(log).split('\n')
    .map(l => l.replace(/^\d{4}-\d\d-\d\dT\S+ /, '').replace(/\r$/, ''));
  for (let i = 0; i < raw.length && out.length < 100; i++) {
    const line = raw[i]!;
    if (GENERATED_DIGEST_LINE.test(line.trim())) {
      out.push({ file: GENERATED_DIGEST_FILE, names: GENERATED_NAMES, testId: `${GENERATED_DIGEST_FILE} > ${GENERATED_NAMES}`, excerpt: clean(line.trim()) });
      continue;
    }
    if (!GENERATED_STALE_MARKER.test(line)) continue;
    for (let k = i + 1; k < raw.length && out.length < 100; k++) {
      const row = GENERATED_PORCELAIN.exec(raw[k]!);
      if (row === null) break;
      const path = generatedPath(row[2]!, row[1]!.includes('R') || row[1]!.includes('C'));
      if (path === null) continue;
      out.push({ file: path, names: GENERATED_NAMES, testId: `${path} > ${GENERATED_NAMES}`, excerpt: clean(raw[k]!) });
    }
  }
  return out;
}

// `npm run build` opens with `npm run check:version`
// (scripts/sync-candidate-version.mjs --check), the release-metadata gate.
// A version bump that reached only some of the tracked files prints one
// compact JSON drift report on stdout and exits 1:
//   {"version":"1.2.3","changed":["package-lock.json"],"matches":false,"check":true}
// naming the stale files; a structural break (missing file, renamed field,
// ambiguous URL) throws instead and prints `sync-candidate-version:
// <message>` on stderr. Either way every job that builds goes red on
// master, but no vitest, typecheck or TAP line names it. Both shapes group
// under the gate script as `scripts/sync-candidate-version.mjs >
// (version-sync)`: the check reads exactly the script and the metadata
// files it rewrites -- VERSION_SYNC_INPUTS, mirrored from the script's
// file list -- so that closed set, not the vitest harness ambient deps,
// decides touched. Like the other non-test identities it can never
// resolve through a vitest pass line: shared-baseline, pr-caused or
// unknown, never probable-flake. Passing reports (`matches: true`),
// write-mode results, empty or unknown `changed` entries, non-semver
// versions, malformed or multi-line JSON and unrelated output stay
// unparsed.
const VERSION_SYNC_FILE = 'scripts/sync-candidate-version.mjs';
const VERSION_SYNC_NAMES = '(version-sync)';
const VERSION_SYNC_INPUTS = [
  'package.json', 'package-lock.json', 'desktop/package.json',
  'desktop/src-tauri/tauri.conf.json', 'desktop/src-tauri/Cargo.toml',
  'desktop/src-tauri/Cargo.lock', 'server.json',
  'desktop/README.md', 'README.md', 'docs/QUICKSTART.md',
] as const;
const VERSION_SYNC_KNOWN = new Set<string>(VERSION_SYNC_INPUTS);
const VERSION_SYNC_SEMVER = /^\d+\.\d+\.\d+$/;
const VERSION_SYNC_PREFIX = 'sync-candidate-version: ';
const VERSION_SYNC_MAX = 4;

// `npm run build` opens with check:version and tsc -- both parsed above --
// then runs five node helpers and `vite build` (ci.yml's Build step, and
// the `npm ci && npm run build` preambles in perf-budget.yml and
// companion-smoke.yml). Each helper's failure output names itself:
// authority-surface prints `authority-surface: <error>` on stderr while
// its success summary and `roots not built yet` note stay unparsed;
// copy-assets prints `[copy-assets] source not found:`; an uncaught
// throw in any chain script prints node's `file://<abs>:<line>`
// code-frame header naming the script; and the
// build-release-dependency-inventory catch prints
// `release dependency inventory` messages. Vite 8 (rolldown) diagnostics
// print `[UNRESOLVED_IMPORT] Could not resolve '<spec>' in <importer>`
// and its commonjs-external throw prints `[vite]: Rolldown failed to
// resolve import "<spec>" from "<importer>"`; the importer resolves
// through the same `/<repo>/<repo>/` checkout marker as TAP locations,
// so the group keys on the real source file whose import closure decides
// touched. All of these group under `(build)`: a parenthesized identity
// can never resolve through a vitest pass line, so they classify
// shared-baseline, pr-caused or unknown -- never probable-flake. Passing
// builds, vite's `built in` summary, rolldown diagnostics whose file
// lives only inside the code frame (PARSE_ERROR), OOM kills and
// unrelated output stay unparsed.
const BUILD_STEP_NAMES = '(build)';
const BUILD_STEP_MAX = 24;
const BUILD_AUTHORITY_SURFACE_OK = /^authority-surface: \d+ files, \d+ packages, \d+ missing roots, \d+ unresolved — digest \S+$/;
const BUILD_AUTHORITY_SURFACE_NOTE = /^authority-surface: roots not built yet: /;
const BUILD_VITE_UNRESOLVED = /\[UNRESOLVED_IMPORT\]\s*Could not resolve\s*'[^'\n]*'\s*in\s*(\S+)/;
const BUILD_VITE_EXTERNAL = /\[vite\]: Rolldown failed to resolve import\s*"[^"\n]*"\s*from\s*"([^"\n]+)"/;
const BUILD_UNCAUGHT_HEADER = /^file:\/\/.*\/(scripts\/[A-Za-z0-9][A-Za-z0-9._-]*\.mjs):\d+\s*$/;
const BUILD_CHAIN_SCRIPTS = new Set([
  'scripts/authority-surface.mjs',
  'scripts/copy-assets.mjs',
  'scripts/build-preparation-builtin.mjs',
  'scripts/build-identity.mjs',
  'scripts/build-release-dependency-inventory.mjs',
  'scripts/sync-candidate-version.mjs',
]);

// Failure files whose real inputs sit outside any import closure: a gate
// script reads data files directly, so the closure walk alone would miss
// every input a PR could break. dependencies() seeds these before walking.
const STATIC_FAILURE_INPUTS: Record<string, readonly string[]> = {
  [VERSION_SYNC_FILE]: VERSION_SYNC_INPUTS,
  // The perf gate's direct repo inputs: the budgets spec, the checker
  // itself, the MCP tools/list harness one target times, and the bin/ashlr
  // launcher every `phm` target goes through. The measured CLI graph
  // (src/** -> dist/) has no enumerable closure, so deeper changes stay
  // unattributed rather than guessed.
  'perf/budgets.json': ['bin/ashlr', 'scripts/perf-budget.mjs', 'scripts/perf-mcp-tools-list.mjs'],
  // The dependency-audit gate reads each lockfile's installed graph plus
  // the manifests, shrinkwraps and .npmrc files that shape it, the
  // exception file its verdicts are filtered by, and the audit script
  // itself. The desktop Cargo.lock is audited by cargo-audit, whose
  // output this analyzer does not parse.
  'package-lock.json': ['package.json', 'npm-shrinkwrap.json', '.npmrc', '.github/dependency-audit-exceptions.json', 'scripts/npm-audit-with-osv-fallback.sh'],
  'src/raycast/package-lock.json': ['src/raycast/package.json', 'src/raycast/npm-shrinkwrap.json', 'src/raycast/.npmrc', '.github/dependency-audit-exceptions.json', 'scripts/npm-audit-with-osv-fallback.sh'],
  // The pack-smoke gate verifies the packed name/version against
  // package.json and the measured dist/ graph has no enumerable closure,
  // so only the manifest is a direct repo input; the artifact gate also
  // hashes the tracked lockfile set it admits.
  '.github/scripts/ci-pack-smoke.mjs': ['package.json'],
  'scripts/hosted-build-artifact.mjs': ['package.json', 'package-lock.json'],
  // The release-version provenance gate compares exactly two carriers --
  // package.json "version" and .release-please-manifest.json "." -- between
  // merge-base and head, so a bump to either is the PR-caused shape the
  // group must resolve. The scanner gates have no enumerable diff/commit
  // inputs and get no static seeds.
  '.github/scripts/release-version-provenance.mjs': ['package.json', '.release-please-manifest.json'],
  // The ci.yml helper gates run as workflow steps: the workflow file that
  // defines each command, env wiring and if: condition is a direct input
  // alongside the script's own import closure.
  '.github/scripts/ci-fetch-range.mjs': ['.github/workflows/ci.yml'],
  '.github/scripts/ci-source-binding.mjs': ['.github/workflows/ci.yml'],
  '.github/scripts/ci-site-lane.mjs': ['.github/workflows/ci.yml'],
  '.github/scripts/ci-mac-rotation.mjs': ['.github/workflows/ci.yml'],
  '.github/scripts/ci-dep-graph.mjs': ['.github/workflows/ci.yml'],
  '.github/scripts/ci-fast-select.mjs': ['.github/workflows/ci.yml'],
  '.github/scripts/ci-fast-inputs.mjs': ['.github/workflows/ci.yml'],
  '.github/scripts/ci-green-reuse.mjs': ['.github/workflows/ci.yml'],
  '.github/scripts/ci-mcp-selection.mjs': ['.github/workflows/ci.yml'],
  // The memory benchmark gate runs `tsx scripts/benchmark-memory.ts`
  // (npm run bench:memory -- --check): its import closure covers the
  // benchmark, its floors file and the whole src/core/memory
  // implementation, but not the toolchain files that shape how tsx
  // compiles and resolves it -- the manifest carrying the script and
  // pinned deps, its lockfile and the tsconfig tsx reads.
  'scripts/benchmark-memory.ts': ['package.json', 'package-lock.json', 'tsconfig.json'],
  // The npm run build helpers read data files no import closure reaches.
  // authority-surface walks the compiled authority closure, so the dist
  // graph has no enumerable source closure and the toolchain manifests
  // seed the provable inputs; copy-assets copies the web public assets
  // and the toolgraph manifest verbatim; build-preparation-builtin reads
  // the evaluator entries, the trusted preparation workflow source and
  // the verify wrappers it bundles (the esbuild transitive graph stays
  // unattributed); build-identity reads package.json. The
  // release-dependency-inventory script imports compiled dist modules,
  // so its closure cannot resolve at all -- its closed input list lives
  // in BUILD_STEP_INPUTS instead.
  'scripts/authority-surface.mjs': ['package.json', 'package-lock.json', 'tsconfig.json'],
  'scripts/copy-assets.mjs': ['src/core/toolgraph/graph.json', 'src/core/web/public/app.js', 'src/core/web/public/index.html', 'src/core/web/public/styles.css'],
  'scripts/build-preparation-builtin.mjs': [
    'scripts/evaluators/preparation-verification-workflow.ts',
    'scripts/evaluators/preparation-verification.mjs',
    'scripts/evaluators/preparation-verification-fixture-runtime.ts',
    'scripts/evaluators/preparation-verification-fixtures.ts',
    'scripts/evaluators/preparation-verification-activity.mjs',
    'scripts/evaluators/preparation-verification-child.mjs',
    'scripts/evaluators/preparation-verification-controller.mjs',
    'scripts/evaluators/preparation-verification-native.mjs',
    'scripts/evaluators/preparation-verification-protocol.mjs',
    'scripts/evaluators/preparation-verification-tool.mjs',
    'scripts/evaluators/preparation-workload.mjs',
    'src/core/resources/engineering-preparation.ts',
    'src/core/run/verify-commands.ts',
    'src/core/universe/fixed-evaluator.ts',
  ],
  'scripts/build-identity.mjs': ['package.json'],
};

// Closed input lists for build-step failures whose import closure cannot
// resolve, keyed by failure file and consulted through the flatInputs
// chain, so these groups never pick up the vitest harness ambient set.
const BUILD_STEP_INPUTS: Record<string, readonly string[]> = {
  // scripts/build-release-dependency-inventory.mjs imports compiled
  // dist/core modules, so the import-closure walk fails closed; the
  // closed set is the script itself, the npm pack inputs and the src
  // modules its dist imports compile from.
  'scripts/build-release-dependency-inventory.mjs': [
    'scripts/build-release-dependency-inventory.mjs',
    'package.json', 'package-lock.json', 'npm-shrinkwrap.json', '.npmrc',
    'src/core/daemon/runtime-release-dependency-inventory.ts',
    'src/core/util/private-storage.ts',
  ],
};

// The first-paint budget gate measures bundle bytes, not source: the
// measured dist/ graph has no enumerable closure (the web-ui static
// closure alone runs to hundreds of modules, past the import walk's
// bound), so each arm's dependency set is a closed input list -- the
// checker script, the vite config that folds the first-paint chunks
// (including the presentation-format group members it names), the
// manifests that pin the toolchain, the web-ui tsconfig esbuild reads,
// and the arm's named manifest roots under the vite root. A PR touching
// a root can grow that arm's measured closure; deeper src/web-ui or
// src/core changes stay unattributed rather than guessed at, the same
// convention the perf and memory gates use.
const FIRST_PAINT_COMMON_INPUTS = [
  'scripts/check-first-paint-budget.mjs',
  'vite.config.web.ts',
  'package.json',
  'package-lock.json',
  'src/web-ui/tsconfig.json',
  'src/web-ui/index.html',
  'src/web-ui/main.tsx',
  'src/core/vision/leader-display-text.ts',
  'src/web-ui/components/charts/format-metric.ts',
  'src/web-ui/components/format/locale-format.ts',
] as const;
const FIRST_PAINT_CHAT_INPUTS = [
  'src/web-ui/app/VerseConsoleApp.tsx',
  'src/web-ui/routes/verse/sections/ChatSection.tsx',
] as const;
const FIRST_PAINT_PHONE_INPUTS = [
  'src/web-ui/app/VerseMobileApp.tsx',
  'src/web-ui/routes/verse/mobile/screens/HomeScreen.tsx',
] as const;
const FIRST_PAINT_INPUTS: Record<string, readonly string[]> = {
  '(first-paint) chat': [...FIRST_PAINT_COMMON_INPUTS, ...FIRST_PAINT_CHAT_INPUTS],
  '(first-paint) phone': [...FIRST_PAINT_COMMON_INPUTS, ...FIRST_PAINT_PHONE_INPUTS],
  '(first-paint) gate': [...FIRST_PAINT_COMMON_INPUTS, ...FIRST_PAINT_CHAT_INPUTS, ...FIRST_PAINT_PHONE_INPUTS],
};

function parseVersionSyncFailures(log: string): Failure[] {
  const out: Failure[] = [];
  for (const line of lines(log)) {
    if (out.length >= VERSION_SYNC_MAX) break;
    if (line.startsWith('{')) {
      let doc: unknown;
      try { doc = JSON.parse(line); } catch { continue; }
      const report = doc as { version?: unknown; changed?: unknown; matches?: unknown; check?: unknown } | null;
      if (report === null || typeof report !== 'object') continue;
      if (report.matches !== false || report.check !== true) continue;
      if (typeof report.version !== 'string' || !VERSION_SYNC_SEMVER.test(report.version)) continue;
      if (!Array.isArray(report.changed) || report.changed.length === 0 || report.changed.length > VERSION_SYNC_INPUTS.length) continue;
      if (!report.changed.every(entry => typeof entry === 'string' && VERSION_SYNC_KNOWN.has(entry))) continue;
      out.push({ file: VERSION_SYNC_FILE, names: VERSION_SYNC_NAMES, testId: `${VERSION_SYNC_FILE} > ${VERSION_SYNC_NAMES}`, excerpt: clean(line) });
      continue;
    }
    if (line.startsWith(VERSION_SYNC_PREFIX)) {
      out.push({ file: VERSION_SYNC_FILE, names: VERSION_SYNC_NAMES, testId: `${VERSION_SYNC_FILE} > ${VERSION_SYNC_NAMES}`, excerpt: clean(line) });
    }
  }
  return out;
}

// A vite/rolldown build diagnostic names its importer either
// repo-relative (`src/main.js` -- the build's cwd is the checkout root)
// or absolute; the absolute form resolves through the same
// `/<repo>/<repo>/` checkout marker as TAP locations. node_modules
// paths, virtual modules and unresolvable absolutes stay unparsed
// rather than guessed.
function buildImporterFile(raw: string, repo: string | undefined): string | null {
  let path = raw.replace(/\\/g, '/');
  const query = path.indexOf('?');
  if (query >= 0) path = path.slice(0, query);
  if (path.startsWith('file://')) path = path.slice('file://'.length);
  const repoName = repo?.split('/')[1];
  if (repoName !== undefined) {
    const marker = `/${repoName}/${repoName}/`;
    const at = path.indexOf(marker);
    if (at >= 0) path = path.slice(at + marker.length);
  }
  if (!path || path.startsWith('node_modules/') || posix.normalize(path) !== path || path.includes('..') || posix.isAbsolute(path)) return null;
  return path;
}

function parseBuildStepFailures(log: string, repo?: string): Failure[] {
  const out: Failure[] = [];
  const emit = (file: string, excerpt: string) => {
    if (out.length >= BUILD_STEP_MAX) return;
    out.push({ file, names: BUILD_STEP_NAMES, testId: `${file} > ${BUILD_STEP_NAMES}`, excerpt: clean(excerpt) });
  };
  for (const line of lines(log)) {
    if (out.length >= BUILD_STEP_MAX) break;
    if (line.startsWith('authority-surface: ')) {
      if (!BUILD_AUTHORITY_SURFACE_OK.test(line) && !BUILD_AUTHORITY_SURFACE_NOTE.test(line)) emit('scripts/authority-surface.mjs', line);
      continue;
    }
    if (line.startsWith('[copy-assets] source not found: ')) {
      emit('scripts/copy-assets.mjs', line);
      continue;
    }
    if (/^release dependency inventory(?: npm pack)?: /.test(line) || line === 'npm pack file report is missing' || line === 'npm runtime closure exceeds traversal depth') {
      emit('scripts/build-release-dependency-inventory.mjs', line);
      continue;
    }
    const uncaught = BUILD_UNCAUGHT_HEADER.exec(line);
    if (uncaught !== null) {
      if (BUILD_CHAIN_SCRIPTS.has(uncaught[1]!)) emit(uncaught[1]!, line);
      continue;
    }
    const unresolved = BUILD_VITE_UNRESOLVED.exec(line);
    if (unresolved !== null) {
      const file = buildImporterFile(unresolved[1]!, repo);
      if (file !== null) emit(file, line);
      continue;
    }
    const external = BUILD_VITE_EXTERNAL.exec(line);
    if (external !== null) {
      const file = buildImporterFile(external[1]!, repo);
      if (file !== null) emit(file, line);
    }
  }
  return out;
}

// The advisory perf-budget workflow (.github/workflows/perf-budget.yml)
// times the committed cold paths in perf/budgets.json and prints one
// pretty-printed `ashlr.perf-budget-report.v1` document -- `{` at column
// 0, `}` at column 0 -- listing every target's status; any `fail` or
// `error` result makes the run exit non-zero. The job is
// deliberately not a required check, but its failed job log still feeds
// this analyzer: a latency regression on master fails the workflow on
// every freshly opened PR, and without this shape those PRs read unknown
// and queue no fix. Each `fail` (median over baseline + tolerance) or
// `error` (preflight break, command timeout, measurement failure) result
// groups per target under `<budgets file> > (perf-budget) <target id>` --
// per-target identities keep unrelated targets from merging into one
// group, and the budgets file is the unit a master fix restores
// (re-baseline with --update-baseline or speed the path up). `skip`
// results (absent optional tools) and `pass` results carry no failure.
// Like the other non-test identities it can never resolve through a
// vitest pass line: shared-baseline, pr-caused or unknown -- never
// probable-flake. Passing reports (`ok: true` or only pass/skip
// results), other schemas, malformed or multi-line blocks, absolute or
// escaping `budgets` paths, unknown statuses, malformed results and
// unrelated JSON stay unparsed.
const PERF_BUDGET_SCHEMA = 'ashlr.perf-budget-report.v1';
const PERF_BUDGET_NAMES = '(perf-budget)';
const PERF_BUDGET_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
const PERF_BUDGET_MAX = 100;

function parsePerfBudgetFailures(log: string): Failure[] {
  const out: Failure[] = [];
  // Timestamped job-log lines keep the document's own indentation: the
  // strip removes the stamp and its single separating space only, the
  // same convention as the check:docs report parser.
  const raw = stripVTControlCharacters(log).split('\n')
    .map(l => l.replace(/^\d{4}-\d\d-\d\dT\S+ /, '').replace(/\r$/, ''));
  for (let i = 0; i < raw.length && out.length < PERF_BUDGET_MAX; i++) {
    if (raw[i] !== '{') continue;
    let end = i + 1;
    while (end < raw.length && end - i < 20000 && raw[end] !== '}') end++;
    if (end >= raw.length || raw[end] !== '}') continue;
    const block = raw.slice(i, end + 1).join('\n');
    i = end;
    let doc: unknown;
    try { doc = JSON.parse(block); } catch { continue; }
    const report = doc as { schema?: unknown; ok?: unknown; budgets?: unknown; results?: unknown } | null;
    if (report === null || typeof report !== 'object') continue;
    if (report.schema !== PERF_BUDGET_SCHEMA || typeof report.ok !== 'boolean' || !Array.isArray(report.results)) continue;
    if (typeof report.budgets !== 'string') continue;
    const file = report.budgets;
    if (posix.normalize(file) !== file || file.includes('..') || posix.isAbsolute(file)) continue;
    for (const entry of (report.results as unknown[]).slice(0, PERF_BUDGET_MAX)) {
      if (out.length >= PERF_BUDGET_MAX) break;
      const r = entry as { id?: unknown; status?: unknown; why?: unknown; stats?: unknown; budget_ms?: unknown; delta_pct?: unknown } | null;
      if (r === null || typeof r !== 'object') continue;
      if (typeof r.id !== 'string' || !PERF_BUDGET_ID.test(r.id)) continue;
      if (r.status !== 'fail' && r.status !== 'error') continue;
      const names = `${PERF_BUDGET_NAMES} ${r.id}`;
      const parts = [`status=${r.status}`];
      const stats = r.stats as { median_ms?: unknown } | null;
      if (typeof stats?.median_ms === 'number' && Number.isFinite(stats.median_ms)) parts.push(`median_ms=${stats.median_ms}`);
      if (typeof r.budget_ms === 'number' && Number.isFinite(r.budget_ms)) parts.push(`budget_ms=${r.budget_ms}`);
      if (typeof r.delta_pct === 'number' && Number.isFinite(r.delta_pct)) parts.push(`delta_pct=${r.delta_pct}`);
      if (typeof r.why === 'string' && r.why !== '') parts.push(`why=${r.why}`);
      out.push({ file, names, testId: `${file} > ${names}`, excerpt: clean(parts.join(' ')) });
    }
  }
  return out;
}

// The Dependency Audit workflow (.github/workflows/dependency-audit.yml)
// audits four npm graphs through scripts/npm-audit-with-osv-fallback.sh --
// root full, root production (`--omit=dev`), Raycast full and Raycast
// production (`working-directory: src/raycast`, invoked as `../../scripts/...`)
// -- and `cat`s npm's audit v2 JSON report into the job log on every
// attempt. Each vulnerable package groups under
// `<lockfile> > (dependency-audit) <package>`: bumping the dependency or
// adding a reviewed exception is the unit a master fix restores, and the
// lockfile plus its manifest, shrinkwrap, .npmrc, the exception file and
// the gate script are its closed input set. The
// step command echo before a report fixes its lockfile and exception
// graph: non-omit audits consult .github/dependency-audit-exceptions.json
// under graph `full`, the Raycast production audit under
// `raycast-production`, and the root production audit never consults
// exceptions at all. npm still lists excepted advisories inside a failing
// report, so the parser replays the script's exemption fixpoint -- a
// package stays exempt while every `via` entry is an excepted advisory id
// or a still-exempt package name -- and emits only packages outside the
// exempt set; a report exempt end to end passed its step and emits
// nothing. `auditExceptions` carries master's exception list: `null`
// means the file was unreadable or malformed, and npm audit reports then
// stay unparsed rather than risk a phantom group for an accepted advisory.
// Expiry is not re-checked: a report printed by a completed run was
// governed by the exceptions valid at run time. When npm's transport fails
// all three bounded attempts the gate script falls back to the pinned
// OSV-Scanner (`scan source --lockfile <lockfile> --format table`), whose
// go-pretty table carries no audit v2 document: it parses separately
// below, per printed row, because osv-scanner itself already applied the
// step's IgnoredVulns config -- every row it prints is an unexcepted
// advisory, so these groups do not need the exception list and still emit
// when it is unreadable. Cargo-audit output carries no audit v2 document
// and stays unparsed. Invalid reports (non-v2 schema, malformed severity
// counts), reports with no preceding step echo, unrelated JSON and clean
// reports (`total: 0`) stay unparsed. Like the other non-test identities
// these groups can never resolve through a vitest pass line:
// shared-baseline, pr-caused or unknown -- never probable-flake.
export type DependencyAuditException = { id: string; package: string; graph: 'full' | 'raycast-production' };
const DEPENDENCY_AUDIT_NAMES = '(dependency-audit)';
const DEPENDENCY_AUDIT_MAX = 100;
const DEPENDENCY_AUDIT_SEVERITIES = ['info', 'low', 'moderate', 'high', 'critical', 'total'] as const;
const DEPENDENCY_AUDIT_INVOKE = /(?:^|[\s"'`(=])(\.\.\/\.\.\/)?scripts\/npm-audit-with-osv-fallback\.sh\s+"[^"]*"\s+(\S+?)(\s+--omit=dev)?\s*$/;
const DEPENDENCY_AUDIT_GHSA = /GHSA-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/i;
const DEPENDENCY_AUDIT_GHSA_ALL = /GHSA-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}/gi;
const DEPENDENCY_AUDIT_PACKAGE = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/i;

// Master's exception file is small and hand-reviewed; any malformed entry
// makes the whole file untrusted (the gate script itself fails closed on
// the same shapes), so one bad row discards the list rather than silently
// dropping coverage.
function parseAuditExceptions(source: string): DependencyAuditException[] | null {
  let doc: unknown;
  try { doc = JSON.parse(source); } catch { return null; }
  if (!Array.isArray(doc)) return null;
  const entries: DependencyAuditException[] = [];
  for (const item of doc) {
    const e = item as { id?: unknown; package?: unknown; graph?: unknown } | null;
    if (e === null || typeof e !== 'object' || typeof e.id !== 'string' || typeof e.package !== 'string' ||
        (e.graph !== 'full' && e.graph !== 'raycast-production')) return null;
    entries.push({ id: e.id.toUpperCase(), package: e.package, graph: e.graph });
  }
  return entries;
}

interface AuditStep { file: string; graph: 'full' | 'raycast-production' | null }

// Port of the fallback script's is_fully_exempt_npm_report fixpoint: every
// package starts assumed exempt, then a package drops out while any `via`
// entry is neither an excepted advisory nor a package still assumed
// exempt. The surviving set is exactly the coverage the gate script
// credits; packages outside it carry real, unexcepted advisories.
function exemptAuditPackages(vulnerabilities: Record<string, unknown>, exceptions: readonly DependencyAuditException[]): Set<string> {
  const names = Object.keys(vulnerabilities);
  const exempt = new Set(names);
  let changed = true;
  while (changed) {
    changed = false;
    for (const key of names) {
      if (!exempt.has(key)) continue;
      const vulnerability = vulnerabilities[key] as { name?: unknown; via?: unknown } | null;
      let ok = vulnerability !== null && typeof vulnerability === 'object' &&
        vulnerability.name === key && Array.isArray(vulnerability.via) && vulnerability.via.length > 0;
      if (ok) {
        const packageExceptions = exceptions.filter(exception => exception.package === vulnerability!.name);
        ok = (vulnerability!.via as unknown[]).every(advisory => {
          if (typeof advisory === 'string') return advisory !== key && exempt.has(advisory);
          if (advisory === null || typeof advisory !== 'object' || typeof (advisory as { url?: unknown }).url !== 'string') return false;
          const ids = ((advisory as { url: string }).url.match(DEPENDENCY_AUDIT_GHSA_ALL) ?? []);
          const id = ids.length === 1 ? ids[0]!.toUpperCase() : '';
          return packageExceptions.some(exception => exception.id.toUpperCase() === id);
        });
      }
      if (!ok) {
        exempt.delete(key);
        changed = true;
      }
    }
  }
  return exempt;
}

// The fallback leg's go-pretty table: in the piped CI log terminalWidth is
// 0, so osv-scanner renders StyleDefault's ASCII `+`/`-`/`|` box with no
// colors, seven columns in this order, one `|` row per vulnerability and
// `+`-ruled borders. The rounded unicode style only appears on a TTY and
// stays unparsed. A vuln group's alias ids join inside the OSV URL cell
// with newlines, so they continue onto following `|` lines whose other
// cells are blank.
const OSV_TABLE_HEADER = ['OSV URL', 'CVSS', 'Ecosystem', 'Package', 'Version', 'Fixed Version', 'Source'];
const OSV_TABLE_BORDER = /^\+(?:-+\+)+$/;
const OSV_URL = /^https:\/\/osv\.dev\/\S+$/;
const OSV_DEV_SUFFIX = ' (dev)';
const OSV_URLS_PER_PACKAGE = 8;

interface OsvAuditPackage {
  file: string;
  names: string;
  testId: string;
  pkg: string;
  ecosystems: string[];
  versions: string[];
  fixed: string[];
  cvss: string[];
  urls: string[];
}

// One `|`-delimited row of the table: exactly seven trimmed cells or null.
// None of the printed columns can contain `|` (URLs, ecosystem names,
// package names, versions, lockfile paths), so any other arity is not this
// table's shape and stays unparsed rather than guessed at.
function auditTableCells(line: string): string[] | null {
  if (!line.startsWith('|') || !line.endsWith('|')) return null;
  const cells = line.slice(1, -1).split('|').map(cell => cell.trim());
  return cells.length === OSV_TABLE_HEADER.length ? cells : null;
}

function isOsvAuditHeader(cells: string[]): boolean {
  return cells.every((cell, index) => cell === OSV_TABLE_HEADER[index]);
}

function pushUnique(list: string[], value: string, cap: number): void {
  if (value !== '' && !list.includes(value) && list.length < cap) list.push(value);
}

// Consume the `|` rows of one OSV table starting at `start` (just past its
// header) and fold them into `packages` keyed by the shared
// `<lockfile> > (dependency-audit) <package>` testId. Returns the index of
// the first line after the table so the caller's loop resumes there. Rows
// are accepted only inside a recognized audit step echo and only when the
// Source cell names the echoed lockfile (basename or repo-relative); the
// scanner's own IgnoredVulns config already filtered excepted advisories,
// so every surviving row is a real failure. ` (dev)` suffixes come off to
// match the npm report's package identity.
function collectOsvAuditTable(raw: string[], start: number, context: AuditStep, packages: Map<string, OsvAuditPackage>): number {
  let j = start;
  while (j < raw.length && OSV_TABLE_BORDER.test(raw[j]!)) j++;
  let current: OsvAuditPackage | null = null;
  for (; j < raw.length && raw[j]!.startsWith('|'); j++) {
    const cells = auditTableCells(raw[j]!);
    if (cells === null) continue;
    const [url = '', cvss = '', ecosystem = '', packageCell = '', version = '', fixed = '', source = ''] = cells;
    if (url !== '' && cells.slice(1).every(cell => cell === '')) {
      if (OSV_URL.test(url) && current !== null) pushUnique(current.urls, url, OSV_URLS_PER_PACKAGE);
      continue;
    }
    const pkg = packageCell.endsWith(OSV_DEV_SUFFIX) ? packageCell.slice(0, -OSV_DEV_SUFFIX.length) : packageCell;
    const sourcePath = posix.normalize(source);
    if (!OSV_URL.test(url) || !DEPENDENCY_AUDIT_PACKAGE.test(pkg) || pkg.length > 214 ||
        (sourcePath !== posix.basename(context.file) && sourcePath !== context.file)) {
      current = null;
      continue;
    }
    const testId = `${context.file} > ${DEPENDENCY_AUDIT_NAMES} ${pkg}`;
    let entry = packages.get(testId);
    if (entry === undefined) {
      entry = { file: context.file, names: `${DEPENDENCY_AUDIT_NAMES} ${pkg}`, testId, pkg, ecosystems: [], versions: [], fixed: [], cvss: [], urls: [] };
      packages.set(testId, entry);
    }
    current = entry;
    pushUnique(entry.urls, url, OSV_URLS_PER_PACKAGE);
    pushUnique(entry.ecosystems, ecosystem, 4);
    pushUnique(entry.versions, version, 8);
    pushUnique(entry.fixed, fixed, 8);
    pushUnique(entry.cvss, cvss, 8);
  }
  return j;
}

function parseAuditFailures(log: string, auditExceptions: readonly DependencyAuditException[] | null): Failure[] {
  const out: Failure[] = [];
  const seen = new Set<string>();
  const osvPackages = new Map<string, OsvAuditPackage>();
  // Timestamped job-log lines keep the document's and table's own columns:
  // the strip removes the stamp and its single separating space only, the
  // same convention as the check:docs and perf-budget report parsers, so a
  // nested `}` can never collapse into the column-0 close that ends a
  // pretty-printed report.
  const raw = stripVTControlCharacters(log).split('\n')
    .map(l => l.replace(/^\d{4}-\d\d-\d\dT\S+ /, '').replace(/\r$/, ''));
  let context: AuditStep | null = null;
  for (let i = 0; i < raw.length && out.length < DEPENDENCY_AUDIT_MAX; i++) {
    const line = raw[i]!;
    const invoke = DEPENDENCY_AUDIT_INVOKE.exec(line);
    if (invoke !== null) {
      const arg = invoke[2]!;
      const raycast = invoke[1] !== undefined;
      context = arg !== '' && !posix.isAbsolute(arg) && posix.normalize(arg) === arg && !arg.includes('..')
        ? { file: raycast ? `src/raycast/${arg}` : arg, graph: invoke[3] === undefined ? 'full' : raycast ? 'raycast-production' : null }
        : null;
      continue;
    }
    // The OSV fallback table needs no exception list -- the scanner applied
    // the step's IgnoredVulns config itself -- so it parses even when the
    // npm fixpoint below cannot run.
    if (context !== null) {
      const cells = auditTableCells(line);
      if (cells !== null && isOsvAuditHeader(cells)) {
        i = collectOsvAuditTable(raw, i + 1, context, osvPackages) - 1;
        continue;
      }
    }
    if (auditExceptions === null || !line.startsWith('{')) continue;
    let doc: unknown;
    let end = i;
    try {
      doc = JSON.parse(line);
    } catch {
      if (line !== '{') continue;
      end = i + 1;
      while (end < raw.length && end - i < 20000 && raw[end] !== '}') end++;
      if (end >= raw.length || raw[end] !== '}') continue;
      try { doc = JSON.parse(raw.slice(i, end + 1).join('\n')); } catch { continue; }
    }
    i = end;
    const report = doc as { auditReportVersion?: unknown; vulnerabilities?: unknown; metadata?: { vulnerabilities?: unknown } | null } | null;
    if (report === null || typeof report !== 'object' || report.auditReportVersion !== 2) continue;
    const counts = report.metadata?.vulnerabilities;
    if (counts === null || typeof counts !== 'object' || Array.isArray(counts)) continue;
    const valid = DEPENDENCY_AUDIT_SEVERITIES.every(severity => {
      const value = (counts as Record<string, unknown>)[severity];
      return Number.isInteger(value) && (value as number) >= 0;
    });
    if (!valid) continue;
    // The gate script passes a report only when every severity count is
    // zero; an inconsistent document listing packages under an all-zero
    // count would have passed its step, so it emits nothing here either.
    if (DEPENDENCY_AUDIT_SEVERITIES.every(severity => (counts as Record<string, unknown>)[severity] === 0)) continue;
    const vulnerabilities = report.vulnerabilities;
    if (vulnerabilities === null || typeof vulnerabilities !== 'object' || Array.isArray(vulnerabilities)) continue;
    if (context === null) continue;
    const step = context;
    const vulnMap = vulnerabilities as Record<string, unknown>;
    const names = Object.keys(vulnMap);
    if (names.length === 0) continue;
    // The root production audit never consults the exception file, so its
    // report emits every listed package; exception-governed graphs emit
    // only the packages the fixpoint leaves outside the exempt set.
    const exempt = step.graph === null ? null : exemptAuditPackages(vulnMap, auditExceptions.filter(exception => exception.graph === step.graph));
    for (const pkg of names) {
      if (out.length >= DEPENDENCY_AUDIT_MAX) break;
      if (!DEPENDENCY_AUDIT_PACKAGE.test(pkg) || pkg.length > 214 || exempt?.has(pkg) === true) continue;
      const entry = vulnMap[pkg] as { severity?: unknown; via?: unknown; fixAvailable?: unknown } | null;
      const severity = typeof entry?.severity === 'string' ? entry.severity : 'unknown';
      const advisories: string[] = [];
      if (entry !== null && typeof entry === 'object' && Array.isArray(entry.via)) {
        for (const advisory of entry.via as unknown[]) {
          if (advisories.length >= 6) break;
          if (advisory === null || typeof advisory !== 'object') continue;
          const { url, title } = advisory as { url?: unknown; title?: unknown };
          if (typeof url !== 'string') continue;
          const id = DEPENDENCY_AUDIT_GHSA.exec(url)?.[0]?.toUpperCase() ?? url;
          advisories.push(typeof title === 'string' && title !== '' ? `${id} ${title}` : id);
        }
      }
      const fix = entry !== null && typeof entry === 'object' ? entry.fixAvailable : undefined;
      const fixVersion = fix !== null && typeof fix === 'object' ? (fix as { version?: unknown }).version : undefined;
      const fixText = typeof fixVersion === 'string' ? `fix=${fixVersion}` : fix === true ? 'fix=available' : '';
      const namesField = `${DEPENDENCY_AUDIT_NAMES} ${pkg}`;
      const testId = `${step.file} > ${namesField}`;
      if (seen.has(testId)) continue;
      seen.add(testId);
      out.push({ file: step.file, names: namesField, testId, excerpt: clean([`${pkg} severity=${severity}`, ...advisories, ...(fixText === '' ? [] : [fixText])].join('\n')) });
    }
  }
  for (const entry of osvPackages.values()) {
    if (out.length >= DEPENDENCY_AUDIT_MAX) break;
    if (seen.has(entry.testId)) continue;
    seen.add(entry.testId);
    const meta = [
      entry.ecosystems.length ? `ecosystem=${entry.ecosystems.join(',')}` : '',
      entry.versions.length ? `version=${entry.versions.join(',')}` : '',
      entry.fixed.length ? `fixed=${entry.fixed.join(',')}` : '',
      entry.cvss.length ? `cvss=${entry.cvss.join(',')}` : '',
    ].filter(part => part !== '').join(' ');
    out.push({ file: entry.file, names: entry.names, testId: entry.testId, excerpt: clean([`${entry.pkg}${meta === '' ? '' : ` ${meta}`}`, ...entry.urls].join('\n')) });
  }
  return out;
}

// The `ci` job's pack-smoke steps on the ubuntu authority 1/3 shard verify
// the same-job build before the suites run: `Capture pack smoke build
// snapshot` runs `npm run check:pack-contracts` (node:test TAP, parsed
// above), `ci-pack-smoke.mjs capture`, `check:first-paint:built` and
// `ci-pack-smoke.mjs prepare`; `Pack smoke (exports map)` later reuses,
// verifies and captures the retained snapshot through the same script and
// `scripts/hosted-build-artifact.mjs`. Both scripts funnel every refusal --
// stale or mutated build output, a missing artifact, a drifted source tree,
// an unexpected tarball -- through one stderr prefix:
//   pack smoke refused: <assert message>
//   hosted artifact refused: <assert message>
// Assert messages may continue onto following lines (a drift list under
// `source changed after build:`); only the prefixed header line is a
// failure identity, so continuations stay excerpt-free. Each script groups
// under its own `<script> > (<gate>)` identity: the gate script plus the
// repository inputs it reads directly (seeded as static inputs, since the
// measured dist/ graph has no enumerable closure) is the unit a master fix
// restores, and like the other non-test identities these groups can never
// resolve through a vitest pass line -- shared-baseline, pr-caused or
// unknown, never probable-flake. Other `* refused:` prefixes belong to
// release-only workflows this analyzer's PR observations never see, and
// stay unparsed, as do empty messages, unrelated refusals and non-prefixed
// assert output.
const PACK_SMOKE_FILE = '.github/scripts/ci-pack-smoke.mjs';
const PACK_SMOKE_NAMES = '(pack-smoke)';
const HOSTED_ARTIFACT_FILE = 'scripts/hosted-build-artifact.mjs';
const HOSTED_ARTIFACT_NAMES = '(hosted-artifact)';
const ARTIFACT_GATE_MAX = 16;
const ARTIFACT_GATES = [
  { prefix: 'pack smoke refused: ', file: PACK_SMOKE_FILE, names: PACK_SMOKE_NAMES },
  { prefix: 'hosted artifact refused: ', file: HOSTED_ARTIFACT_FILE, names: HOSTED_ARTIFACT_NAMES },
] as const;

function parseArtifactGateFailures(log: string): Failure[] {
  const out: Failure[] = [];
  for (const line of lines(log)) {
    if (out.length >= ARTIFACT_GATE_MAX) break;
    for (const gate of ARTIFACT_GATES) {
      if (!line.startsWith(gate.prefix)) continue;
      if (line.slice(gate.prefix.length).trim() === '') break;
      out.push({ file: gate.file, names: gate.names, testId: `${gate.file} > ${gate.names}`, excerpt: clean(line) });
      break;
    }
  }
  return out;
}

// The secret-shape job pipes the candidate diff through the pinned
// `.github/tests/secret-shape/scrub.pl --check --allow-fixtures` and the
// step fails when the blocked count is nonzero. The checker prints only
// "<blocked> allowed=<n>" and never a matched value, so the count line is
// the whole evidence; a clean scan prints "0 allowed=<n>" and passes, so
// only a nonzero blocked count is a failure. The scan covers the entire
// candidate diff -- no enumerable repo input -- so the group keys on the
// scanner itself: only a PR touching scrub.pl counts as touched, and a
// shape carried inside a PR's own diff stays unattributed rather than
// guessed at which line carried it. Like the other non-test identities
// it can never resolve through a vitest pass line: shared-baseline,
// pr-caused or unknown -- never probable-flake.
const SECRET_SHAPE_FILE = '.github/tests/secret-shape/scrub.pl';
const SECRET_SHAPE_NAMES = '(secret-shape)';
const SECRET_SHAPE_COUNT = /^(\d+) allowed=(\d+)$/;
const SECRET_SHAPE_MAX = 8;
// The same step can also fail before the scanner prints its verdict: the
// pinned-hash check rejects scrub.pl, the candidate base cannot be resolved
// and the step refuses closed, or the script itself dies under perl. None
// of those shapes carries a count line, so without these identities a
// broken gate leaves every open PR unknown. They group under the workflow
// that owns the pin and step as `.github/workflows/ci.yml >
// (secret-shape-gate)`; the group's closed inputs are the workflow and the
// scanner -- the only repo files the step executes -- so a PR touching
// either is pr-caused. sha256sum's `: FAILED` line names the checklist
// target verbatim, which keeps the check attributable inside this job's
// log; the WARNING summary line alone is never enough.
const SECRET_SHAPE_GATE_FILE = '.github/workflows/ci.yml';
const SECRET_SHAPE_GATE_NAMES = '(secret-shape-gate)';
const SECRET_SHAPE_PIN_FAILED = /^\.github\/tests\/secret-shape\/scrub\.pl: FAILED/;
const SECRET_SHAPE_BASE_MISSING = /^secret-shape base is missing$/;
const SECRET_SHAPE_PL_PATH = /\.github\/tests\/secret-shape\/scrub\.pl/;
const SECRET_SHAPE_PL_FATAL = /syntax error|aborted due to compilation errors|BEGIN failed|requires explicit package name|Undefined subroutine|Can't call method|Search pattern not terminated|Unrecognized character/;

function parseSecretShapeFailures(log: string): Failure[] {
  const out: Failure[] = [];
  for (const line of lines(log)) {
    if (out.length >= SECRET_SHAPE_MAX) break;
    const match = SECRET_SHAPE_COUNT.exec(line);
    if (match !== null && Number(match[1]) !== 0) {
      out.push({ file: SECRET_SHAPE_FILE, names: SECRET_SHAPE_NAMES, testId: `${SECRET_SHAPE_FILE} > ${SECRET_SHAPE_NAMES}`, excerpt: clean(line) });
      continue;
    }
    if (SECRET_SHAPE_PIN_FAILED.test(line) || SECRET_SHAPE_BASE_MISSING.test(line) ||
        (SECRET_SHAPE_PL_PATH.test(line) && SECRET_SHAPE_PL_FATAL.test(line))) {
      out.push({ file: SECRET_SHAPE_GATE_FILE, names: SECRET_SHAPE_GATE_NAMES, testId: `${SECRET_SHAPE_GATE_FILE} > ${SECRET_SHAPE_GATE_NAMES}`, excerpt: clean(line) });
    }
  }
  return out;
}

// The secret-scan job runs the pinned gitleaks binary over the candidate
// commit range with --redact and no -v, so the job log carries only the
// scanner's own summary: `WRN leaks found: <n>` on stderr (a clean scan
// prints `no leaks found` instead). Finding detail -- file, rule,
// fingerprint -- is never emitted by this invocation, so the count line is
// the whole evidence and the group keys on the workflow that defines the
// gate: only a PR touching .github/workflows/ci.yml (the job, its pinned
// version, the .gitleaksignore removal) counts as touched, and a leak
// carried inside a PR's own commits stays unattributed rather than
// guessed at which commit carried it. Like the other non-test identities
// it can never resolve through a vitest pass line: shared-baseline,
// pr-caused or unknown -- never probable-flake.
const SECRET_SCAN_FILE = '.github/workflows/ci.yml';
const SECRET_SCAN_NAMES = '(secret-scan)';
const SECRET_SCAN_FOUND = /\bleaks found:\s*(\d+)\s*$/;
const SECRET_SCAN_MAX = 8;
// The job can also fail before gitleaks prints its verdict: the pinned
// archive hash check rejects the download (sha256sum's `: FAILED` line
// names the `gitleaks.tar.gz` checklist target, keeping it attributable
// inside this job's log -- the WARNING summary alone is never enough),
// or the commit range the scan covers cannot be resolved and the step
// refuses closed. Neither shape carries a `leaks found:` line, so
// without this identity a broken gate leaves every open PR unknown.
// They group under the same workflow file as
// `.github/workflows/ci.yml > (secret-scan-gate)`; the group's closed
// inputs are the workflow and ci-fetch-range.mjs -- the script the
// merge_group/push scan-base path executes -- so a PR touching either
// is pr-caused.
const SECRET_SCAN_GATE_NAMES = '(secret-scan-gate)';
const SECRET_SCAN_ARCHIVE_FAILED = /(?:^|\/)gitleaks\.tar\.gz: FAILED/;
const SECRET_SCAN_RANGE_REFUSED = /^secret scan refused an incomplete commit range$/;

function parseSecretScanFailures(log: string): Failure[] {
  const out: Failure[] = [];
  for (const line of lines(log)) {
    if (out.length >= SECRET_SCAN_MAX) break;
    const match = SECRET_SCAN_FOUND.exec(line);
    if (match !== null && Number(match[1]) !== 0) {
      out.push({ file: SECRET_SCAN_FILE, names: SECRET_SCAN_NAMES, testId: `${SECRET_SCAN_FILE} > ${SECRET_SCAN_NAMES}`, excerpt: clean(line) });
      continue;
    }
    if (SECRET_SCAN_ARCHIVE_FAILED.test(line) || SECRET_SCAN_RANGE_REFUSED.test(line)) {
      out.push({ file: SECRET_SCAN_FILE, names: SECRET_SCAN_GATE_NAMES, testId: `${SECRET_SCAN_FILE} > ${SECRET_SCAN_GATE_NAMES}`, excerpt: clean(line) });
    }
  }
  return out;
}

// The quick job's "Require release-please provenance for version bumps"
// step (pull_request only) compares the merge-base and head carriers --
// package.json version and .release-please-manifest.json "." -- and fails
// any bump outside a same-repository release-please--* branch. A refused
// bump prints `::error::<changed carriers>. Only the release-please PR
// may change the release version; ...` and a gate malfunction prints
// `release version provenance check failed: <message>`; either way the
// job goes red with no vitest, typecheck or TAP line naming it. Both
// shapes group under the gate script as
// `.github/scripts/release-version-provenance.mjs > (version-provenance)`:
// the check reads exactly the script and the two carrier files, which
// STATIC_FAILURE_INPUTS seeds so a PR touching either carrier is
// PR-caused. Like the other non-test identities it can never resolve
// through a vitest pass line: shared-baseline, pr-caused or unknown --
// never probable-flake.
const VERSION_PROVENANCE_FILE = '.github/scripts/release-version-provenance.mjs';
const VERSION_PROVENANCE_NAMES = '(version-provenance)';
const VERSION_PROVENANCE_ERROR = /^::error::.+Only the release-please PR may change the release version/;
const VERSION_PROVENANCE_FAILED = /^release version provenance check failed: \S/;
const VERSION_PROVENANCE_MAX = 8;

function parseVersionProvenanceFailures(log: string): Failure[] {
  const out: Failure[] = [];
  for (const line of lines(log)) {
    if (out.length >= VERSION_PROVENANCE_MAX) break;
    if (!VERSION_PROVENANCE_ERROR.test(line) && !VERSION_PROVENANCE_FAILED.test(line)) continue;
    out.push({ file: VERSION_PROVENANCE_FILE, names: VERSION_PROVENANCE_NAMES, testId: `${VERSION_PROVENANCE_FILE} > ${VERSION_PROVENANCE_NAMES}`, excerpt: clean(line) });
  }
  return out;
}

// Closed input lists for the trust gates' bootstrap failures, consulted
// through the flatInputs chain by failure names like the lint-guard and
// test-runner maps. The scanner-verdict groups key on the scanner
// definition alone (a diff or commit range has no enumerable repo input),
// but a gate that never reached its verdict fails on the files the step
// itself executes: the workflow carrying the pin, env wiring and step
// definition, plus the pinned scanner for secret-shape and the
// scan-base helper for secret-scan's merge_group/push path. The vitest
// harness ambient set cannot reach any of them.
const SECRET_GATE_INPUTS: Record<string, readonly string[]> = {
  [SECRET_SHAPE_GATE_NAMES]: [SECRET_SHAPE_GATE_FILE, SECRET_SHAPE_FILE],
  [SECRET_SCAN_GATE_NAMES]: [SECRET_SCAN_FILE, '.github/scripts/ci-fetch-range.mjs'],
};

// The ci.yml helper gates under .github/scripts/ are single-purpose node
// invocations whose only failure output is the script's console.error
// line plus the runner's `##[error]Process completed with exit code`
// step marker: no vitest FAIL, TAP `not ok`, tsc diagnostic or report
// shape names them, so without step attribution a broken gate leaves
// every open PR unknown and queues no fix. GitHub wraps each `run:`
// step in a `##[group]Run <script>` block -- the Run tail and the
// echoed script lines, then `shell:`/`env:` metadata, then
// `##[endgroup]` -- and a step qualifies only when every script line
// is a `node --test` invocation or a whitelisted gate script, all gate
// lines naming the same file. Mixed bash, heredocs, `uses:` actions,
// non-whitelisted scripts (ci-pack-smoke and release-version-provenance
// already have dedicated parsers) and other commands stay
// unattributed. When the step then fails, a
// `not ok` or vitest FAIL line in its own output means the companion
// test runner owns the failure and the gate group is suppressed;
// otherwise the gate script is the identity -- the file, its import
// closure and the workflow step that invokes it are the unit a master
// fix restores. Like the other non-test identities these groups can
// never resolve through a vitest pass line: shared-baseline, pr-caused
// or unknown -- never probable-flake. Scripts whose pure steps only
// appear in jobs the analyzer's evidence never sees (macOS/Windows
// lanes, release pipelines, merge-group-only attribution) are
// deliberately not listed.
const CI_SCRIPT_GATE_MAX = 8;
const CI_SCRIPT_GATES: Record<string, string> = {
  'ci-fetch-range.mjs': '(fetch-range)',
  'ci-source-binding.mjs': '(source-binding)',
  'ci-site-lane.mjs': '(site-lane)',
  'ci-mac-rotation.mjs': '(mac-rotation)',
  'ci-dep-graph.mjs': '(dep-graph)',
  // ci-fast-select pairs its node --test companion in one step: a
  // companion `not ok` still suppresses this group, but the script's
  // selection-failure fallback does not cover infrastructure exits
  // (plan-file writes, module load, the fallback planner itself), and
  // without the group those crashes leave every open PR unknown.
  'ci-fast-select.mjs': '(fast-select)',
  'ci-fast-inputs.mjs': '(fast-inputs)',
  'ci-green-reuse.mjs': '(green-reuse)',
  'ci-mcp-selection.mjs': '(mcp-selection)',
};
const CI_SCRIPT_GATE_FILES = new Set(Object.keys(CI_SCRIPT_GATES).map(base => `.github/scripts/${base}`));
const CI_STEP_GROUP = /^##\[group\]Run(?:\s+(.*))?$/;
const CI_STEP_END = /^##\[endgroup\]$/;
const CI_STEP_META = /^(?:shell|env)\s*:/;
const CI_STEP_NODE_TEST = /^node\s+--test(?:\s|$)/;
const CI_STEP_GATE = /^node\s+\.github\/scripts\/([A-Za-z0-9][A-Za-z0-9._-]*\.mjs)(?=\s|$)/;
const CI_STEP_FAILED = /^##\[error\]Process completed with exit code \d+\.$/;

function parseCiScriptGateFailures(log: string): Failure[] {
  const out: Failure[] = [];
  // idle: no step context. script: collecting a Run block's script lines.
  // meta: past the shell:/env: marker inside the block. output: scanning a
  // step's output for failure shapes an earlier parser already owns.
  let phase: 'idle' | 'script' | 'meta' | 'output' = 'idle';
  let disqualified = false;
  const bases = new Set<string>();
  let gate: { file: string; names: string } | null = null;
  let suppressed = false;
  let recent: string[] = [];
  const noteScriptLine = (line: string) => {
    if (line === '' || CI_STEP_NODE_TEST.test(line)) return;
    const match = CI_STEP_GATE.exec(line);
    const names = match === null ? undefined : CI_SCRIPT_GATES[match[1]!];
    if (names === undefined) { disqualified = true; return; }
    bases.add(match![1]!);
  };
  // A step attributes to a gate only when its script lines name exactly one
  // whitelisted helper; node --test companions and blank lines are allowed.
  const resolveGate = (): { file: string; names: string } | null => {
    const base = !disqualified && bases.size === 1 ? [...bases][0]! : null;
    return base === null ? null : { file: `.github/scripts/${base}`, names: CI_SCRIPT_GATES[base]! };
  };
  for (const line of lines(log)) {
    if (out.length >= CI_SCRIPT_GATE_MAX) break;
    if (line.startsWith('##[group]')) {
      // Any group boundary ends the current step: a new Run block starts
      // script collection, anything else leaves the step unattributed.
      phase = 'idle'; gate = null; disqualified = false; bases.clear(); suppressed = false; recent = [];
      const run = CI_STEP_GROUP.exec(line);
      if (run !== null) {
        phase = 'script';
        if (run[1] !== undefined) noteScriptLine(run[1]);
      }
      continue;
    }
    if (phase === 'script') {
      if (CI_STEP_END.test(line)) {
        gate = resolveGate();
        phase = 'output';
        suppressed = false;
        recent = [];
        continue;
      }
      if (CI_STEP_META.test(line)) { phase = 'meta'; continue; }
      noteScriptLine(line);
      continue;
    }
    if (phase === 'meta') {
      if (CI_STEP_END.test(line)) {
        gate = resolveGate();
        phase = 'output';
        suppressed = false;
        recent = [];
      }
      continue;
    }
    if (phase === 'output') {
      if (CI_STEP_FAILED.test(line)) {
        if (gate !== null && !suppressed) {
          const excerpt = recent.length > 0 ? recent.join('\n') : line;
          out.push({ file: gate.file, names: gate.names, testId: `${gate.file} > ${gate.names}`, excerpt: clean(excerpt) });
        }
        phase = 'idle'; gate = null; suppressed = false; recent = [];
        continue;
      }
      if (FAIL_LINE.test(line) || SUITE_FAIL_LINE.test(line) || /^not ok\b/.test(line)) suppressed = true;
      if (line !== '') { recent.push(line); if (recent.length > 4) recent.shift(); }
    }
  }
  return out;
}

// The `Install dependencies` steps run a bare `npm ci` (with or without
// --ignore-scripts/--no-audit/--no-fund): when the manifest pair or the
// lockfile is broken on master, every fresh PR fails the same step before
// any test runs, and npm's own `npm error <detail>` block is the only
// evidence -- no vitest FAIL, TAP `not ok`, tsc diagnostic or report
// shape names it, so without step attribution those PRs read unknown and
// queue no fix. The same `##[group]Run` step tracking as the helper gates
// applies, but a step qualifies only when every script line is a pure
// `npm ci` invocation: `npm ci && npm run build` preambles, `npm install`
// toolchain fetches, `uses:` actions, mixed bash and `npm run` script
// steps (whose `npm error Lifecycle script` blocks this parser must not
// claim) stay unattributed. The step fails only on npm's own diagnosis --
// a runner kill or spawn death with no `npm error` line stays unknown.
// Each failure groups under `package-lock.json > (install)`: the
// manifest/lockfile pair plus shrinkwrap/.npmrc variants and the ci.yml
// step definition are the closed input list a master fix restores (the
// only workflow whose root install runs on analyzed refs with a
// verifiable checkout), consulted through flatInputs like the other
// gate maps, so these groups classify shared-baseline, pr-caused or
// unknown -- never probable-flake.
const INSTALL_STEP_FILE = 'package-lock.json';
const INSTALL_STEP_NAMES = '(install)';
const INSTALL_STEP_MAX = 8;
const INSTALL_NPM_CI = /^npm\s+ci(?:\s+--?\S+)*$/;
const INSTALL_NPM_ERROR = /^npm\s+(?:error|ERR!)\s+\S/;
const INSTALL_STEP_INPUTS: Record<string, readonly string[]> = {
  [INSTALL_STEP_NAMES]: ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', '.npmrc', '.github/workflows/ci.yml'],
};

function parseInstallFailures(log: string): Failure[] {
  const out: Failure[] = [];
  // idle: no step context. script: collecting a Run block's script lines.
  // meta: past the shell:/env: marker inside the block. output: scanning a
  // step's output for npm's own error lines.
  let phase: 'idle' | 'script' | 'meta' | 'output' = 'idle';
  let disqualified = false;
  let installCandidate = false;
  let install = false;
  const npmErrors: string[] = [];
  const reset = () => {
    phase = 'idle'; disqualified = false; installCandidate = false; install = false;
    npmErrors.length = 0;
  };
  const resolveInstall = () => { install = installCandidate && !disqualified; };
  for (const line of lines(log)) {
    if (out.length >= INSTALL_STEP_MAX) break;
    if (line.startsWith('##[group]')) {
      // Any group boundary ends the current step: a new Run block starts
      // script collection, anything else leaves the step unattributed.
      reset();
      const run = CI_STEP_GROUP.exec(line);
      if (run !== null) {
        phase = 'script';
        const first = run[1];
        if (first !== undefined && first !== '') {
          if (INSTALL_NPM_CI.test(first)) installCandidate = true; else disqualified = true;
        }
      }
      continue;
    }
    if (phase === 'script') {
      if (CI_STEP_END.test(line)) {
        resolveInstall();
        phase = 'output';
        continue;
      }
      if (CI_STEP_META.test(line)) { phase = 'meta'; continue; }
      if (line === '') continue;
      if (INSTALL_NPM_CI.test(line)) installCandidate = true; else disqualified = true;
      continue;
    }
    if (phase === 'meta') {
      if (CI_STEP_END.test(line)) {
        resolveInstall();
        phase = 'output';
      }
      continue;
    }
    if (phase === 'output') {
      if (CI_STEP_FAILED.test(line)) {
        if (install && npmErrors.length > 0) {
          out.push({ file: INSTALL_STEP_FILE, names: INSTALL_STEP_NAMES, testId: `${INSTALL_STEP_FILE} > ${INSTALL_STEP_NAMES}`, excerpt: clean(npmErrors.join('\n')) });
        }
        reset();
        continue;
      }
      if (INSTALL_NPM_ERROR.test(line) && npmErrors.length < 8) npmErrors.push(line);
    }
  }
  return out;
}

// The install-smoke jobs' "Install this commit" and "Install the published
// release" steps run `node .github/scripts/ci-install-smoke.mjs <verb>` on
// the linux lane whenever a pull request or merge group trips the
// xplat_install path filter (and on the daily schedule and dispatch). The
// script funnels every refusal -- an npm pack/install exit, a missing
// packed tarball or phm shim, a version mismatch, a bad published-release
// checksum or download -- through one console.error line plus the runner's
// `##[error]Process completed with exit code` step marker: no vitest FAIL,
// TAP `not ok`, tsc diagnostic or report shape names the step, so without
// step attribution a broken gate leaves every open xplat PR unknown and
// queues no fix. The two verbs are different gates with different inputs:
// `commit` builds, packs and installs this checkout, so package.json
// (version, files, bin), package-lock.json, the packed bin shim and the
// workflow step are its closed inputs; `release` fetches and installs the
// published npm artifact, which no diff can change, so only the script
// and the workflow step that invokes it count. Each failure groups under
// `.github/scripts/ci-install-smoke.mjs > (install-smoke-commit)` or
// `> (install-smoke-release)`; like the other non-test identities these
// groups can never resolve through a vitest pass line -- shared-baseline,
// pr-caused or unknown, never probable-flake. A step qualifies only when
// every script line is the same install-smoke invocation: mixed bash,
// `uses:` actions, other scripts, ambiguous multi-command steps and
// cancelled steps stay unattributed, and build diagnostics the step's own
// `npm run build`/`npm pack` prints still belong to the typecheck and
// build-step parsers.
const INSTALL_SMOKE_FILE = '.github/scripts/ci-install-smoke.mjs';
const INSTALL_SMOKE_COMMIT_NAMES = '(install-smoke-commit)';
const INSTALL_SMOKE_RELEASE_NAMES = '(install-smoke-release)';
const INSTALL_SMOKE_MAX = 8;
const INSTALL_SMOKE_STEP = /^node\s+\.github\/scripts\/ci-install-smoke\.mjs\s+(commit|release)$/;
const INSTALL_SMOKE_NAMES: Record<string, string> = { commit: INSTALL_SMOKE_COMMIT_NAMES, release: INSTALL_SMOKE_RELEASE_NAMES };
const INSTALL_SMOKE_INPUTS: Record<string, readonly string[]> = {
  [INSTALL_SMOKE_COMMIT_NAMES]: [INSTALL_SMOKE_FILE, '.github/workflows/ci.yml', 'package.json', 'package-lock.json', 'bin/ashlr'],
  [INSTALL_SMOKE_RELEASE_NAMES]: [INSTALL_SMOKE_FILE, '.github/workflows/ci.yml'],
};

function parseInstallSmokeFailures(log: string): Failure[] {
  const out: Failure[] = [];
  // idle: no step context. script: collecting a Run block's script lines.
  // meta: past the shell:/env: marker inside the block. output: scanning a
  // step's output for the runner's step-failure marker.
  let phase: 'idle' | 'script' | 'meta' | 'output' = 'idle';
  let disqualified = false;
  let verb: string | null = null;
  let smoke: string | null = null;
  const recent: string[] = [];
  const reset = () => {
    phase = 'idle'; disqualified = false; verb = null; smoke = null;
    recent.length = 0;
  };
  const resolveSmoke = () => { smoke = !disqualified && verb !== null ? INSTALL_SMOKE_NAMES[verb]! : null; };
  const noteScriptLine = (line: string) => {
    if (line === '') return;
    const match = INSTALL_SMOKE_STEP.exec(line);
    if (match === null || (verb !== null && match[1] !== verb)) { disqualified = true; return; }
    verb = match[1]!;
  };
  for (const line of lines(log)) {
    if (out.length >= INSTALL_SMOKE_MAX) break;
    if (line.startsWith('##[group]')) {
      // Any group boundary ends the current step: a new Run block starts
      // script collection, anything else leaves the step unattributed.
      reset();
      const run = CI_STEP_GROUP.exec(line);
      if (run !== null) {
        phase = 'script';
        if (run[1] !== undefined && run[1] !== '') noteScriptLine(run[1]);
      }
      continue;
    }
    if (phase === 'script') {
      if (CI_STEP_END.test(line)) {
        resolveSmoke();
        phase = 'output';
        continue;
      }
      if (CI_STEP_META.test(line)) { phase = 'meta'; continue; }
      noteScriptLine(line);
      continue;
    }
    if (phase === 'meta') {
      if (CI_STEP_END.test(line)) {
        resolveSmoke();
        phase = 'output';
      }
      continue;
    }
    if (phase === 'output') {
      if (CI_STEP_FAILED.test(line)) {
        if (smoke !== null) {
          const excerpt = recent.length > 0 ? recent.join('\n') : line;
          out.push({ file: INSTALL_SMOKE_FILE, names: smoke, testId: `${INSTALL_SMOKE_FILE} > ${smoke}`, excerpt: clean(excerpt) });
        }
        reset();
        continue;
      }
      if (line !== '') { recent.push(line); if (recent.length > 4) recent.shift(); }
    }
  }
  return out;
}

// The `ci` job's "Memory benchmark regression gate" step on the ubuntu
// authority 3/3 shard runs `npm run --silent bench:memory -- --check >
// /dev/null`: the redirect discards the script's pretty-printed JSON
// report, so the job log carries only what the gate writes to stderr --
//   memory benchmark below floor:
//     <violation>
//     <violation>
// one line indented two spaces per governed-arm measurement that fell
// below its floor in src/core/local-eval/memory-benchmark-floors.ts
// (case counts, passed counts vs floor, leak/step/waste ceilings, open
// pending decisions). A memory regression on master fails this shard on
// every freshly opened PR with no vitest, typecheck or TAP line naming
// it, so without this shape those PRs read unknown and queue no fix.
// The gate's verdict is binary -- the step fails while any violation
// stands -- so each block groups under the entry script as
// `scripts/benchmark-memory.ts > (memory-benchmark)`: the script plus
// its import closure (the benchmark, its floors and the whole
// src/core/memory implementation) and the seeded toolchain inputs is
// the unit a master fix restores, and like the other non-test
// identities it can never resolve through a vitest pass line --
// shared-baseline, pr-caused or unknown, never probable-flake. The
// measurement run without --check, the discarded JSON report,
// MEMORY_BENCH_ARGUMENTS usage errors (exit 2, no stderr), passing
// runs, a bare header with no violation lines and unrelated output
// stay unparsed.
const MEMORY_BENCHMARK_FILE = 'scripts/benchmark-memory.ts';
const MEMORY_BENCHMARK_NAMES = '(memory-benchmark)';
const MEMORY_BENCHMARK_HEADER = 'memory benchmark below floor:';
const MEMORY_BENCHMARK_MAX = 8;
const MEMORY_BENCHMARK_VIOLATIONS_MAX = 48;
const MEMORY_BENCHMARK_VIOLATION = /^ {2}\S/;

function parseMemoryBenchmarkFailures(log: string): Failure[] {
  const out: Failure[] = [];
  // Timestamped job-log lines keep the violation indent: the strip removes
  // the stamp and its single separating space only, the same convention as
  // the TAP and report parsers.
  const raw = stripVTControlCharacters(log).split('\n')
    .map(l => l.replace(/^\d{4}-\d\d-\d\dT\S+ /, '').replace(/\r$/, ''));
  for (let i = 0; i < raw.length && out.length < MEMORY_BENCHMARK_MAX; i++) {
    if (raw[i]!.trimEnd() !== MEMORY_BENCHMARK_HEADER) continue;
    const violations: string[] = [];
    for (let j = i + 1; j < raw.length && violations.length < MEMORY_BENCHMARK_VIOLATIONS_MAX; j++) {
      const line = raw[j]!;
      if (!MEMORY_BENCHMARK_VIOLATION.test(line)) break;
      violations.push(line);
    }
    if (violations.length === 0) continue;
    out.push({
      file: MEMORY_BENCHMARK_FILE,
      names: MEMORY_BENCHMARK_NAMES,
      testId: `${MEMORY_BENCHMARK_FILE} > ${MEMORY_BENCHMARK_NAMES}`,
      excerpt: clean([MEMORY_BENCHMARK_HEADER, ...violations].join('\n')),
    });
    i += violations.length;
  }
  return out;
}

// The `ci` job's "Lint" step on the ubuntu authority 3/3 shard runs
// `npm run lint` (`eslint . && npm run lint:realio-lane && npm run
// lint:verse-sync-io`). ESLint's stylish formatter prints each file with
// messages as its absolute path followed by `line:col severity message
// ruleId` table rows, then closes the run with a
// `✖ N problems (X errors, Y warnings)` summary. A lint break prints no
// vitest FAIL, TAP, typecheck or report shape, so without this shape a red
// master marked every open PR unknown and queued no fix. Errors group per
// file under a `<file> > (lint)` identity, like `(typecheck)`: eslint's
// rules are per-file, so the unit a master fix restores is the file's own
// content plus the flat config and dependency manifests -- never its
// import closure -- and the vitest harness ambient set does not apply.
// Only `error` rows are failures: `eslint .` exits nonzero on errors alone
// and warnings never fail the step without --max-warnings, so a
// warnings-only file emits nothing. Stylish prints `result.filePath`, an
// absolute runner path, so headers resolve through the same
// `/<work>/<repo>/<repo>/` checkout marker as TAP locations; anything else
// stays unparsed. Like the other non-test identities it can never resolve
// through a vitest pass line: shared-baseline, pr-caused or unknown --
// never probable-flake.
const LINT_NAMES = '(lint)';
const LINT_INPUTS = ['eslint.config.js', 'package.json', 'package-lock.json'] as const;
const LINT_MAX = 100;
const LINT_MESSAGES_PER_FILE = 8;
const LINT_SUMMARY = /^✖\s+\d+\s+problems?\s+\(\d+\s+errors?,\s+\d+\s+warnings?\)\s*$/;
const LINT_MESSAGE = /^(\d+):(\d+)\s+(error|warning)\s/;
const LINT_FILE_EXT = /\.(?:[jt]sx?|m[jt]s|c[jt]s)$/;

// Stylish prints the linted file's absolute path as a bare header line.
// Only paths under the Actions checkout marker resolve to repo-relative
// files; every other absolute path stays unparsed rather than guessed at,
// the same convention as tapRepoFile.
function lintHeaderFile(line: string, repo: string | undefined): string | null {
  if (!line.startsWith('/')) return null;
  const repoName = repo?.split('/')[1];
  if (repoName === undefined) return null;
  const marker = `/${repoName}/${repoName}/`;
  const at = line.indexOf(marker);
  if (at < 0) return null;
  const path = line.slice(at + marker.length);
  if (!path || posix.normalize(path) !== path || path.includes('..') || posix.isAbsolute(path)) return null;
  return LINT_FILE_EXT.test(path) ? path : null;
}

function parseLintFailures(log: string, repo: string | undefined): Failure[] {
  const byFile = new Map<string, string[]>();
  let sawSummary = false;
  let current: string[] | null = null;
  for (const line of lines(log)) {
    if (LINT_SUMMARY.test(line)) { sawSummary = true; continue; }
    const message = LINT_MESSAGE.exec(line);
    if (message !== null) {
      if (message[3] === 'error' && current !== null && current.length < LINT_MESSAGES_PER_FILE) current.push(line);
      continue;
    }
    const file = lintHeaderFile(line, repo);
    if (file === null) { current = null; continue; }
    let parts = byFile.get(file);
    if (parts === undefined) {
      if (byFile.size >= LINT_MAX) { current = null; continue; }
      parts = [];
      byFile.set(file, parts);
    }
    current = parts;
  }
  if (!sawSummary) return [];
  const out: Failure[] = [];
  for (const [file, parts] of byFile) {
    if (parts.length === 0) continue;
    out.push({ file, names: LINT_NAMES, testId: `${file} > ${LINT_NAMES}`, excerpt: clean(parts.join('\n')) });
  }
  return out;
}

// The lint step's per-file dependency sets: each guard greps source text
// and never reads a file's imports, so -- like eslint -- the unit a master
// fix restores is the failing file itself plus the guard's closed input
// list, never the import closure walk.
const LINT_GUARD_INPUTS: Record<string, readonly string[]> = {
  [LINT_NAMES]: LINT_INPUTS,
  // check-realio-lane-membership.mjs classifies every collected
  // test/**/*.test.ts by text markers against the two lane manifests and
  // the measured-fast allowlist, all imported by the checker itself.
  '(realio-lane)': [
    'scripts/check-realio-lane-membership.mjs',
    'scripts/realio-lane-known-fast-spawns.mjs',
    'scripts/realio-lane-inventory.mjs',
    'test/config/realio-lane-membership.mjs',
    'test/config/serial-cpu-lane-membership.mjs',
  ],
  // check-verse-sync-io.mjs scans src/core/verse/*-api.ts for synchronous
  // fs/child-process calls; its only repo input is its own source.
  '(verse-sync-io)': ['scripts/check-verse-sync-io.mjs'],
};

// `npm run lint:realio-lane` (scripts/check-realio-lane-membership.mjs)
// runs after eslint in the same Lint step. With eslint green a red step
// and no stylish block comes from one of the two trailing guards; this
// one prints `[check-realio-lane-membership]` section headers followed by
// bare repo-relative test paths -- the missing-members section adds one
// indented reason line per file, the stale-entries and lane-overlap
// sections list paths only. Gate-failing sections group per named path
// under a `<file> > (realio-lane)` identity; the soft-signal advisory
// section prints the same path shape but never fails the step, and the
// ok line closes the report, so both stay unparsed. Section state ends
// at a blank line once files were seen or at any `##[` step boundary, so
// later steps' output cannot leak paths into a group. Like the other
// parenthesized gate identities these can never resolve through a vitest
// pass line: shared-baseline, pr-caused or unknown -- never
// probable-flake.
const REALIO_LANE_NAMES = '(realio-lane)';
const REALIO_LANE_MAX = 64;
const REALIO_LANE_PATH = /^(?:test|src\/web-ui)\/\S+\.test\.[cm]?[jt]sx?$/;
const realioLanePath = (line: string) => REALIO_LANE_PATH.test(line)
  && posix.normalize(line) === line && !line.includes('..') && !posix.isAbsolute(line);

function parseRealioLaneFailures(log: string): Failure[] {
  const byFile = new Map<string, { header: string[]; reason: string | null }>();
  let section: 'missing' | 'stale' | 'overlap' | null = null;
  let header: string[] = [];
  let seenFile = false;
  let pendingFile: string | null = null;
  const close = () => { section = null; header = []; seenFile = false; pendingFile = null; };
  for (const line of lines(log)) {
    if (byFile.size >= REALIO_LANE_MAX) break;
    if (line.startsWith('##[')) { close(); continue; }
    if (line.startsWith('[check-realio-lane-membership]')) {
      close();
      if (line.includes('use a real-io marker')) { section = 'missing'; header = [line]; }
      else if (line.includes('stale KNOWN_FAST_SPAWN_FILES entries') || line.includes('stale real-I/O or serial-CPU entries')) { section = 'stale'; header = [line]; }
      else if (line.includes('cannot belong to both real-I/O and serial-CPU lanes')) { section = 'overlap'; header = [line]; }
      continue;
    }
    if (section === null) continue;
    if (realioLanePath(line)) {
      if (!byFile.has(line)) {
        if (byFile.size >= REALIO_LANE_MAX) { close(); break; }
        byFile.set(line, { header: [...header], reason: null });
      }
      seenFile = true;
      pendingFile = section === 'missing' ? line : null;
      continue;
    }
    if (!seenFile) {
      // Header zone: blanks and the wrapped second half of a section
      // header precede the section's first file.
      if (line !== '') header.push(line);
      continue;
    }
    if (line === '') { close(); continue; }
    // In the missing-members section the line after a file is its
    // reason; everywhere else a non-path line carries no identity.
    if (pendingFile !== null) {
      const entry = byFile.get(pendingFile);
      if (entry !== undefined) entry.reason = line;
      pendingFile = null;
    }
  }
  const out: Failure[] = [];
  for (const [file, entry] of byFile) {
    const parts = [...entry.header, file];
    if (entry.reason !== null) parts.push(entry.reason);
    out.push({ file, names: REALIO_LANE_NAMES, testId: `${file} > ${REALIO_LANE_NAMES}`, excerpt: clean(parts.join('\n')) });
  }
  return out;
}

// `npm run lint:verse-sync-io` (scripts/check-verse-sync-io.mjs) is the
// last command in the Lint step chain. It refuses synchronous
// fs/child-process calls in src/core/verse/*-api.ts route files and
// prints a count header then one
// `<file>:<line>  <call>(…)  → <hint>` row per violation. Violations
// group per route file under a `<file> > (verse-sync-io)` identity like
// `(lint)`: the guard greps source text and never follows imports, so
// the dependency set is the checker script alone and the vitest harness
// ambient set does not apply. Rows are accepted only between the count
// header and the next `##[` step boundary; the success line, the
// allow-marker trailer and near-miss wording stay unparsed. Like the
// other parenthesized gate identities these can never resolve through a
// vitest pass line: shared-baseline, pr-caused or unknown -- never
// probable-flake.
const VERSE_SYNC_IO_NAMES = '(verse-sync-io)';
const VERSE_SYNC_IO_MAX = 64;
const VERSE_SYNC_IO_PER_FILE = 8;
const VERSE_SYNC_IO_HEADER = /^verse-sync-io: \d+ synchronous call\(s\) in Phantom console route files/;
const VERSE_SYNC_IO_VIOLATION = /^(src\/core\/verse\/\S+-api\.ts):\d+\s+\S+\(…\)\s+→\s+\S/;

function parseVerseSyncIoFailures(log: string): Failure[] {
  const byFile = new Map<string, string[]>();
  let open = false;
  for (const line of lines(log)) {
    if (byFile.size >= VERSE_SYNC_IO_MAX) break;
    if (line.startsWith('##[')) { open = false; continue; }
    if (VERSE_SYNC_IO_HEADER.test(line)) { open = true; continue; }
    if (!open) continue;
    const match = VERSE_SYNC_IO_VIOLATION.exec(line);
    if (match === null) continue;
    const file = match[1]!;
    if (posix.normalize(file) !== file || file.includes('..') || posix.isAbsolute(file)) continue;
    let parts = byFile.get(file);
    if (parts === undefined) {
      parts = [];
      byFile.set(file, parts);
    }
    if (parts.length < VERSE_SYNC_IO_PER_FILE) parts.push(line);
  }
  const out: Failure[] = [];
  for (const [file, parts] of byFile) {
    if (parts.length === 0) continue;
    out.push({ file, names: VERSE_SYNC_IO_NAMES, testId: `${file} > ${VERSE_SYNC_IO_NAMES}`, excerpt: clean(parts.join('\n')) });
  }
  return out;
}

// The `ci` job's qualification lanes wrap the suite runs in
// .github/scripts/ci-qualification-lane.mjs, which re-reads each Vitest
// JSON report and refuses a case that passed only after a retry -- the
// default reporter shows it green, so the step's only failure output is
// this verdict on stderr:
//   Test case passed only after a failed attempt (flaky): test/x.test.ts > suite title
// `file` is the report's repo-relative module path (the script itself
// rejects `..` and absolute paths); `names` is the JSON reporter's
// space-joined ancestor titles plus the case title -- deliberately not
// the default reporter's ` > ` chain, so the identity stays honest about
// which evidence named it. It is not parenthesized, so a green master
// module (`✓ file (N tests)`) resolves it like any vitest failure: a
// one-off flake on an unaffected singleton becomes probable-flake and
// rerun-failed, while a flake repeating across unaffected PRs -- or one
// master itself prints -- groups shared-baseline for a stabilization
// fix. Without this shape a flaky master leaves every open PR unknown
// and queues nothing.
const QUALIFICATION_FLAKY_MAX = 16;
const QUALIFICATION_FLAKY_LINE = /^Test case passed only after a failed attempt \(flaky\): ((?:test|src\/web-ui)\/[^\s>]+\.test\.[cm]?[jt]sx?) > (.+)$/;

function parseQualificationFlakyFailures(log: string): Failure[] {
  const out: Failure[] = [];
  for (const line of lines(log)) {
    if (out.length >= QUALIFICATION_FLAKY_MAX) break;
    const match = QUALIFICATION_FLAKY_LINE.exec(line);
    if (match === null) continue;
    const file = match[1]!, names = clean(match[2]!);
    if (posix.normalize(file) !== file || file.includes('..') || posix.isAbsolute(file)) continue;
    out.push({ file, names, testId: `${file} > ${names}`, excerpt: clean(line) });
  }
  return out;
}

// The `ci` job's "Capture pack smoke build snapshot" step on the ubuntu
// authority 1/3 shard runs `npm run check:first-paint:built`
// (scripts/check-first-paint-budget.mjs --no-build --out-dir
// dist/core/web/public/next --budget-kb 354 --mobile-budget-kb 250)
// between the pack-smoke capture and prepare commands. The gate walks the
// Vite manifest's static-import closure of each first-paint root --
// index.html -> main.tsx -> the Verse apps -> the chat/home screens --
// sums the chunk bytes and fails the step when either arm exceeds its
// budget. A budget break prints no vitest, typecheck, TAP or report shape,
// so without this shape a red master marked every open PR unknown and
// queued no fix. Each over-budget verdict groups per arm under
// `scripts/check-first-paint-budget.mjs > (first-paint) <arm>`: the two
// arms measure different closures against different budgets, so a phone
// regression never merges into the chat group. The script's own error
// path (`check-first-paint-budget: <message>` -- missing manifest,
// renamed first-paint root, manifest import with no entry) groups under
// `(first-paint) gate`. Like the other non-test identities these can
// never resolve through a vitest pass line: shared-baseline, pr-caused or
// unknown -- never probable-flake. The per-file `N.N KB  <file>` listing,
// OK verdicts, --json reports, npm lifecycle noise and unrelated output
// stay unparsed.
const FIRST_PAINT_FILE = 'scripts/check-first-paint-budget.mjs';
const FIRST_PAINT_MAX = 8;
const FIRST_PAINT_OVER_BUDGET = /^OVER BUDGET: (chat|phone)\b.*\bfirst-paint critical JS \d+(?:\.\d+)? KB \(budget \d+(?:\.\d+)? KB\)$/;
const FIRST_PAINT_GATE_ERROR = /^check-first-paint-budget: \S/;

function parseFirstPaintFailures(log: string): Failure[] {
  const out: Failure[] = [];
  for (const line of lines(log)) {
    if (out.length >= FIRST_PAINT_MAX) break;
    const over = FIRST_PAINT_OVER_BUDGET.exec(line);
    if (over !== null) {
      const names = `(first-paint) ${over[1]}`;
      out.push({ file: FIRST_PAINT_FILE, names, testId: `${FIRST_PAINT_FILE} > ${names}`, excerpt: clean(line) });
      continue;
    }
    if (FIRST_PAINT_GATE_ERROR.test(line)) {
      const names = '(first-paint) gate';
      out.push({ file: FIRST_PAINT_FILE, names, testId: `${FIRST_PAINT_FILE} > ${names}`, excerpt: clean(line) });
    }
  }
  return out;
}

// Every `npm run test:ci` invocation -- the fast-gate affected-test
// shards through ci-fast-run.mjs, the quick job's selected contract
// test and the full lanes' hermetic steps -- runs inside
// scripts/test-ci.mjs, which isolates HOME, pipes Vitest through a
// private progress reporter and enforces an inactivity watchdog plus a
// hard runtime cap; the complete partitions run under
// scripts/test-ci-sharded.mjs, which plans shards from the measured
// duration table and spawns the same wrapper per shard. When the
// WRAPPER fails -- Vitest hangs past the idle window or the hard cap,
// dies by signal, cannot spawn, the Node floor is unmet, or the shard
// plan cannot be built -- the step goes red with no vitest FAIL, TAP
// `not ok`, tsc diagnostic or report shape naming it, so every open PR
// reads unknown and queues no fix. Each verdict groups under the
// wrapper script as `scripts/test-ci.mjs > (test-ci)` or
// `scripts/test-ci-sharded.mjs > (test-ci-sharded)`: a hang or crash
// is usually caused by test content the runner cannot name, so the
// dependency set is a closed input list -- the runner scripts, the
// type-stripped memory-policy module test-ci reads as text, the
// reporter and vitest config surface the spawned run executes under,
// the shard plan's duration table and the runner the orchestrator
// spawns, plus the toolchain manifests -- rather than the import
// closure walk, which test-ci's computed data: import cannot survive;
// the vitest harness ambient set does not apply. Like the other
// non-test identities these can never resolve through a vitest pass
// line: shared-baseline, pr-caused or unknown -- never
// probable-flake. The heartbeat, capacity-observer, job-memory,
// lifecycle (`started` / `exited`), aggregate (`FAIL (...)` /
// `PASS (...)`), usage and report-summary lines are progress, cascade
// or companion-runner evidence and stay unparsed: `exited <code>`
// and `exited via <signal>` fire on ordinary test failures and on the
// stopOthers SIGTERM cascade, so they can never be runner identities.
const TEST_CI_FILE = 'scripts/test-ci.mjs';
const TEST_CI_NAMES = '(test-ci)';
const TEST_CI_SHARDED_FILE = 'scripts/test-ci-sharded.mjs';
const TEST_CI_SHARDED_NAMES = '(test-ci-sharded)';
const TEST_RUNNER_MAX = 8;

// [test-ci] verdicts are the wrapper's own stderr lines; the bracketed
// prefix belongs to it alone -- [test-ci-capacity], [test-ci:sharded]
// and [job-memory] carry different prefixes, and heartbeat lines are
// periodic progress, never verdicts.
const TEST_CI_VERDICT = /^\[test-ci\] (?:Node >=22\.15\.0 is required\.|idle-timeout after \d+ms without output\.|hard-runtime-cap reached after \d+ms \(last output \d+ms ago\)|received SIG(?:INT|TERM); terminating the Vitest process tree\.|failed to start Vitest: \S|Vitest exited via signal \S)/;
// [test-ci:sharded] verdicts are the balanced plan's refusal and the
// per-shard spawn errors; every other bracketed line is lifecycle,
// aggregate or usage output owned elsewhere or unparseable on purpose.
const TEST_CI_SHARDED_VERDICT = /^\[test-ci:sharded\] (?:cannot plan balanced shards: \S|\S.* failed to start: \S)/;

function parseTestRunnerFailures(log: string): Failure[] {
  const out: Failure[] = [];
  let ci = 0;
  let sharded = 0;
  for (const line of lines(log)) {
    if (TEST_CI_VERDICT.test(line)) {
      if (ci >= TEST_RUNNER_MAX) continue;
      ci++;
      out.push({ file: TEST_CI_FILE, names: TEST_CI_NAMES, testId: `${TEST_CI_FILE} > ${TEST_CI_NAMES}`, excerpt: clean(line) });
      continue;
    }
    if (TEST_CI_SHARDED_VERDICT.test(line)) {
      if (sharded >= TEST_RUNNER_MAX) continue;
      sharded++;
      out.push({ file: TEST_CI_SHARDED_FILE, names: TEST_CI_SHARDED_NAMES, testId: `${TEST_CI_SHARDED_FILE} > ${TEST_CI_SHARDED_NAMES}`, excerpt: clean(line) });
    }
  }
  return out;
}

// The spawned Vitest run's direct repo inputs, shared by both runner
// identities: the config that collects and times the suites, the
// mock-compat config and setup files it loads, the lane-membership and
// sequencer modules the config imports, and the toolchain manifests
// pinning the runner and compiler.
const TEST_RUNNER_COMMON_INPUTS = [
  'vitest.config.ts',
  'vitest.config.mock-compat.ts',
  'test/setup/home.ts',
  'test/setup/home-isolation-guard.ts',
  'test/config/realio-lane-membership.mjs',
  'test/config/serial-cpu-lane-membership.mjs',
  'test/config/weighted-sequencer.mjs',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
] as const;
const TEST_RUNNER_INPUTS: Record<string, readonly string[]> = {
  [TEST_CI_NAMES]: [TEST_CI_FILE, 'src/core/run/tool-path.ts', 'scripts/vitest-progress-reporter.mjs', ...TEST_RUNNER_COMMON_INPUTS],
  [TEST_CI_SHARDED_NAMES]: [TEST_CI_SHARDED_FILE, 'scripts/test-shard-plan.mjs', 'scripts/test-ci.mjs', 'test/helpers/test-durations.json', ...TEST_RUNNER_COMMON_INPUTS],
};

export function parseBaselineFailures(log: string, repo?: string, auditExceptions: readonly DependencyAuditException[] | null = []): Failure[] {
  const result: Failure[] = [];
  const typecheck = new Map<string, Failure>();
  let current: Failure | undefined;
  let currentSuite = false;
  for (const line of lines(log)) {
    const match = FAIL_LINE.exec(line);
    const suite = match === null ? SUITE_FAIL_LINE.exec(line) : null;
    const tsc = match === null && suite === null ? TSC_ERROR_LINE.exec(line) : null;
    if (match !== null || suite !== null) {
      if (result.length >= 100) break;
      const file = (match ?? suite)![1]!, names = match === null ? SUITE_NAMES : clean(match[2]!);
      if (posix.normalize(file) !== file || file.includes('..')) continue;
      current = { file, names, testId: `${file} > ${names}`, excerpt: clean(line) };
      currentSuite = match === null;
      result.push(current);
    } else if (tsc !== null) {
      if (result.length >= 100) break;
      const file = tsc[1]!;
      if (posix.normalize(file) !== file || file.includes('..') || posix.isAbsolute(file)) continue;
      const existing = typecheck.get(file);
      if (existing !== undefined) {
        existing.excerpt = clean(`${existing.excerpt}\n${line}`);
        continue;
      }
      current = { file, names: TSC_NAMES, testId: `${file} > ${TSC_NAMES}`, excerpt: clean(line) };
      currentSuite = false;
      typecheck.set(file, current);
      result.push(current);
    } else if (current && (/^AssertionError:/.test(line) || (currentSuite && /^[\w$]*Error:/.test(line)))) {
      current.excerpt = clean(`${current.excerpt}\n${line}`);
    }
  }
  for (const failure of parseTapFailures(log, repo)) {
    if (result.length >= 100) break;
    result.push(failure);
  }
  for (const failure of parseDocsCheckFailures(log)) {
    if (result.length >= 100) break;
    result.push(failure);
  }
  for (const failure of parseGeneratedFailures(log)) {
    if (result.length >= 100) break;
    result.push(failure);
  }
  for (const failure of parseVersionSyncFailures(log)) {
    if (result.length >= 100) break;
    result.push(failure);
  }
  for (const failure of parseBuildStepFailures(log, repo)) {
    if (result.length >= 100) break;
    result.push(failure);
  }
  for (const failure of parsePerfBudgetFailures(log)) {
    if (result.length >= 100) break;
    result.push(failure);
  }
  for (const failure of parseAuditFailures(log, auditExceptions)) {
    if (result.length >= 100) break;
    result.push(failure);
  }
  for (const failure of parseArtifactGateFailures(log)) {
    if (result.length >= 100) break;
    result.push(failure);
  }
  for (const failure of parseSecretShapeFailures(log)) {
    if (result.length >= 100) break;
    result.push(failure);
  }
  for (const failure of parseSecretScanFailures(log)) {
    if (result.length >= 100) break;
    result.push(failure);
  }
  for (const failure of parseVersionProvenanceFailures(log)) {
    if (result.length >= 100) break;
    result.push(failure);
  }
  for (const failure of parseCiScriptGateFailures(log)) {
    if (result.length >= 100) break;
    result.push(failure);
  }
  for (const failure of parseInstallFailures(log)) {
    if (result.length >= 100) break;
    result.push(failure);
  }
  for (const failure of parseInstallSmokeFailures(log)) {
    if (result.length >= 100) break;
    result.push(failure);
  }
  for (const failure of parseMemoryBenchmarkFailures(log)) {
    if (result.length >= 100) break;
    result.push(failure);
  }
  for (const failure of parseLintFailures(log, repo)) {
    if (result.length >= 100) break;
    result.push(failure);
  }
  for (const failure of parseRealioLaneFailures(log)) {
    if (result.length >= 100) break;
    result.push(failure);
  }
  for (const failure of parseVerseSyncIoFailures(log)) {
    if (result.length >= 100) break;
    result.push(failure);
  }
  for (const failure of parseQualificationFlakyFailures(log)) {
    if (result.length >= 100) break;
    result.push(failure);
  }
  for (const failure of parseFirstPaintFailures(log)) {
    if (result.length >= 100) break;
    result.push(failure);
  }
  for (const failure of parseTestRunnerFailures(log)) {
    if (result.length >= 100) break;
    result.push(failure);
  }
  return result;
}

export async function analyzeCiBaseline(repo: string, gh: CloudGh = defaultCiGh) {
  if (!/^[\w-][\w.-]*\/[\w-][\w.-]*$/.test(repo)) throw new Error('Invalid repository');
  const errors: string[] = [];
  async function json<T>(endpoint: string): Promise<T | null> {
    try {
      const r = await gh(['api', endpoint]);
      return r.ok ? JSON.parse(r.stdout) as T : null;
    } catch { return null; }
  }
  async function runs(ref: string): Promise<Run[] | null> {
    const data = await json<{ workflow_runs: Run[]; total_count: number }>(`repos/${repo}/actions/runs?head_sha=${encodeURIComponent(ref)}&per_page=100`);
    if (!Array.isArray(data?.workflow_runs) || data.total_count > 100) return null;
    const seen = new Set<number>();
    return data.workflow_runs.filter(r => { if (seen.has(r.workflow_id)) return false; seen.add(r.workflow_id); return true; });
  }
  async function logs(run: Run, head: string): Promise<{ entries: { conclusion: string; text: string }[]; incomplete: boolean } | null> {
    const data = await json<{ jobs: Job[]; total_count: number }>(`repos/${repo}/actions/runs/${run.id}/jobs?per_page=100`);
    if (!Array.isArray(data?.jobs) || data.total_count > 100) return null;
    // A job that never reached a verdict — cancelled while queued, timed
    // out, awaiting action, failed to start, or marked stale — is
    // incomplete evidence even when its log is absent or empty: the run
    // cannot prove the ref's checks, so the caller reads unknown rather
    // than clean. The flag is computed from the job list itself, so a
    // never-started job counts the same as one whose partial log would
    // otherwise verify or drop silently.
    // The workflow can stop before starting other jobs. Its conclusion
    // still applies when every listed job reached a verdict.
    const incomplete = data.jobs.some(job => INCOMPLETE_CONCLUSIONS.has(job.conclusion)) ||
      (run.conclusion !== undefined && INCOMPLETE_CONCLUSIONS.has(run.conclusion)) ||
      (data.jobs.length === 0 && run.conclusion === 'failure');
    const result: { conclusion: string; text: string }[] = [];
    for (const job of data.jobs) {
      if (job.conclusion === 'skipped') continue;
      if (job.head_sha !== head) return null;
      let r = null;
      try { r = await gh(['api', `repos/${repo}/actions/jobs/${job.id}/logs`]); } catch { /* Log unavailable. */ }
      if (!r?.ok) {
        // The job list already marks this run incomplete. A job that
        // never started may have no log, while its siblings still do.
        if (INCOMPLETE_CONCLUSIONS.has(job.conclusion)) continue;
        return null;
      }
      const output = lines(r.stdout);
      // Check every explicit revision proof before using the job's evidence.
      // A later checkout can contradict an initially correct proof.
      let explicitProof = false;
      for (const [index, line] of output.entries()) {
        const bound = BOUND_LINE.exec(line);
        if (bound) {
          if (bound[1] !== head) return null;
          explicitProof = true;
        } else if (/(?:^|\/)git log -1 --format=%H$/.test(line)) {
          if (output[index + 1] !== head) return null;
          explicitProof = true;
        }
      }
      if (explicitProof) {
        result.push({ conclusion: job.conclusion, text: r.stdout });
        continue;
      }
      // Gate jobs that never run ci-source-binding.mjs prove the checkout
      // through the runner's resolved `with: ref:` echo instead; it
      // verifies only when every checkout step in the log pins `ref:` to
      // the head.
      if (checkoutRefsVerify(output, head)) {
        result.push({ conclusion: job.conclusion, text: r.stdout });
        continue;
      }
      // Aggregator jobs that never check out the workspace (Merge Gate,
      // release autotag) cannot emit the checkout SHA this check requires.
      // Their logs are dropped from evidence only when they carry nothing
      // the analyzer consumes; any recognizable failure or pass output in
      // an unverifiable log keeps the whole run unknown rather than letting
      // unattributed evidence pass as head-verified.
      if (parseBaselineFailures(r.stdout, repo).length > 0 || output.some(line => PASS_LINE.test(line))) return null;
    }
    return { entries: result, incomplete };
  }
  const branch = await json<{ commit: { sha: string } }>(`repos/${repo}/branches/master`);
  const masterRuns = branch?.commit?.sha ? await runs(branch.commit.sha) : null;
  const masterLogs: { conclusion: string; text: string }[] = [];
  let masterKnown = !!branch?.commit?.sha && !!masterRuns?.length;
  for (const run of masterRuns ?? []) {
    if (run.head_sha !== branch?.commit?.sha || run.status !== 'completed') { masterKnown = false; continue; }
    const evidence = await logs(run, run.head_sha);
    // An incomplete check (cancelled, timed-out, ...) keeps its verified
    // job evidence — a sibling failure is still real master evidence —
    // but the run cannot prove master green, so known drops to false.
    if (evidence) { masterLogs.push(...evidence.entries); if (evidence.incomplete) masterKnown = false; }
    else masterKnown = false;
  }
  const dependencyCache = new Map<string, Promise<Set<string> | null>>();
  const contentsCache = new Map<string, Promise<{ ok: boolean; absent: boolean; source: string | null }>>();
  const ref = branch?.commit?.sha ?? 'master';
  // The Dependency Audit job prints npm's audit v2 JSON once per lockfile
  // graph; advisories covered by .github/dependency-audit-exceptions.json
  // are accepted rather than failures, so the parser replays the gate
  // script's exemption fixpoint against master's exception list. An
  // absent file means no exceptions; an unreadable or malformed one
  // yields null and audit reports then stay unparsed (unknown) rather
  // than risk a phantom group for an accepted advisory.
  let auditExceptions: DependencyAuditException[] | null = null;
  {
    const fetched = await contents('.github/dependency-audit-exceptions.json');
    if (fetched.absent) auditExceptions = [];
    else if (fetched.ok && fetched.source !== null) auditExceptions = parseAuditExceptions(fetched.source);
  }
  const masterFailures = masterLogs.flatMap(l => parseBaselineFailures(l.text, repo, auditExceptions));
  // Parenthesized identities are gate checks, not vitest tests: only
  // '(suite)' resolves through pass evidence, because the file loading is
  // what failed. '(lint)', '(typecheck)' and the other gate names can never
  // be flakes even when their file happens to be a test path a green-module
  // line could otherwise match.
  const filePassable = (names: string) => names === SUITE_NAMES || !names.startsWith('(');
  // A suite failure has no per-test pass line to match: the file loading and
  // running at all is what resolves it. The default reporter's green-module
  // line (`✓ file (N tests)`) is the same evidence at file granularity -- a
  // green module means every test it contains passed on master.
  const passes = (f: Failure) => filePassable(f.names) && masterKnown && !masterFailures.some(m => m.testId === f.testId) && masterLogs.some(l => l.conclusion === 'success' && lines(l.text).some(line => {
    const m = PASS_LINE.exec(line);
    if (m) return m[1] === f.file && (f.names === SUITE_NAMES || m[2] === f.names);
    return FILE_PASS_LINE.exec(line)?.[1] === f.file;
  }));
  // Bundler-resolution candidates for one normalized repo-relative spec base.
  // Explicit extensions keep TypeScript precedence (.js -> .ts before .tsx,
  // the literal spec last so a real .js/.mjs file still resolves); extensionless
  // specs try file then directory index; every other extension (.json, css,
  // assets, query-stripped specs) resolves to itself and joins the closure as
  // a leaf without recursion.
  function specCandidates(base: string): string[] {
    if (base === '.') return ['index.ts', 'index.tsx'];
    const ext = posix.extname(base).toLowerCase();
    const stem = base.slice(0, base.length - ext.length);
    switch (ext) {
      case '.js': return [`${stem}.ts`, `${stem}.tsx`, base];
      case '.jsx': return [`${stem}.tsx`, `${stem}.ts`, base];
      case '.mjs': return [`${stem}.mts`, base];
      case '.cjs': return [`${stem}.cts`, base];
      case '': return [`${base}.ts`, `${base}.tsx`, `${base}/index.ts`, `${base}/index.tsx`];
      default: return [base];
    }
  }
  const CODE_EXT = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
  const isCode = (path: string) => CODE_EXT.has(posix.extname(path).toLowerCase());
  async function contents(path: string) {
    let pending = contentsCache.get(path);
    if (!pending) {
      pending = (async () => {
        try {
          const r = await gh(['api', `repos/${repo}/contents/${path}?ref=${ref}`]);
          if (!r.ok) return { ok: false, absent: /404|not found/i.test(r.stderr ?? ''), source: null };
          const data = JSON.parse(r.stdout) as { content?: unknown; encoding?: unknown };
          if (data?.encoding !== 'base64' || typeof data.content !== 'string') return { ok: false, absent: false, source: null };
          return { ok: true, absent: false, source: Buffer.from(data.content, 'base64').toString('utf8') };
        } catch { return { ok: false, absent: false, source: null }; }
      })();
      contentsCache.set(path, pending);
    }
    return pending;
  }
  function dependencies(file: string): Promise<Set<string> | null> {
    const cached = dependencyCache.get(file);
    if (cached) return cached;
    const task = (async () => {
      const visited = new Set<string>();
      // A gate script's inputs can be data files no import closure reaches
      // (release metadata for sync-candidate-version); seed them so a PR
      // touching any input counts as touched.
      for (const input of STATIC_FAILURE_INPUTS[file] ?? []) visited.add(input);
      // Only code has an import closure: a Markdown report, JSON or asset
      // failure file depends on itself alone. Scanning prose for import
      // syntax would let a doc's code sample fail the whole closure closed.
      // Generated artifacts are the exception: they have no import closure
      // either, but their staleness is caused by a known input set -- the
      // generator scripts and sources in GENERATED_FILE_INPUTS, plus (for
      // docs/llms.txt) every public docs page on master.
      if (!isCode(file)) {
        visited.add(file);
        const inputs = GENERATED_FILE_INPUTS[file];
        if (inputs === undefined) return visited;
        for (const input of inputs) visited.add(input);
        if (file === 'docs/llms.txt') {
          const pages = await publicDocsPages();
          if (pages === null) return null;
          for (const page of pages) visited.add(page);
        }
        return visited;
      }
      async function visit(path: string): Promise<boolean> {
        if (visited.has(path)) return true;
        if (visited.size >= 100 || path.startsWith('../')) return false;
        visited.add(path);
        const fetched = await contents(path);
        if (!fetched.ok || fetched.source === null) return false;
        const source = fetched.source;
        // Computed imports cannot be proved independent of a PR diff.
        if (/import\s*\(\s*[^'"\s]/.test(source)) return false;
        for (const match of source.matchAll(/(?:from\s*|import\s*\(\s*|import\s*)['"]([^'"]+)['"]/g)) {
          const spec = match[1]!;
          if (spec.startsWith('node:')) continue;
          if (!spec.startsWith('.')) {
            if (spec.startsWith('#') || spec.startsWith('@/')) return false;
            for (const manifest of ['package.json', 'package-lock.json', 'pnpm-lock.yaml']) visited.add(manifest);
            continue;
          }
          const queryIndex = spec.indexOf('?');
          const cleanSpec = queryIndex === -1 ? spec : spec.slice(0, queryIndex);
          const query = queryIndex === -1 ? '' : spec.slice(queryIndex);
          const base = posix.normalize(posix.join(posix.dirname(path), cleanSpec));
          if (base.startsWith('../') || posix.isAbsolute(base)) return false;
          let resolved: string | null = null;
          for (const candidate of specCandidates(base)) {
            const hit = await contents(candidate);
            if (hit.ok) { resolved = candidate; break; }
            // A definitive 404 tries the next candidate; any other failure
            // (rate limit, 5xx, malformed body) fails the whole closure closed.
            if (!hit.absent) return false;
          }
          if (resolved === null) return false;
          // Asset queries (?raw/?url/?inline) embed file contents or URLs; the
          // resolved file is a leaf dep and its own imports never execute.
          if (!isCode(resolved) || /[?&](?:raw|url|inline)\b/.test(query)) { visited.add(resolved); continue; }
          if (!await visit(resolved)) return false;
        }
        return true;
      }
      return await visit(file) ? visited : null;
    })();
    dependencyCache.set(file, task);
    return task;
  }

  // ---------------------------------------------------------------------
  // Harness dependencies
  //
  // A test's import closure misses everything the RUNNER injects: the vitest
  // config itself (timeouts, lane membership, sequencer), its setupFiles and
  // globalSetup entries, and whatever those import (HOME guards, mock shims,
  // src helpers). It also misses toolchain configs (tsconfig/jsconfig) that
  // change how sources transform, and manifests for suites running without
  // bare imports (vitest globals mode). A PR touching only the harness fails
  // suites whose own closures look untouched — without this union it is
  // misread as a flake or a shared-baseline break.
  //
  // Harness deps resolve once per repo. An unreadable governing config, an
  // unresolvable setup entry, or a failed probe yields null — the touched
  // check then fails closed (unknown), never "unaffected".
  //
  // Runner configs are discovered by name, not probed: `vitest.config.web.ts`,
  // `vitest.config.coverage.mjs` and friends all govern suites, so the root
  // listing (one API call) is filtered for the vitest config/workspace shape.
  const VITEST_CONFIG_NAME = /^vitest\.(?:config|workspace)(?:\.[\w-]+)*\.[cm]?[jt]sx?$/;
  const HARNESS_AMBIENT_BASE = ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'tsconfig.json', 'jsconfig.json'];
  const HARNESS_QUOTED = /'([^']*)'|"([^"]*)"|`([^`]*)`/g;
  const HARNESS_GLOB_CHARS = /[*?[\]{}]/;

  interface HarnessConfig { path: string; includes: string[]; setups: string[] }

  function harnessLiterals(source: string, keyPattern: RegExp): string[] {
    const out: string[] = [];
    for (const m of source.matchAll(keyPattern)) {
      for (const q of m[1]!.matchAll(HARNESS_QUOTED)) out.push(q[1] ?? q[2] ?? q[3] ?? '');
    }
    return out;
  }

  // Path strings in a config are relative to the config's directory. `..`
  // escapes and glob setup entries cannot be enumerated without a tree listing,
  // so they fail the whole harness closed rather than guess.
  function harnessRepoPath(dir: string, entry: string): string | null {
    const joined = posix.normalize(posix.join(dir === '.' ? '' : dir, entry));
    return joined === '..' || joined.startsWith('../') || posix.isAbsolute(joined) ? null : joined;
  }

  function parseHarnessConfig(path: string, source: string): HarnessConfig | 'degraded' {
    const dir = posix.dirname(path);
    const setups = new Set<string>();
    for (const entry of harnessLiterals(source, /(?:setupFiles|globalSetup)\s*:\s*(\[[^\]]*\]|['"`][^'"`]*['"`])/g)) {
      if (!entry.startsWith('.')) continue; // bare specifier: package manifests are already ambient
      if (HARNESS_GLOB_CHARS.test(entry)) return 'degraded';
      const resolved = harnessRepoPath(dir, entry);
      if (resolved === null) return 'degraded';
      setups.add(resolved);
    }
    const includes = harnessLiterals(source, /\binclude\s*:\s*(\[[^\]]*\]|['"`][^'"`]*['"`])/g)
      .map(g => harnessRepoPath(dir, g))
      .filter((g): g is string => g !== null);
    return { path, includes, setups: [...setups] };
  }

  let harnessDiscovery: Promise<HarnessConfig[] | null> | null = null;
  function discoverHarnessConfigs(): Promise<HarnessConfig[] | null> {
    harnessDiscovery ??= (async () => {
      let names: string[];
      try {
        const r = await gh(['api', `repos/${repo}/contents/?ref=${ref}`]);
        if (!r.ok) return null;
        const entries = JSON.parse(r.stdout) as { name?: unknown; type?: unknown }[] | null;
        if (!Array.isArray(entries)) return null;
        names = entries
          .filter(e => e?.type === 'file' && typeof e?.name === 'string' && VITEST_CONFIG_NAME.test(e.name))
          .map(e => e.name as string)
          .sort();
      } catch {
        return null;
      }
      const configs: HarnessConfig[] = [];
      for (const name of names) {
        const fetched = await contents(name);
        if (fetched.ok && fetched.source !== null) {
          const parsed = parseHarnessConfig(name, fetched.source);
          if (parsed === 'degraded') return null;
          configs.push(parsed);
        } else if (!fetched.absent) {
          return null;
        }
      }
      return configs;
    })();
    return harnessDiscovery;
  }

  // docs/llms.txt renders from every public docs page -- docs/**/*.md minus
  // the top-level docs/internal/ directory, regular files only, matching
  // scripts/lib/docs-pages.mjs. The page set comes from one recursive master
  // tree listing per analysis; an unreadable or truncated tree fails the
  // generated-file closure closed (unknown), never an empty page set.
  let docsPagesListing: Promise<Set<string> | null> | null = null;
  function publicDocsPages(): Promise<Set<string> | null> {
    docsPagesListing ??= (async () => {
      try {
        const r = await gh(['api', `repos/${repo}/git/trees/${ref}?recursive=1`]);
        if (!r.ok) return null;
        const data = JSON.parse(r.stdout) as { tree?: unknown; truncated?: unknown } | null;
        if (!Array.isArray(data?.tree) || data.truncated === true) return null;
        const pages = new Set<string>();
        for (const entry of data.tree as { path?: unknown; type?: unknown; mode?: unknown }[]) {
          if (entry?.type !== 'blob' || (entry.mode !== '100644' && entry.mode !== '100755')) continue;
          const path = entry.path;
          if (typeof path !== 'string' || !path.startsWith('docs/') || !path.endsWith('.md') || path.startsWith('docs/internal/')) continue;
          pages.add(path);
        }
        return pages;
      } catch { return null; }
    })();
    return docsPagesListing;
  }

  const harnessFileCache = new Map<string, Promise<Set<string> | null>>();
  function harnessAmbient(file: string): Promise<Set<string> | null> {
    let pending = harnessFileCache.get(file);
    if (!pending) {
      pending = (async () => {
        const configs = await discoverHarnessConfigs();
        if (configs === null) return null;
        const out = new Set(HARNESS_AMBIENT_BASE);
        for (const cfg of configs) {
          // No literal includes means the config's collection scope cannot be
          // proven narrow, so it governs every suite (conservative).
          if (cfg.includes.length > 0 && !cfg.includes.some(g => globMatches(g, file))) continue;
          const own = await dependencies(cfg.path);
          if (own === null) return null;
          for (const p of own) out.add(p);
          for (const setup of cfg.setups) {
            const closure = await dependencies(setup);
            if (closure === null) return null;
            for (const p of closure) out.add(p);
          }
        }
        // Nearest toolchain config walking up from the test file: bundlers read
        // the closest tsconfig/jsconfig per transformed file.
        let dir = posix.dirname(file);
        for (;;) {
          for (const name of ['tsconfig.json', 'jsconfig.json']) {
            const p = dir === '.' ? name : `${dir}/${name}`;
            const fetched = await contents(p);
            if (fetched.ok) out.add(p);
            else if (!fetched.absent) return null;
          }
          if (dir === '.') break;
          const parent = posix.dirname(dir);
          if (parent === dir) break;
          dir = parent;
        }
        return out;
      })();
      harnessFileCache.set(file, pending);
    }
    return pending;
  }

  let prs: Pr[] = [];
  try {
    const r = await gh(['pr', 'list', '--repo', repo, '--state', 'open', '--limit', '100', '--json', 'number,headRefOid,headRefName,files']);
    if (r.ok) prs = JSON.parse(r.stdout) as Pr[]; else errors.push('open PRs unreadable');
    if (!Array.isArray(prs)) { prs = []; errors.push('invalid PR list'); }
  } catch { errors.push('open PRs unreadable'); }
  if (prs.length === 100) errors.push('PR list capped at 100');
  const freshness: { pr: number; head: string; state: string; reason?: string }[] = [];
  const observations: Observation[] = [];
  for (const pr of prs) {
    const data = await json<{ workflow_runs: Run[]; total_count: number }>(`repos/${repo}/actions/runs?branch=${encodeURIComponent(pr.headRefName)}&per_page=100`);
    const seen = new Set<number>();
    const latest = data?.workflow_runs?.filter(r => { if (seen.has(r.workflow_id)) return false; seen.add(r.workflow_id); return true; });
    if (!latest?.length || data!.total_count > 100) { freshness.push({ pr: pr.number, head: pr.headRefOid, state: 'unknown', reason: 'missing-or-capped-runs' }); continue; }
    if (latest.some(r => r.head_sha !== pr.headRefOid)) { freshness.push({ pr: pr.number, head: pr.headRefOid, state: 'stale', reason: 'stale-head' }); continue; }
    let known = true;
    let incomplete = false;
    const found: (Failure & { runId: number })[] = [];
    for (const run of latest) {
      if (run.status !== 'completed') { known = false; continue; }
      const evidence = await logs(run, pr.headRefOid);
      // A run with an incomplete check — a job cancelled, timed out,
      // awaiting action, failed to start or gone stale, or a jobless
      // run that did not succeed — cannot prove the head's checks, so
      // the PR reads unknown rather than fresh.
      if (!evidence) { known = false; continue; }
      if (evidence.incomplete) { known = false; incomplete = true; continue; }
      for (const log of evidence.entries.filter(l => l.conclusion === 'failure')) {
        const failures = parseBaselineFailures(log.text, repo, auditExceptions);
        if (!failures.length) known = false;
        found.push(...failures.map(failure => ({ ...failure, runId: run.id })));
      }
    }
    freshness.push({ pr: pr.number, head: pr.headRefOid, state: known ? 'fresh' : 'unknown', ...(!known ? { reason: incomplete ? 'incomplete-check' : 'unreadable-log-or-unverified-checkout' } : {}) });
    if (!known) continue;
    for (const failure of found) {
      // Lint-guard, first-paint, test-runner and install-step failures are
      // per-file/per-arm/per-runner/per-manifest like eslint: the checkers
      // grep source text, measure bundle bytes, wrap the suite run or read
      // the dependency manifests, and never read a file's imports, so the
      // dependency set is each gate's closed input list rather than the
      // import closure walk.
      const flatInputs = LINT_GUARD_INPUTS[failure.names] ?? FIRST_PAINT_INPUTS[failure.names] ?? TEST_RUNNER_INPUTS[failure.names] ?? SECRET_GATE_INPUTS[failure.names] ?? INSTALL_STEP_INPUTS[failure.names] ?? INSTALL_SMOKE_INPUTS[failure.names] ?? BUILD_STEP_INPUTS[failure.file];
      const deps = flatInputs !== undefined ? new Set<string>(flatInputs) : await dependencies(failure.file);
      // Generated artifacts are produced by the clean-tree job, not the test
      // runner: the vitest harness ambient set cannot stale them, so only
      // the generator-input deps decide touched. The version-sync gate reads
      // exactly its enumerated metadata inputs, the dependency-audit gate
      // exactly its lockfile input set, the pack-smoke/artifact gates
      // plain .mjs scripts plus their enumerated manifests, the memory
      // benchmark gate a tsx script plus its import closure and seeded
      // toolchain inputs, the eslint/realio-lane/verse-sync-io lint guards
      // and the first-paint budget arms read closed input lists outside
      // the harness, and the secret-shape/
      // secret-scan/version-provenance trust gates have no vitest harness
      // at all, so the ambient set cannot reach any of them.
      const ambient = failure.names === GENERATED_NAMES || failure.names === VERSION_SYNC_NAMES || failure.names === PACK_SMOKE_NAMES || failure.names === HOSTED_ARTIFACT_NAMES || failure.names === SECRET_SHAPE_NAMES || failure.names === SECRET_SCAN_NAMES || failure.names === VERSION_PROVENANCE_NAMES || failure.names === MEMORY_BENCHMARK_NAMES || failure.names === BUILD_STEP_NAMES || flatInputs !== undefined || failure.names.startsWith(`${DEPENDENCY_AUDIT_NAMES} `) || CI_SCRIPT_GATE_FILES.has(failure.file) ? new Set<string>() : await harnessAmbient(failure.file);
      const touched = pr.files?.some(f => f.path === failure.file) ? true : deps && ambient && pr.files?.length < 100 ? pr.files.some(f => deps.has(f.path) || ambient.has(f.path)) : null;
      observations.push({ pr, failure, touched, runId: failure.runId });
    }
  }
  const ids = [...new Set(observations.map(o => o.failure.testId))].sort();
  const groups = ids.map(testId => {
    const rows = observations.filter(o => o.failure.testId === testId);
    const { file, names, testId: id, excerpt } = rows[0]!.failure;
    const failure = { file, names, testId: id, excerpt };
    const runs = [...new Map(rows.map(o => [`${o.pr.headRefOid}:${o.runId}`, { pr: o.pr.number, head: o.pr.headRefOid, runId: o.runId }])).values()];
    const unaffected = [...new Set(rows.filter(o => o.touched === false).map(o => o.pr.number))];
    const prNumbers = [...new Set(rows.map(o => o.pr.number))];
    const classification = unaffected.length >= 2 ? 'shared-baseline' : rows.every(o => o.touched === true) ? 'pr-caused' : prNumbers.length === 1 && rows[0]!.touched === false && passes(failure) ? 'probable-flake' : 'unknown';
    const action = classification === 'shared-baseline' ? 'queue-master-fix' : classification === 'probable-flake' ? 'rerun-failed' : classification === 'pr-caused' ? 'pr-caused' : 'unknown';
    const evidence = { ...failure, runs };
    const jobId = `RQ-CIBASE-${createHash('sha256').update(repo + ':' + testId).digest('hex').slice(0, 16).toUpperCase()}`;
    const brief = `Reproduce ${testId} on latest master in ${repo}; verify the intentional production contract before changing anything. Fix only the stale baseline or report if not reproducible; never weaken tests or edit Security GATES v3 files. Run affected tests. Include ${jobId} in the fix PR body. Blocked PRs: ${unaffected.join(', ')}. After merge, re-analyze and plan update-branch for unchanged heads.`;
    return { ...evidence, prs: prNumbers, unaffectedPrs: unaffected, classification, action, master: passes(failure) ? 'pass' : masterFailures.some(f => f.testId === testId) ? 'fail' : 'unknown', jobId, ...(action === 'queue-master-fix' ? { brief: clean(brief).replace(/[\r\n]/g, ' ') } : {}) };
  });
  const updates = groups.filter(g => g.classification === 'shared-baseline').flatMap(g => g.unaffectedPrs.map(pr => ({ pr, testId: g.testId, ready: g.master === 'pass', reason: g.master === 'pass' ? 'master-test-passes; merge provenance requires verification' : 'master-fix-not-verified', args: ['api', '-X', 'PUT', `repos/${repo}/pulls/${pr}/update-branch`, '-f', `expected_head_sha=${prs.find(p => p.number === pr)!.headRefOid}`] })));
  return { v: 1, repo, groups, freshness, master: { head: branch?.commit?.sha ?? null, known: masterKnown }, updates, errors };
}

export function enqueueBaselineFixes(report: Awaited<ReturnType<typeof analyzeCiBaseline>>, queuePath: string) {
  if (!isAbsolute(queuePath)) throw new Error('queue-file must be absolute');
  mkdirSync(dirname(queuePath), { recursive: true });
  const queued: string[] = [];
  let existing = existsSync(queuePath) ? readFileSync(queuePath, 'utf8') : '';
  for (const group of report.groups) {
    if (group.action !== 'queue-master-fix' || !group.brief) continue;
    const retry = nextFixGeneration(existing, group.jobId);
    if (!retry) continue;
    const brief = retry.generation === 1 ? group.brief
      : `${group.brief} Stabilization attempt ${retry.generation}: earlier attempts for this test reached DONE and the failure is still observed on current evidence; queue id ${retry.jobId} — include ${retry.jobId} in the fix PR body.`;
    const line = `\n- READY ${retry.jobId} (P1, repo=${report.repo.split('/')[1]}, tier=work, needs=git|gh|node): ${brief}\n`;
    appendFileSync(queuePath, line, 'utf8'); existing += line; queued.push(retry.jobId);
  }
  return queued;
}

export async function applyBaselineUpdates(report: Awaited<ReturnType<typeof analyzeCiBaseline>>, gh: CloudGh = defaultCiGh) {
  const results: { pr: number; state: string }[] = [];
  for (const pr of new Set(report.updates.map(u => u.pr))) {
    const updates = report.updates.filter(u => u.pr === pr);
    let verified = updates.every(u => u.ready);
    try {
      for (const update of updates) {
        if (!verified) break;
        const group = report.groups.find(g => g.testId === update.testId)!;
        const response = await gh(['pr', 'list', '--repo', report.repo, '--state', 'merged', '--base', 'master', '--search', `${group.jobId} in:body`, '--json', 'body,mergeCommit', '--limit', '10']);
        const fixes = response.ok ? JSON.parse(response.stdout) as { body: string; mergeCommit: { oid: string } }[] : [];
        verified = false;
        for (const fix of fixes) {
          if (!fix.body.includes(group.jobId) || !/^[a-f0-9]{40}$/.test(fix.mergeCommit?.oid)) continue;
          const comparison = await gh(['api', `repos/${report.repo}/compare/${fix.mergeCommit.oid}...${report.master.head}`]);
          if (comparison.ok && ['ahead', 'identical'].includes((JSON.parse(comparison.stdout) as { status: string }).status)) verified = true;
        }
      }
      if (!verified) { results.push({ pr, state: 'skipped: master-fix-merge-unverified' }); continue; }
      const response = await gh(updates[0]!.args);
      results.push({ pr, state: response.ok ? 'updated' : 'failed' });
    } catch { results.push({ pr, state: 'unknown' }); }
  }
  return results;
}
