import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Script } from 'node:vm';

/**
 * Paths whose change can move the authority drift snapshots: src/ (Tier-1 roots and closure),
 * test/ (CODEOWNERS covers Tier-1 tests by import, and the snapshot lives in test/fixtures),
 * scripts/ (the closure also walks shipped scripts), and CODEOWNERS itself.
 */
export function affectsAuthorityDrift(path) {
  return path.startsWith('src/') || path.startsWith('test/') || path.startsWith('scripts/') || path === '.github/CODEOWNERS';
}

/**
 * Markdown paths can break operator-doc links and anchors, and any deleted
 * path can be a link target that no longer resolves; both select the docs
 * check. A modified non-markdown file keeps every link target in place.
 */
const DOC_MARKDOWN = /\.md$/i;

/**
 * Test/spec file shape and ledger path mirrored from
 * scripts/check-quarantine-ledger.mjs (TEST_FILE, LEDGER_PATH). The basename
 * class is deliberately wider here — whitespace names the checker ignores can
 * only over-select, never under-select, and the checker stays authoritative
 * for violations. A change can introduce a quarantine violation only by
 * touching a test file (added skip markers, or a deleted file that stales a
 * ledger row) or the ledger itself, so anything else skips the check.
 */
const QUARANTINE_TEST_FILE = /(?:^|\/)[^/]+\.(?:test|spec)\.[cm]?[jt]sx?$/;
const QUARANTINE_LEDGER = 'queue/quarantine.tsv';

/**
 * Two committed data files carry a grammar their names do not advertise:
 * Cargo.lock is TOML (cargo metadata/build rejects a malformed lock the
 * same way it rejects a broken Cargo.toml), and *.tsbuildinfo is the JSON
 * incremental-build record tsc reads on every typecheck. The verify run's
 * own build-info files live under the gitignored .ashlr-gate/ tree or the
 * .git/-resident default cache, so only tsbuildinfo files that are
 * actually changed source — like the tracked
 * src/web-ui/tsconfig.minimal.tsbuildinfo — reach selection.
 */
const CARGO_LOCK_FILE = /(?:^|\/)Cargo\.lock$/;
const TSBUILDINFO_FILE = /\.tsbuildinfo$/;

/**
 * src/raycast and examples/universe-site own their toolchains: eslint.config.js
 * ignores both trees and no root tsconfig includes them, so a changed script
 * there escapes lint, typecheck and the shebang buckets — shipped authored
 * code (a Raycast extension, the public showcase) no check ever parses.
 * workplans/ and undefined/ stay out: the same ignore list exempts them as
 * scratch, not shipped source.
 */
const DETACHED_SCRIPT_TREE = /^(?:src\/raycast|examples\/universe-site)\//;
const DETACHED_SCRIPT_FILE = /\.(?:[cm]?[jt]sx?)$/;

/**
 * The contrib/ TypeScript surface is operational fleet machinery — the
 * Ashlr issue→PR router supervisor and the Mac bridge's memory guard —
 * that runs under tsx or node directly: ESLint's flat config still lints
 * the files, but no tsconfig project covers the tree (the backend project
 * includes only src/, the web and desktop projects their own trees) and
 * no check ever type-checked them. verify-changed closes the hole with
 * one tsc file-list run over the whole contrib TypeScript surface, the
 * invocation contrib/router/SUPERVISOR.md documents.
 *
 * Two program boundaries feed that run:
 *  - contrib/router keeps its documented non-recursive boundary: top-level
 *    *.ts only — lib/ holds shell helpers and router_io.cjs (a spawned
 *    subprocess payload, never imported) and test/ a bash suite — so
 *    nested files are never program roots; they still join through
 *    imports.
 *  - Every other .ts-family file under contrib/, at any depth, is a
 *    satellite root — today contrib/mac/memguard, the Mac bridge's memory
 *    guard backend tests import, which sat in the same hole.
 *
 * The program's only reach outside contrib/ is
 * src/core/authority/protected-paths.ts, and a dependency bump can break
 * it through the shared manifests, so the trigger names those inputs; a
 * new cross-boundary import must extend it. scripts/, examples/, test/
 * and the root configs stay outside every project on their own
 * boundaries — each needs its own verified program before a check can
 * claim it.
 */
const CONTRIB_DIR = 'contrib';
const CONTRIB_ROUTER_DIR = 'contrib/router';
const ROUTER_PROGRAM_FILE = /\.ts$/;
const CONTRIB_TS_FILE = /\.[cm]?tsx?$/;
const ROUTER_SRC_BOUNDARY = 'src/core/authority/protected-paths.ts';
const SHARED_MANIFEST_FILE = /^package(?:-lock)?\.json$/;

/**
 * Shipped .html pages embed three grammars no other check reads: classic and
 * module <script> bodies, JSON script payloads (ld+json, importmap,
 * speculationrules) and <style> rules. ESLint never looks inside markup, the
 * shebang buckets need a dotless basename, and the site's own tests parse the
 * DOM without running scripts — a syntax error ships silently until a
 * browser drops the block. test/fixtures/ payloads are exempt like the
 * conflict scan's: fixtures may intentionally embed broken markup as input.
 */
const HTML_FILE = /\.html?$/i;

/**
 * PowerShell script/module/manifest extensions share one grammar: the
 * Language.Parser API parses all three without executing. The repo's only
 * member today is scripts/install.ps1 — the shipped Windows per-user
 * installer `irm ... | iex` runs on user machines — which no tsconfig,
 * eslint grammar or other step ever reads, so a syntax error would ship
 * silently to every Windows install.
 */
const POWERSHELL_FILE = /\.ps[dm]?1$/i;

/**
 * scripts/check-realio-lane-membership.mjs reads every .test.ts file under
 * test/ (contents decide the spawn-marker verdict) plus its lane manifests,
 * the known-fast-spawn allowlist, the inventory helpers and itself. A diff
 * that touches none of those cannot move the verdict — a src/ or docs/ edit
 * adds no spawn marker — so the ~60 MB scan is skipped unless an input
 * changed. Deletions count: removing a member file stales the manifest.
 */
const REALIO_LANE_TEST_FILE = /^test\/.*\.test\.ts$/;
const REALIO_LANE_INPUTS = new Set([
  'test/config/realio-lane-membership.mjs',
  'test/config/serial-cpu-lane-membership.mjs',
  'scripts/check-realio-lane-membership.mjs',
  'scripts/realio-lane-inventory.mjs',
  'scripts/realio-lane-known-fast-spawns.mjs',
]);

/**
 * scripts/check-verse-sync-io.mjs scans every *-api.ts under
 * src/core/verse/ plus its own regexes and allow rules, so only a route
 * file or the checker itself can move its verdict.
 */
const VERSE_ROUTE_FILE = /^src\/core\/verse\/.*-api\.ts$/;
const VERSE_SYNC_IO_CHECKER = 'scripts/check-verse-sync-io.mjs';

/** Pure selection: keep deleted paths for the web decision, but never lint them. */
export function selectChangedFiles(changedPaths, existingPaths) {
  const changed = [...new Set(changedPaths)].filter(Boolean).sort();
  const existing = new Set(existingPaths);
  return {
    lintFiles: changed.filter((path) => existing.has(path) && /\.(?:[cm]?js|[cm]?ts|tsx|jsx)$/.test(path)),
    pythonFiles: changed.filter((path) => existing.has(path) && /\.py$/.test(path)),
    shellFiles: changed.filter((path) => existing.has(path) && /\.sh$/.test(path)),
    perlFiles: changed.filter((path) => existing.has(path) && /\.pl$/i.test(path)),
    powershellFiles: changed.filter((path) => existing.has(path) && POWERSHELL_FILE.test(path)),
    jsonFiles: changed.filter((path) => existing.has(path) && (/\.(?:json|webmanifest)$/.test(path) || TSBUILDINFO_FILE.test(path))),
    jsonlFiles: changed.filter((path) => existing.has(path) && /\.jsonl$/.test(path)),
    xmlFiles: changed.filter((path) => existing.has(path) && /\.(?:xml|plist(?:\.in)?|svg)$/.test(path)),
    webTypecheck: changed.some((path) => path.startsWith('src/web-ui/')),
    authorityDrift: changed.some(affectsAuthorityDrift),
    fleetRegistry: changed.some((path) => /^src\/cli\/fleet-[^/]*\.ts$/.test(path)),
    docsCheck: changed.some((path) => DOC_MARKDOWN.test(path) || !existing.has(path)),
    quarantineCheck: changed.some((path) => QUARANTINE_TEST_FILE.test(path) || path === QUARANTINE_LEDGER),
    rustFiles: changed.filter((path) => existing.has(path) && /\.rs$/.test(path)),
    swiftFiles: changed.filter((path) => existing.has(path) && /\.swift$/.test(path)),
    yamlFiles: changed.filter((path) => existing.has(path) && /\.(?:ya?ml|cff)$/.test(path)),
    tomlFiles: changed.filter((path) => existing.has(path) && (/\.toml$/.test(path) || CARGO_LOCK_FILE.test(path))),
    cssFiles: changed.filter((path) => existing.has(path) && /\.css$/i.test(path)),
    snapFiles: changed.filter((path) => existing.has(path) && /\.snap$/i.test(path)),
    patchFiles: changed.filter((path) => existing.has(path) && /\.(?:patch|diff)$/i.test(path)),
    htmlFiles: changed.filter((path) => existing.has(path) && HTML_FILE.test(path) && !path.startsWith('test/fixtures/')),
    seatbeltFiles: changed.filter((path) => existing.has(path) && /\.sb$/i.test(path)),
    mdcFiles: changed.filter((path) => existing.has(path) && /\.mdc$/i.test(path)),
    detachedScriptFiles: changed.filter((path) => existing.has(path) && DETACHED_SCRIPT_TREE.test(path) && DETACHED_SCRIPT_FILE.test(path)),
    contribTypecheck: changed.some((path) =>
      (path.startsWith(`${CONTRIB_DIR}/`) && CONTRIB_TS_FILE.test(path)) ||
      path === ROUTER_SRC_BOUNDARY || SHARED_MANIFEST_FILE.test(path)),
    realioLaneCheck: changed.some((path) => REALIO_LANE_TEST_FILE.test(path) || REALIO_LANE_INPUTS.has(path)),
    verseSyncIoCheck: changed.some((path) => VERSE_ROUTE_FILE.test(path) || path === VERSE_SYNC_IO_CHECKER),
  };
}

/**
 * Extensionless executables carry their language in the shebang, not the
 * filename, so the extension rules above never see them: `bin/ashlr` (node),
 * `contrib/mac/metrics-outcomes` (python3) and `contrib/router/ashlr-router`
 * (bash) all escaped every syntax check. Classify the interpreter from the
 * first line; `env` forwards its own options (`-S`, `VAR=value`) before the
 * real command. Only interpreters with a matching grammar step classify —
 * python, node, perl, and the POSIX shells `bash -n` parses (sh/bash/dash).
 * zsh, ksh and friends return null and stay unchecked, exactly as before.
 */
export function shebangInterpreter(firstLine) {
  if (typeof firstLine !== 'string' || !firstLine.startsWith('#!')) return null;
  const tokens = firstLine.slice(2).trim().split(/\s+/).filter(Boolean);
  let index = 0;
  let command = tokens[index] ?? '';
  if (/(^|\/)env$/.test(command)) {
    index += 1;
    while (index < tokens.length && (tokens[index].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[index]))) index += 1;
    command = tokens[index] ?? '';
  }
  const base = command.split('/').pop() ?? '';
  if (/^python(?:\d+(?:\.\d+)*)?$/.test(base)) return 'python';
  if (/^node(?:js)?(?:\d+(?:\.\d+)*)?$/.test(base)) return 'node';
  if (/^perl(?:\d+(?:\.\d+)*)?$/.test(base)) return 'perl';
  if (['sh', 'bash', 'dash'].includes(base)) return 'shell';
  return null;
}

/** First line of a repo file, capped at 4 KiB so binary blobs never load whole. */
export function readFirstLine(root, path) {
  const fd = openSync(resolve(root, path), 'r');
  try {
    const buffer = Buffer.alloc(4096);
    return buffer.subarray(0, readSync(fd, buffer, 0, buffer.length, 0)).toString('utf8').split('\n', 1)[0] ?? '';
  } finally {
    closeSync(fd);
  }
}

/**
 * Bucket changed, existing files whose basename carries no dot by shebang
 * interpreter. Dotted names are already covered by the extension rules (or
 * are documents, data and dotfiles this check must not misread), deleted
 * paths never reach the reader, and an unreadable first line classifies to
 * nothing rather than failing the run.
 */
export function selectShebangScripts(changedPaths, existingPaths, readLine) {
  const existing = new Set(existingPaths);
  const buckets = { python: [], shell: [], node: [], perl: [] };
  for (const path of [...new Set(changedPaths)].filter(Boolean).sort()) {
    if (!existing.has(path) || path.split('/').pop().includes('.')) continue;
    let kind = null;
    try {
      kind = shebangInterpreter(readLine(path));
    } catch { /* unreadable file: nothing to classify */ }
    if (kind) buckets[kind].push(path);
  }
  return buckets;
}

/**
 * Merge Gate runs the drift tests on the queue tree (master plus every PR ahead), not on a PR
 * head. A branch that is green alone can still drift once it meets what landed on master since
 * its merge-base. True when master moved a drift-relevant path since the merge-base.
 */
export function masterMovedAuthorityDrift(root, exec = execFileSync) {
  const git = (...args) => exec('git', args, { cwd: root, encoding: 'utf8' });
  const base = git('merge-base', 'HEAD', 'origin/master').trim();
  return git('diff', '--name-only', '--no-renames', '-z', base, 'origin/master', '--').split('\0').filter(Boolean).some(affectsAuthorityDrift);
}

/**
 * Materialize origin/master with this branch's changed files laid over it (including dirty and
 * untracked edits, and deletions), so the drift tests can run on the tree the queue will build.
 * Returns the temp directory; the caller removes it.
 */
export function materializeMasterOverlay(root, changed, exec = execFileSync) {
  const dir = mkdtempSync(join(tmpdir(), 'phantom-drift-'));
  try {
    const archive = exec('git', ['archive', 'origin/master'], { cwd: root, maxBuffer: 1 << 30 });
    exec('tar', ['-x', '-C', dir], { input: archive, maxBuffer: 1 << 30 });
    for (const path of changed) {
      const from = resolve(root, path);
      const to = resolve(dir, path);
      if (existsSync(from) && statSync(from).isFile()) {
        mkdirSync(dirname(to), { recursive: true });
        copyFileSync(from, to);
      } else {
        rmSync(to, { force: true });
      }
    }
    symlinkSync(resolve(root, 'node_modules'), join(dir, 'node_modules'), 'dir');
    return dir;
  } catch (error) {
    rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

/** Identify changed test files without a test declaration; unreadable files are left to other checks. */
export function emptyChangedTests(existingChangedPaths, read = (p) => readFileSync(p, 'utf8')) {
  return existingChangedPaths.filter((path) => {
    if (!/\.test\.(?:[cm]?ts|tsx|[cm]?js|jsx)$/.test(path)) return false;
    try {
      const text = read(resolve(path)).replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, '');
      return !/\b(?:it|test|describe|bench)(?:\s*\(|\s*\.\s*(?:each\b|skip\s*\())/.test(text);
    } catch {
      return false;
    }
  });
}

/**
 * Paths the conflict-marker scan must not read: test/fixtures payloads are
 * inputs that legitimately embed marker text — a fixture simulating a
 * conflicted merge is valid test data, not a leftover resolution. Every
 * other changed file still on disk is a candidate; binary and oversized
 * files are filtered by content in the runner, not by name here.
 */
const CONFLICT_SCAN_EXEMPT = /^test\/fixtures\//;

/**
 * Bucket changed, existing files the conflict-marker scan reads. Unlike the
 * extension buckets this is content-scoped — every changed file is a
 * candidate because a leftover marker breaks grammars the per-type checks
 * never see (markdown, TSV, HTML, extensionless data) and hides inside the
 * strings, comments and template literals the typed checks do parse.
 * Deleted paths and fixture payloads stay out; the rest pass through sorted.
 */
export function selectConflictScanFiles(changedPaths, existingPaths) {
  const existing = new Set(existingPaths);
  return [...new Set(changedPaths)].filter(Boolean).sort()
    .filter((path) => existing.has(path) && !CONFLICT_SCAN_EXEMPT.test(path));
}

/**
 * Git writes unresolved-conflict markers at column 0 only: `<<<<<<<` and
 * `>>>>>>>` (each optionally carrying a label) plus the diff3 `|||||||`
 * base marker. `=======` is deliberately absent — a seven-equals line is a
 * legal setext heading, and every real conflict already carries the
 * angle/pipe markers. Runs longer than seven characters match too: eight
 * `<` is marker-shaped, never legitimate syntax.
 */
const CONFLICT_MARKER_LINE = /^(?:<{7}|>{7}|\|{7})/;

/**
 * Marker hits in `text` as `{ line, marker }` pairs — 1-based line number
 * plus the seven-character token only, never the label a branch name could
 * ride on. Only column 0 counts: git never indents its markers, and an
 * indented marker inside a docstring, block scalar or code sample is
 * content, not a resolution leftover. A leading BOM is stripped so the
 * first line still scans.
 */
export function conflictMarkers(text) {
  if (typeof text !== 'string') return [];
  const hits = [];
  const lines = text.replace(/^\uFEFF/, '').split('\n');
  for (const [index, line] of lines.entries()) {
    const marker = line.match(CONFLICT_MARKER_LINE)?.[0];
    if (marker) hits.push({ line: index + 1, marker: marker.slice(0, 7) });
  }
  return hits;
}

/**
 * Scan changed files for leftover git merge-conflict markers — the one
 * breakage class no per-type syntax check reliably polices, since markers
 * hide inside strings, comments and template literals the typed parsers
 * accept, and land untouched in file types with no grammar at all
 * (markdown, TSV, HTML, extensionless data). Binary files — a NUL byte in
 * the first 8 KiB, the same sniff git applies — and files over 64 MiB of
 * bulk data are skipped: they carry no line grammar a marker could
 * corrupt. Every scannable file is read whole as UTF-8; each marker line
 * reports `path:line: <marker>` capped at eight hits per file like the
 * JSONL check. Like the JSON checks there is no preflight or SKIP path; an
 * unreadable file fails closed.
 */
export function runConflictMarkerCheck(root, files, read = readFileSync) {
  const failures = [];
  for (const path of files) {
    const full = resolve(root, path);
    let data;
    try {
      if (statSync(full).size > 64 * 1024 * 1024) continue;
      data = read(full);
    } catch (error) {
      failures.push(`${path}: ${error.message}`);
      continue;
    }
    const buffer = Buffer.isBuffer(data) ? data
      : ArrayBuffer.isView(data) ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
      : Buffer.from(String(data), 'utf8');
    if (buffer.subarray(0, 8192).includes(0)) continue;
    const hits = conflictMarkers(buffer.toString('utf8'));
    for (const hit of hits.slice(0, 8)) failures.push(`${path}:${hit.line}: ${hit.marker}`);
    if (hits.length > 8) failures.push(`${path}: ${hits.length - 8} more marker lines`);
  }
  if (failures.length) {
    for (const failure of failures) console.error(`FAIL conflict marker check: ${failure}`);
    return false;
  }
  console.log('PASS conflict marker check');
  return true;
}

/** Merge-base of HEAD and origin/master — the diff anchor base-scoped checks share. */
export function masterMergeBase(root, exec = execFileSync) {
  return exec('git', ['merge-base', 'HEAD', 'origin/master'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/**
 * Merge-base recovery for clones that never fetched enough history. A
 * single-branch clone has no `origin/master` ref at all, and a shallow clone
 * of a topic branch keeps a grafted boundary that shares no commit with
 * master until both sides deepen — either way `git merge-base` fails and the
 * run would degrade to checking only uncommitted work. The heal fetches only
 * what the merge-base needs: the master tracking ref (written explicitly so
 * narrow configured refspecs cannot skip it), then staged `--deepen` of the
 * remote branches on HEAD's truncated ancestry. Returns the base sha, or null
 * when the clone still cannot reach one — unrelated histories, an unreachable
 * remote, or a fork point deeper than the last stage all degrade to the
 * caller's status-mode fallback exactly as before.
 */
/** Refspec that always writes the master tracking ref, whatever the clone's configured refspec. */
const HEAL_MASTER_REF = '+refs/heads/master:refs/remotes/origin/master';
/** First deepen is absolute commits-from-tip; it must exceed the clone's current depth to extend, never shorten. */
const HEAL_MIN_DEPTH = 400;
const HEAL_MAX_DEPTH = 12000;
const HEAL_GROWTH = 5;
const HEAL_STAGES = 3;
/** Bound on each heal fetch; a stalled remote must not hang verification for long. */
const HEAL_FETCH_TIMEOUT_MS = 180_000;
/** Remote branches one heal may deepen alongside master; keeps a pathological ref set bounded. */
const HEAL_MAX_REFSPECS = 8;

/** One git probe for the heal: trimmed stdout, or null on any failure (non-zero exit, timeout, spawn error). */
function healGit(exec, root, args) {
  try {
    const out = exec('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    const trimmed = typeof out === 'string' ? out.trim() : '';
    return trimmed === '' ? null : trimmed;
  } catch {
    return null;
  }
}

/**
 * One heal fetch. Fetch progress stays on stderr so a slow deepen is visible;
 * returns 'ok', 'fail' or 'timeout' so the caller can stop spending time on a
 * remote that already proved it cannot answer in time.
 */
function healFetch(exec, root, args) {
  try {
    exec('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], timeout: HEAL_FETCH_TIMEOUT_MS });
    return 'ok';
  } catch (err) {
    const killed = !!err && typeof err === 'object'
      && (err.killed === true || err.code === 'ETIMEDOUT' || err.signal === 'SIGTERM' || err.signal === 'SIGKILL');
    return killed ? 'timeout' : 'fail';
  }
}

/**
 * Branch names on origin whose history carries HEAD's truncated ancestry:
 * HEAD's upstream when it points at origin, then the remote branches
 * containing each shallow boundary commit reachable from HEAD (the grafted
 * tips `git rev-list --max-parents=0` exposes). Master is excluded — the
 * caller always adds it — and the list stays capped so a many-branch clone
 * cannot turn the heal into a whole-repo fetch.
 */
function healBranchNames(root, exec) {
  const names = [];
  const seen = new Set(['master']);
  const push = (name) => {
    if (name && !seen.has(name) && names.length < HEAL_MAX_REFSPECS - 1) {
      seen.add(name);
      names.push(name);
    }
  };
  const upstream = healGit(exec, root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  if (upstream !== null && upstream.startsWith('origin/')) push(upstream.slice('origin/'.length));
  const bases = (healGit(exec, root, ['rev-list', '--max-parents=0', 'HEAD']) ?? '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[0-9a-f]{40}$/.test(line))
    .slice(0, 4);
  for (const sha of bases) {
    const containing = healGit(exec, root, ['branch', '-r', '--contains', sha]) ?? '';
    for (const line of containing.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed.startsWith('origin/') || trimmed.includes(' -> ')) continue;
      push(trimmed.slice('origin/'.length));
    }
  }
  return names;
}

/**
 * Attempt to reach a merge-base the clone never fetched: ensure the master
 * tracking ref exists, then in a shallow clone deepen master plus the remote
 * branches on HEAD's ancestry in growing absolute-depth stages until the fork
 * point is reachable. Never throws; every failure degrades to null so the
 * caller falls back to status mode.
 */
export function healedMergeBase(root, exec = execFileSync) {
  try {
    const shallow = healGit(exec, root, ['rev-parse', '--is-shallow-repository']) === 'true';
    const hasMaster = healGit(exec, root, ['rev-parse', '--verify', '--quiet', 'origin/master^{commit}']) !== null;
    if (!shallow && hasMaster) return null;
    if (!shallow) {
      // A complete clone missing only the tracking ref — the single-branch case.
      if (healFetch(exec, root, ['fetch', '--no-tags', 'origin', HEAL_MASTER_REF]) === 'timeout') return null;
      return healGit(exec, root, ['merge-base', 'HEAD', 'origin/master']);
    }
    const refspecs = [HEAL_MASTER_REF, ...healBranchNames(root, exec).map((name) => `+refs/heads/${name}:refs/remotes/origin/${name}`)];
    // --deepen is absolute commits-from-tip and can shorten a ref already
    // deeper than the requested depth, so stage one must clear the deepest
    // known side — HEAD's chain and master's — not just HEAD's.
    const depthNow = Math.max(
      Number.parseInt(healGit(exec, root, ['rev-list', '--count', 'HEAD']) ?? '0', 10) || 0,
      hasMaster ? Number.parseInt(healGit(exec, root, ['rev-list', '--count', 'origin/master']) ?? '0', 10) || 0 : 0,
    );
    let depth = Math.max(HEAL_MIN_DEPTH, depthNow + HEAL_MIN_DEPTH);
    for (let stage = 0; stage < HEAL_STAGES; stage += 1) {
      const fetched = healFetch(exec, root, ['fetch', '--no-tags', `--deepen=${depth}`, 'origin', ...refspecs]);
      const base = healGit(exec, root, ['merge-base', 'HEAD', 'origin/master']);
      if (base !== null) return base;
      if (fetched === 'timeout') return null;
      const next = Math.min(depth * HEAL_GROWTH, HEAL_MAX_DEPTH);
      if (next === depth) return null;
      depth = next;
    }
    return null;
  } catch {
    return null;
  }
}

/** Without shared history, verify only this worker's index and working tree. */
export function verificationBase(root, exec = execFileSync) {
  try {
    return { base: masterMergeBase(root, exec), mode: 'merge-base' };
  } catch {
    const healed = healedMergeBase(root, exec);
    if (healed !== null) return { base: healed, mode: 'merge-base' };
    const git = (...args) => exec('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return { base: git('rev-parse', '--verify', 'HEAD^{commit}'), mode: 'status' };
  }
}

/** Include committed changes, index/worktree edits, deletions and untracked files. */
export function collectChangedPaths(root, comparison = verificationBase(root)) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  const { base, mode } = comparison;
  // NUL delimiters preserve whitespace/newlines; disabling renames includes both sides.
  if (mode !== 'merge-base') return [...new Set([
    ...git('status', '--porcelain', '--no-renames', '--untracked-files=all', '-z').split('\0').filter(Boolean).map((entry) => entry.slice(3)),
    ...git('diff', '--name-only', '--no-renames', '-z', 'HEAD', '--').split('\0'),
  ].filter(Boolean))];
  return [
    ...git('diff', '--name-only', '--no-renames', '-z', base, 'HEAD', '--').split('\0'),
    ...git('diff', '--cached', '--name-only', '--no-renames', '-z', '--').split('\0'),
    ...git('diff', '--name-only', '--no-renames', '-z', '--').split('\0'),
    ...git('ls-files', '--others', '--exclude-standard', '-z').split('\0'),
  ].filter(Boolean);
}

/** Select projects conservatively for source, validation tooling and shared compiler inputs. */
export function typecheckProjects(changed) {
  const shared = changed.some((path) => SHARED_MANIFEST_FILE.test(path));
  return {
    backend: shared || changed.some((path) => /^(?:tsconfig[^/]*\.json$|src\/(?!web-ui\/|raycast\/)|test\/|scripts\/)/.test(path)),
    web: shared || changed.some((path) => path.startsWith('src/web-ui/')),
    // desktop/tsconfig.json extends src/web-ui/tsconfig.json, so the base
    // config and shared dependency manifests select it too — the same rule
    // scripts/typecheck-fast.mjs applies.
    desktop: shared || changed.some((path) => path.startsWith('desktop/') || path === 'src/web-ui/tsconfig.json'),
  };
}

/** Explicit worktree-local caches stay separate even when node_modules is shared. */
export function typecheckArgs(root, config = 'tsconfig.json') {
  const project = config === 'tsconfig.json' ? 'backend' : config === 'desktop/tsconfig.json' ? 'desktop' : 'web';
  return ['--noEmit', '-p', config, '--incremental', '--tsBuildInfoFile', resolve(root, '.ashlr-gate/verify', `${project}.tsbuildinfo`)];
}

/** Preflight check that a local eslint install is complete. */
export function eslintPreflight(root, exists = existsSync) {
  const binPath = resolve(root, 'node_modules/eslint/bin/eslint.js');
  const libPath = resolve(root, 'node_modules/eslint/lib/cli.js');
  if (exists(binPath) && exists(libPath)) {
    return { ok: true };
  }
  if (!exists(binPath)) {
    return { ok: false, reason: 'node_modules/eslint/bin/eslint.js is absent; run npm ci to restore it' };
  }
  return { ok: false, reason: 'node_modules/eslint/lib/cli.js is absent; run npm ci to restore it' };
}

/** Preflight check that the documentation checker's markdown parser is installed. */
export function docsCheckPreflight(root, exists = existsSync) {
  if (exists(resolve(root, 'node_modules/marked/package.json'))) {
    return { ok: true };
  }
  return { ok: false, reason: 'node_modules/marked/package.json is absent; run npm ci to restore it' };
}

/** Probe for a working python3; the fleet's dispatcher and bridge tooling are Python. */
export function pythonPreflight(spawn = spawnSync, subject = 'changed .py files') {
  const probe = spawn('python3', ['--version'], { encoding: 'utf8', timeout: 15000 });
  if (probe.error || probe.signal || probe.status !== 0) {
    return { ok: false, reason: `python3 is unavailable or did not run; ${subject} cannot be syntax-checked locally` };
  }
  return { ok: true };
}

// compile() applies the same grammar step py_compile performs, without writing
// __pycache__ bytecode into the tree. One interpreter run covers the batch and
// the first SyntaxError fails the check.
const PYTHON_SYNTAX_CHECK = 'import sys\nfor path in sys.argv[1:]:\n    compile(open(path, "rb").read(), path, "exec")\n';

/** Syntax-check changed .py files; returns false on any interpreter or compile failure. */
export function runPythonSyntaxCheck(root, files, spawn = spawnSync) {
  const result = spawn('python3', ['-c', PYTHON_SYNTAX_CHECK, ...files], {
    cwd: root, encoding: 'utf8', timeout: 120000,
  });
  if (result.status !== 0) {
    if (result.stdout) console.log(result.stdout.trimEnd());
    if (result.stderr) console.error(result.stderr.trimEnd());
    if (result.error) console.error(result.error.message);
    console.log('FAIL python syntax check');
    return false;
  }
  console.log('PASS python syntax check');
  return true;
}

/** Probe for a working bash; the fleet's shell tooling is bash/sh and queuegen gates jobs on `bash -n`. */
export function shellPreflight(spawn = spawnSync) {
  const probe = spawn('bash', ['--version'], { encoding: 'utf8', timeout: 15000 });
  if (probe.error || probe.signal || probe.status !== 0) {
    return { ok: false, reason: 'bash is unavailable or did not run; changed .sh files cannot be syntax-checked locally' };
  }
  return { ok: true };
}

// bash -n parses one script per invocation, so a single wrapper run walks the
// batch and the first parse failure fails the check, matching the Python
// compile loop. `#!/bin/sh` scripts parse under bash's grammar — the same
// `bash -n` acceptance command queuegen assigns to shell jobs.
const SHELL_SYNTAX_CHECK = 'for f in "$@"; do bash -n "$f" || exit 1; done';

/** Syntax-check changed .sh files with bash -n; returns false on any parse failure. */
export function runShellSyntaxCheck(root, files, spawn = spawnSync) {
  const result = spawn('bash', ['-c', SHELL_SYNTAX_CHECK, 'bash', ...files], {
    cwd: root, encoding: 'utf8', timeout: 120000,
  });
  if (result.status !== 0) {
    if (result.stdout) console.log(result.stdout.trimEnd());
    if (result.stderr) console.error(result.stderr.trimEnd());
    if (result.error) console.error(result.error.message);
    console.log('FAIL shell syntax check');
    return false;
  }
  console.log('PASS shell syntax check');
  return true;
}

/** Probe for a working perl; the secret-shape gate scrub.pl and its fixtures are Perl. */
export function perlPreflight(spawn = spawnSync, subject = 'changed .pl files') {
  const probe = spawn('perl', ['--version'], { encoding: 'utf8', timeout: 15000 });
  if (probe.error || probe.signal || probe.status !== 0) {
    return { ok: false, reason: `perl is unavailable or did not run; ${subject} cannot be syntax-checked locally` };
  }
  return { ok: true };
}

/**
 * `perl -c` is the compile-only grammar step CI's secret-shape job already
 * relies on when it runs scrub.pl: it parses and compiles the script —
 * BEGIN-time `use` statements run, the main body never does — and exits
 * non-zero on a syntax error. One spawn per file keeps the diagnostic
 * pointed at the failing path, and the `./` prefix keeps a dash-leading
 * filename from parsing as perl switches, the same convention the patch
 * check uses for `git apply`.
 */
export function runPerlSyntaxCheck(root, files, spawn = spawnSync) {
  for (const path of files) {
    const result = spawn('perl', ['-c', `./${path}`], {
      cwd: root, encoding: 'utf8', timeout: 120000,
    });
    if (result.error || result.signal || result.status !== 0) {
      if (result.stdout) console.log(result.stdout.trimEnd());
      if (result.stderr) console.error(result.stderr.trimEnd());
      if (result.error) console.error(result.error.message);
      console.log(`FAIL perl syntax check: ${path}`);
      return false;
    }
  }
  console.log('PASS perl syntax check');
  return true;
}

/**
 * Probe for a working PowerShell host: pwsh (PowerShell 7+, cross-platform)
 * first, then Windows PowerShell 5.1's powershell.exe — the interpreter
 * names differ per platform and only one may exist. `-NoProfile
 * -NonInteractive -Command "exit 0"` is the lightest invocation both
 * accept; a host that errors, is killed or exits non-zero does not count.
 * The returned exe feeds runPowerShellSyntaxCheck so the same host that
 * answered the probe parses the files.
 */
export function powershellPreflight(spawn = spawnSync, subject = 'changed PowerShell files') {
  for (const exe of ['pwsh', 'powershell']) {
    const probe = spawn(exe, ['-NoProfile', '-NonInteractive', '-Command', 'exit 0'], { encoding: 'utf8', timeout: 15000 });
    if (!probe.error && !probe.signal && probe.status === 0) return { ok: true, exe };
  }
  return { ok: false, reason: `pwsh/powershell is unavailable or did not run; ${subject} cannot be syntax-checked locally` };
}

/**
 * Parse changed .ps1/.psm1/.psd1 files with the PowerShell language
 * parser — [System.Management.Automation.Language.Parser]::ParseFile is
 * the grammar step the host itself applies, and it parses without
 * executing the script (unlike `powershell -File`, which would run
 * install.ps1's body). The target path travels in PHANTOM_VERIFY_PS1_FILE
 * rather than argv: an environment variable carries any repo path
 * verbatim on both hosts, where $args marshalling after -Command differs
 * between pwsh and powershell.exe. Parse errors print
 * `path:line:column: message` on stderr and exit 1; a missing env var
 * exits 2 so an arg-passing surprise fails closed instead of vacuously
 * passing an unparsed batch. One spawn per file keeps the diagnostic
 * pointed at the failing path, matching the perl and node checks.
 */
const POWERSHELL_SYNTAX_CHECK = [
  '$path = $env:PHANTOM_VERIFY_PS1_FILE',
  'if (-not $path) { exit 2 }',
  '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
  '$tokens = $null',
  '$errors = $null',
  'try {',
  '  [void][System.Management.Automation.Language.Parser]::ParseFile($path, [ref]$tokens, [ref]$errors)',
  '} catch {',
  '  [Console]::Error.WriteLine($_.Exception.Message)',
  '  exit 1',
  '}',
  '$failed = $false',
  'if ($null -ne $errors) {',
  '  foreach ($parseError in $errors) {',
  '    [Console]::Error.WriteLine((\'{0}:{1}:{2}: {3}\' -f $parseError.Extent.File, $parseError.Extent.StartLineNumber, $parseError.Extent.StartColumnNumber, $parseError.Message))',
  '    $failed = $true',
  '  }',
  '}',
  'if ($failed) { exit 1 }',
  'exit 0',
].join('\n');

/** Syntax-check changed PowerShell files with Language.Parser.ParseFile; returns false on any parse failure. */
export function runPowerShellSyntaxCheck(root, files, exe = 'pwsh', spawn = spawnSync) {
  for (const path of files) {
    const result = spawn(exe, ['-NoProfile', '-NonInteractive', '-Command', POWERSHELL_SYNTAX_CHECK], {
      cwd: root, encoding: 'utf8', timeout: 120000,
      env: { ...process.env, PHANTOM_VERIFY_PS1_FILE: resolve(root, path) },
    });
    if (result.error || result.signal || result.status !== 0) {
      if (result.stdout) console.log(result.stdout.trimEnd());
      if (result.stderr) console.error(result.stderr.trimEnd());
      if (result.error) console.error(result.error.message);
      console.log(`FAIL powershell syntax check: ${path}`);
      return false;
    }
  }
  console.log('PASS powershell syntax check');
  return true;
}

/**
 * `node --check` is the grammar step for extensionless node launchers like
 * bin/ashlr: it parses the shebang and module syntax without executing. One
 * spawn per file keeps the diagnostic pointed at the failing path; the check
 * runs under node itself, so no interpreter preflight or SKIP path exists.
 */
export function runNodeSyntaxCheck(root, files, spawn = spawnSync) {
  for (const path of files) {
    const result = spawn(process.execPath, ['--check', path], {
      cwd: root, encoding: 'utf8', timeout: 120000,
    });
    if (result.error || result.signal || result.status !== 0) {
      if (result.stdout) console.log(result.stdout.trimEnd());
      if (result.stderr) console.error(result.stderr.trimEnd());
      if (result.error) console.error(result.error.message);
      console.log(`FAIL node syntax check: ${path}`);
      return false;
    }
  }
  console.log('PASS node syntax check');
  return true;
}

/**
 * Strict-parse changed .json, .webmanifest and .tsbuildinfo files with
 * JSON.parse — the same grammar tscCachePaths already applies to
 * tsconfig.json and sync-plan's checkSyntax applies to fleet machinery,
 * the grammar the Web App Manifest spec requires of
 * `application/manifest+json`, and the format every TypeScript
 * incremental-build record is written in — so a failure is a real break
 * for package.json, manifests, schemas, registries, the PWA manifest the
 * web UI ships and tracked build-info files like
 * src/web-ui/tsconfig.minimal.tsbuildinfo. No external interpreter is
 * needed, so unlike the Python and shell checks there is no preflight or
 * SKIP path; every failing path is named with its parse error.
 */
export function runJsonSyntaxCheck(root, files, read = readFileSync) {
  const failures = [];
  for (const path of files) {
    try {
      JSON.parse(read(resolve(root, path), 'utf8'));
    } catch (error) {
      failures.push(`${path}: ${error.message}`);
    }
  }
  if (failures.length) {
    for (const failure of failures) console.error(`FAIL json syntax check: ${failure}`);
    return false;
  }
  console.log('PASS json syntax check');
  return true;
}

/**
 * Strict-parse changed .jsonl files one line at a time with JSON.parse — the
 * line-delimited JSON grammar every jobs ledger, fixture corpus, benchmark
 * record and bridge-evidence file in the repo is written in, and the grammar
 * each ledger's own readers apply per line. A line must be one complete JSON
 * value; blank lines — including the empty tail a trailing newline leaves —
 * carry no record and are skipped, matching how the ledgers' readers filter
 * them. Any JSON value parses (the grammar admits scalars and arrays, not
 * only objects). Like the .json check there is no preflight or SKIP path;
 * each failing path is named with its 1-based line number and parse error,
 * capped at eight errors per file so one corrupt ledger cannot flood the log.
 */
export function runJsonlSyntaxCheck(root, files, read = readFileSync) {
  const failures = [];
  for (const path of files) {
    let text;
    try {
      text = read(resolve(root, path), 'utf8');
    } catch (error) {
      failures.push(`${path}: ${error.message}`);
      continue;
    }
    let reported = 0;
    let extra = 0;
    for (const [index, line] of text.split('\n').entries()) {
      if (!line.trim()) continue;
      try {
        JSON.parse(line);
      } catch (error) {
        if (reported < 8) {
          failures.push(`${path}:${index + 1}: ${error.message}`);
          reported += 1;
        } else {
          extra += 1;
        }
      }
    }
    if (extra) failures.push(`${path}: ${extra} more malformed line${extra === 1 ? '' : 's'}`);
  }
  if (failures.length) {
    for (const failure of failures) console.error(`FAIL jsonl syntax check: ${failure}`);
    return false;
  }
  console.log('PASS jsonl syntax check');
  return true;
}

// ElementTree is the well-formedness grammar plutil, site generators and
// SVG renderers all enforce on XML-family files: one interpreter run covers
// the batch and the first parse error fails the check. A .plist has three
// encodings and only the XML one starts with "<" (after an optional BOM or
// whitespace), so binary and OpenStep ASCII plists — comments and all —
// skip the parser instead of failing it; a .xml or .svg that is not XML at
// all must parse. A .plist.in launchd template is always XML text — its
// __PLACEHOLDER__ values only substitute inside elements — so it parses
// unconditionally (the .plist suffix sniff does not match it). Named HTML
// entities like &nbsp; are undefined in XML and fail; that strictness is
// deliberate — the file is malformed XML even where browsers render it
// leniently.
const XML_SYNTAX_CHECK = `import sys
import xml.etree.ElementTree as ET

for path in sys.argv[1:]:
    if path.lower().endswith(".plist"):
        with open(path, "rb") as fh:
            head = fh.read(512).lstrip()
        if head.startswith(b"\\xef\\xbb\\xbf"):
            head = head[3:].lstrip()
        if head and not head.startswith(b"<"):
            continue
    try:
        ET.parse(path)
    except Exception as exc:
        print(f"{path}: {exc}", file=sys.stderr)
        sys.exit(1)
`;

/** Syntax-check changed XML-family files (.xml, .plist, .plist.in, .svg); false on any interpreter or parse failure. */
export function runXmlSyntaxCheck(root, files, spawn = spawnSync) {
  const result = spawn('python3', ['-c', XML_SYNTAX_CHECK, ...files], {
    cwd: root, encoding: 'utf8', timeout: 120000,
  });
  if (result.status !== 0) {
    if (result.stdout) console.log(result.stdout.trimEnd());
    if (result.stderr) console.error(result.stderr.trimEnd());
    if (result.error) console.error(result.error.message);
    console.log('FAIL xml syntax check');
    return false;
  }
  console.log('PASS xml syntax check');
  return true;
}

/** Probe for a working rustfmt; the Tauri desktop broker under desktop/src-tauri is Rust. */
export function rustPreflight(spawn = spawnSync) {
  const probe = spawn('rustfmt', ['--version'], { encoding: 'utf8', timeout: 15000 });
  if (probe.error || probe.signal || probe.status !== 0) {
    return { ok: false, reason: 'rustfmt is unavailable or did not run; changed .rs files cannot be syntax-checked locally' };
  }
  return { ok: true };
}

// rustfmt parses the whole file before it emits anything, so --emit stdout is
// a pure syntax check: it writes nothing back, enforces no formatting, and
// fails only on parse errors. skip_children keeps a crate-root file from
// descending into its out-of-line modules. Edition 2021 matches
// desktop/src-tauri/Cargo.toml and the CI rustfmt invocation. Stdout is
// discarded — the formatted text can be large and is never a diagnostic.
const RUSTFMT_SYNTAX_ARGS = ['--edition', '2021', '--config', 'skip_children=true', '--emit', 'stdout'];

/** Syntax-check changed .rs files with rustfmt's parser; returns false on any parse failure. */
export function runRustSyntaxCheck(root, files, spawn = spawnSync) {
  for (const path of files) {
    const result = spawn('rustfmt', [...RUSTFMT_SYNTAX_ARGS, path], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'], timeout: 120000,
    });
    if (result.error || result.signal || result.status !== 0) {
      if (result.stderr) console.error(String(result.stderr).trimEnd());
      if (result.error) console.error(result.error.message);
      console.log(`FAIL rust syntax check: ${path}`);
      return false;
    }
  }
  console.log('PASS rust syntax check');
  return true;
}

/** Probe for a working swiftc; tools/custody and tools/desktop-operator are Swift. */
export function swiftPreflight(spawn = spawnSync) {
  const probe = spawn('swiftc', ['--version'], { encoding: 'utf8', timeout: 15000 });
  if (probe.error || probe.signal || probe.status !== 0) {
    return { ok: false, reason: 'swiftc is unavailable or did not run; changed .swift files cannot be syntax-checked locally' };
  }
  return { ok: true };
}

// `swiftc -parse` runs only the parser stage: no type checking, no module
// resolution, no output files — the same grammar step `swift build` applies
// first, so a failure here is a failure there. One spawn per file keeps the
// diagnostic pointed at the failing path, matching the node check.
export function runSwiftSyntaxCheck(root, files, spawn = spawnSync) {
  for (const path of files) {
    const result = spawn('swiftc', ['-parse', path], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'], timeout: 120000,
    });
    if (result.error || result.signal || result.status !== 0) {
      if (result.stderr) console.error(String(result.stderr).trimEnd());
      if (result.error) console.error(result.error.message);
      console.log(`FAIL swift syntax check: ${path}`);
      return false;
    }
  }
  console.log('PASS swift syntax check');
  return true;
}

/**
 * .yaml/.yml, .cff and .toml files — GitHub workflows, dependabot, codecov,
 * socket, the pnpm workspace and lock manifests, agent-network, lexicon
 * and cliff configs, CITATION.cff, Cargo.toml — are consumed by parsers a
 * text diff can never prove. `yaml` and `smol-toml` are already bundled
 * dependencies, so the grammar steps use the same parsers the codebase
 * itself ships, but they run in a child node process: a top-level import
 * here would keep this script from loading at all when node_modules is
 * absent, while the preflight reports that case as SKIP like the ESLint
 * and docs checks.
 * Bare specifiers resolve against the spawned cwd (the repo root), which
 * is where npm ci and install:worktree place the packages.
 */
export function parserPackagePreflight(root, pkg, exists = existsSync) {
  if (exists(resolve(root, 'node_modules', pkg, 'package.json'))) {
    return { ok: true };
  }
  return { ok: false, reason: `node_modules/${pkg}/package.json is absent; run npm ci to restore it` };
}

// Both child scripts walk argv files, parse each with the bundled parser,
// print `path: <first diagnostic line>` per failure and exit 1 on any.
// yaml's parseAllDocuments checks every document of a multi-document file
// and treats duplicate keys as errors — the same rejections GitHub's
// workflow parser and pnpm apply; its diagnostics already carry
// "at line L, column C". Default-import + destructure keeps the import
// working whether the package resolves to its ESM or CJS build. smol-toml
// errors expose line/column fields its message omits, so the toml script
// appends them. Each file reports at most 8 yaml errors.
const YAML_SYNTAX_CHECK = `import { readFileSync } from 'node:fs';
import pkg from 'yaml';
const { parseAllDocuments } = pkg;
const firstLine = (error) => String(error && error.message ? error.message : error).split('\\n')[0];
let failed = false;
for (const path of process.argv.slice(1)) {
  const errors = [];
  try {
    for (const doc of parseAllDocuments(readFileSync(path, 'utf8'))) errors.push(...doc.errors);
  } catch (error) {
    errors.push(error);
  }
  for (const error of errors.slice(0, 8)) console.error(path + ': ' + firstLine(error));
  if (errors.length > 8) console.error(path + ': ' + (errors.length - 8) + ' more errors');
  if (errors.length) failed = true;
}
process.exit(failed ? 1 : 0);
`;

/** Syntax-check changed .yaml/.yml/.cff files with the bundled yaml parser; false on any parse failure. */
export function runYamlSyntaxCheck(root, files, spawn = spawnSync) {
  const result = spawn(process.execPath, ['--input-type=module', '-e', YAML_SYNTAX_CHECK, ...files], {
    cwd: root, encoding: 'utf8', timeout: 120000,
  });
  if (result.status !== 0) {
    if (result.stdout) console.log(result.stdout.trimEnd());
    if (result.stderr) console.error(result.stderr.trimEnd());
    if (result.error) console.error(result.error.message);
    console.log('FAIL yaml syntax check');
    return false;
  }
  console.log('PASS yaml syntax check');
  return true;
}

/**
 * `.mdc` files are agent rule files (Cursor rules under .cursor/rules/)
 * whose optional YAML frontmatter — the `---` fenced block the rule
 * loader reads for description/globs/alwaysApply — no other gate step
 * parses: eslint's JS/TS globs, the markdown docs check's curated list and
 * every tsconfig skip them, and the markdown body itself has no grammar
 * worth a step. A file that opens with a `---` line promises frontmatter:
 * an unterminated fence or a block the yaml parser rejects fails here,
 * the same rejection the loader's own YAML read applies. Files without a
 * leading fence are plain markdown and pass untouched. The child shares
 * the yaml package and its SKIP preflight with the .yaml/.yml/.cff check.
 */
const MDC_SYNTAX_CHECK = `import { readFileSync } from 'node:fs';
import pkg from 'yaml';
const { parseAllDocuments } = pkg;
const firstLine = (error) => String(error && error.message ? error.message : error).split('\\n')[0];
const FENCE = /^---[ \\t]*$/;
const CLOSE = /^(?:---|\\.\\.\\.)[ \\t]*$/;
let failed = false;
for (const path of process.argv.slice(1)) {
  const errors = [];
  try {
    const lines = readFileSync(path, 'utf8').replace(/^\\uFEFF/, '').split('\\n').map((line) => line.replace(/\\r$/, ''));
    if (FENCE.test(lines[0] ?? '')) {
      let close = -1;
      for (let index = 1; index < lines.length; index += 1) {
        if (CLOSE.test(lines[index] ?? '')) { close = index; break; }
      }
      if (close === -1) {
        errors.push(new Error('unterminated frontmatter fence'));
      } else {
        const frontmatter = lines.slice(1, close).join('\\n');
        for (const doc of parseAllDocuments(frontmatter)) errors.push(...doc.errors);
      }
    }
  } catch (error) {
    errors.push(error);
  }
  for (const error of errors.slice(0, 8)) console.error(path + ': ' + firstLine(error));
  if (errors.length > 8) console.error(path + ': ' + (errors.length - 8) + ' more errors');
  if (errors.length) failed = true;
}
process.exit(failed ? 1 : 0);
`;

/** Syntax-check changed .mdc agent-rule files' YAML frontmatter; false on any parse failure. */
export function runMdcSyntaxCheck(root, files, spawn = spawnSync) {
  const result = spawn(process.execPath, ['--input-type=module', '-e', MDC_SYNTAX_CHECK, ...files], {
    cwd: root, encoding: 'utf8', timeout: 120000,
  });
  if (result.status !== 0) {
    if (result.stdout) console.log(result.stdout.trimEnd());
    if (result.stderr) console.error(result.stderr.trimEnd());
    if (result.error) console.error(result.error.message);
    console.log('FAIL mdc frontmatter syntax check');
    return false;
  }
  console.log('PASS mdc frontmatter syntax check');
  return true;
}

const TOML_SYNTAX_CHECK = `import { readFileSync } from 'node:fs';
import pkg from 'smol-toml';
const { parse } = pkg;
let failed = false;
for (const path of process.argv.slice(1)) {
  try {
    parse(readFileSync(path, 'utf8'));
  } catch (error) {
    const message = String(error && error.message ? error.message : error).split('\\n')[0];
    const pos = error && Number.isInteger(error.line) ? ' at line ' + error.line + ', column ' + error.column : '';
    console.error(path + ': ' + message + pos);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
`;

/** Syntax-check changed .toml files and Cargo.lock manifests with the bundled smol-toml parser; false on any parse failure. */
export function runTomlSyntaxCheck(root, files, spawn = spawnSync) {
  const result = spawn(process.execPath, ['--input-type=module', '-e', TOML_SYNTAX_CHECK, ...files], {
    cwd: root, encoding: 'utf8', timeout: 120000,
  });
  if (result.status !== 0) {
    if (result.stdout) console.log(result.stdout.trimEnd());
    if (result.stderr) console.error(result.stderr.trimEnd());
    if (result.error) console.error(result.error.message);
    console.log('FAIL toml syntax check');
    return false;
  }
  console.log('PASS toml syntax check');
  return true;
}

/**
 * The CSS grammar step uses lightningcss — the parser Vite bundles for the
 * web-ui build — resolved through vite's own dependency closure. pnpm keeps
 * transitive packages out of the root node_modules, so the check anchors
 * require resolution at vite's real manifest path rather than probing
 * node_modules/lightningcss directly; npm's flat layout resolves the same
 * way. esbuild's CSS parser was rejected for this step: it recovers from
 * nearly every malformed construct and would only ever catch an
 * unterminated comment, while lightningcss enforces the grammar vite
 * applies (errorRecovery stays off, so the first real error fails).
 */
export function cssParserPreflight(root, exists = existsSync) {
  const viteManifest = resolve(root, 'node_modules/vite/package.json');
  if (!exists(viteManifest)) {
    return { ok: false, reason: 'node_modules/vite/package.json is absent; run npm ci to restore it' };
  }
  try {
    createRequire(realpathSync(viteManifest)).resolve('lightningcss');
  } catch {
    return { ok: false, reason: 'lightningcss is not resolvable through the installed vite; run npm ci to restore it' };
  }
  return { ok: true };
}

// The child resolves lightningcss the same way the preflight does — through
// vite's real (un-symlinked) manifest — so pnpm's transitive layout and npm's
// flat layout both work. Each file reports its first parse error as
// `path:line:column: message` and the run exits 1 when any file fails.
const CSS_SYNTAX_CHECK = `import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
const req = createRequire(realpathSync(resolve('node_modules/vite/package.json')));
const { transform } = req('lightningcss');
let failed = false;
for (const path of process.argv.slice(1)) {
  try {
    await transform({ filename: path, code: readFileSync(path), errorRecovery: false });
  } catch (error) {
    const loc = error && error.loc && Number.isInteger(error.loc.line)
      ? ':' + error.loc.line + ':' + error.loc.column
      : '';
    const message = String(error && error.message ? error.message : error).split('\\n')[0];
    console.error(path + loc + ': ' + message);
    failed = true;
  }
}
process.exit(failed ? 1 : 0);
`;

/** Syntax-check changed .css files with the vite-bundled lightningcss parser; false on any parse failure. */
export function runCssSyntaxCheck(root, files, spawn = spawnSync) {
  const result = spawn(process.execPath, ['--input-type=module', '-e', CSS_SYNTAX_CHECK, ...files], {
    cwd: root, encoding: 'utf8', timeout: 120000,
  });
  if (result.status !== 0) {
    if (result.stdout) console.log(result.stdout.trimEnd());
    if (result.stderr) console.error(result.stderr.trimEnd());
    if (result.error) console.error(result.error.message);
    console.log('FAIL css syntax check');
    return false;
  }
  console.log('PASS css syntax check');
  return true;
}

/**
 * Vitest `.snap` snapshot modules are `exports[`name`] = <serialized>;`
 * statement lists — JavaScript that eslint's lintFiles glob and the
 * tsconfig include both skip, so a hand edit or a merge-conflict marker
 * survives until vitest loads the suite. `node --check` refuses the unknown
 * extension, but node's script parser is available in-process through
 * `vm.Script`, so like the JSON check there is no preflight or SKIP path.
 * The error stack's first line already carries `path:line`.
 */
export function runSnapSyntaxCheck(root, files, read = readFileSync) {
  const failures = [];
  for (const path of files) {
    try {
      new Script(read(resolve(root, path), 'utf8'), { filename: path });
    } catch (error) {
      const stack = typeof error?.stack === 'string' ? error.stack.split('\n') : [];
      const where = stack[0]?.startsWith(`${path}:`) ? stack[0].slice(path.length) : '';
      failures.push(`${path}${where}: ${error.message}`);
    }
  }
  if (failures.length) {
    for (const failure of failures) console.error(`FAIL snap syntax check: ${failure}`);
    return false;
  }
  console.log('PASS snap syntax check');
  return true;
}

/**
 * `.sb` files are macOS Seatbelt (SBPL) sandbox profiles — the GATES-v3
 * confinement boundary the fleet lanes run under (contrib/mac/
 * host-integration/*.sb, contrib/mac/sandbox/*.sb). sandbox-exec compiles a
 * profile at launch; a truncated or garbled one fails inside the launcher,
 * far from the edit that broke it, and no other gate step reads the
 * grammar: eslint's JS/TS globs, every tsconfig include, the shebang
 * buckets and the per-extension parsers all skip it. The language is
 * s-expressions — `(version 1)`, `(allow file-read* (subpath "..."))`,
 * `(deny ...)`, `(define (wp n) ...)`, `(require-all ...)`, regex literals
 * `#"..."` and `;` comments — so the grammar step here is a structural
 * parse: balanced parentheses, terminated string and regex literals, and
 * every top-level form a proper list headed by an atom. Operation names
 * and filter semantics stay unchecked on purpose — SBPL grows new
 * operations and a whitelist would reject valid future profiles; what
 * sandbox-exec's own reader rejects first is exactly what this catches.
 * Like the snap check the parse runs in-process, so there is no preflight
 * or SKIP path.
 */
const SEATBELT_MAX_DEPTH = 1000;

/** First structural error in SBPL text as {line, column, message}, or null. Never throws. */
function seatbeltSyntaxError(text) {
  const tokens = [];
  let i = 0;
  let line = 1;
  let column = 1;
  const length = text.length;
  const space = (c) => c === ' ' || c === '\t' || c === '\r' || c === '\f' || c === '\v' || c === '\n';
  while (i < length) {
    const ch = text[i];
    if (ch === '\n') { line += 1; column = 1; i += 1; continue; }
    if (space(ch)) { column += 1; i += 1; continue; }
    if (ch === ';') {
      while (i < length && text[i] !== '\n') { i += 1; column += 1; }
      continue;
    }
    if (ch === '(' || ch === ')') {
      tokens.push({ kind: ch, line, column });
      i += 1; column += 1;
      continue;
    }
    const startLine = line;
    const startColumn = column;
    const quoted = ch === '"' ? 'string' : ch === '#' && text[i + 1] === '"' ? 'regex' : null;
    if (quoted !== null) {
      i += quoted === 'regex' ? 2 : 1;
      column += quoted === 'regex' ? 2 : 1;
      let closed = false;
      while (i < length) {
        const c = text[i];
        if (c === '\\') {
          i += 1; column += 1;
          if (i < length) {
            if (text[i] === '\n') { line += 1; column = 1; i += 1; }
            else { i += 1; column += 1; }
          }
          continue;
        }
        if (c === '"') { i += 1; column += 1; closed = true; break; }
        if (c === '\n') { line += 1; column = 1; i += 1; continue; }
        i += 1; column += 1;
      }
      if (!closed) return { line: startLine, column: startColumn, message: `unterminated ${quoted} literal` };
      tokens.push({ kind: quoted, line: startLine, column: startColumn });
      continue;
    }
    while (i < length) {
      const c = text[i];
      if (space(c) || c === '(' || c === ')' || c === ';' || c === '"') break;
      i += 1; column += 1;
    }
    tokens.push({ kind: 'atom', line: startLine, column: startColumn });
  }
  let pos = 0;
  const parse = (depth) => {
    if (depth > SEATBELT_MAX_DEPTH) {
      const tok = tokens[pos];
      return { error: { line: tok ? tok.line : line, column: tok ? tok.column : column, message: `nesting deeper than ${SEATBELT_MAX_DEPTH} levels` } };
    }
    const tok = tokens[pos];
    if (!tok || tok.kind !== '(') {
      if (tok && tok.kind === ')') return { error: { line: tok.line, column: tok.column, message: 'unexpected )' } };
      if (tok) pos += 1;
      return {};
    }
    const open = tok;
    pos += 1;
    const head = tokens[pos];
    if (!head) return { error: { line: open.line, column: open.column, message: 'unclosed list' } };
    if (head.kind === ')') { pos += 1; return {}; }
    if (head.kind !== 'atom') return { error: { line: head.line, column: head.column, message: 'list head must be an atom' } };
    pos += 1;
    while (pos < tokens.length && tokens[pos].kind !== ')') {
      const element = parse(depth + 1);
      if (element.error) return element;
    }
    if (pos >= tokens.length) return { error: { line: open.line, column: open.column, message: 'unclosed list' } };
    pos += 1;
    return {};
  };
  while (pos < tokens.length) {
    if (tokens[pos].kind !== '(') {
      const tok = tokens[pos];
      return { line: tok.line, column: tok.column, message: 'top-level form must be a list' };
    }
    const form = parse(0);
    if (form.error) return form.error;
  }
  return null;
}

/** Syntax-check changed .sb Seatbelt profiles; false on the first structural error per file. */
export function runSeatbeltSyntaxCheck(root, files, read = readFileSync) {
  const failures = [];
  for (const path of files) {
    let text;
    try {
      text = read(resolve(root, path), 'utf8');
    } catch (error) {
      failures.push(`${path}: unreadable (${String(error && error.message ? error.message : error).split('\n')[0]})`);
      continue;
    }
    const error = seatbeltSyntaxError(text);
    if (error) failures.push(`${path}:${error.line}:${error.column}: ${error.message}`);
  }
  if (failures.length) {
    for (const failure of failures) console.error(`FAIL seatbelt syntax check: ${failure}`);
    return false;
  }
  console.log('PASS seatbelt syntax check');
  return true;
}

/**
 * `.patch` and `.diff` files are unified diffs consumed by `git apply` —
 * host-integration candidates, staged dispatcher changes, strategy
 * proposals and evidence exports all fail only when someone tries to
 * apply them, long after the diff review that produced them. `git apply
 * --stat` is the grammar step: it parses every file header and hunk
 * without needing the target tree (`--check` would wrongly demand the
 * patch apply cleanly in this checkout, which staged proposals against
 * other revisions never do), and it rejects non-patch input and corrupt
 * hunks alike. One spawn per file keeps the diagnostic pointed at the
 * failing path, matching the node, rust and swift checks; stdout is
 * discarded like rustfmt's formatted text. `--allow-empty` is
 * deliberately absent: it would accept any non-patch text as an empty
 * patch set. Git is already required to collect the changed set, so like
 * the JSON and snap checks there is no preflight or SKIP path. Paths are
 * `./`-prefixed because `git apply` has no `--` separator — a
 * `-`-leading filename must never read as an option.
 */
export function runPatchSyntaxCheck(root, files, spawn = spawnSync) {
  for (const path of files) {
    const result = spawn('git', ['apply', '--stat', `./${path}`], {
      cwd: root, encoding: 'utf8', stdio: ['ignore', 'ignore', 'pipe'], timeout: 120000,
    });
    if (result.error || result.signal || result.status !== 0) {
      if (result.stderr) console.error(String(result.stderr).trimEnd());
      if (result.error) console.error(result.error.message);
      console.log(`FAIL patch syntax check: ${path}`);
      return false;
    }
  }
  console.log('PASS patch syntax check');
  return true;
}

/** Preflight check that the HTML parser used for embedded payloads is installed. */
export function htmlPayloadPreflight(root, exists = existsSync) {
  return parserPackagePreflight(root, 'jsdom', exists);
}

/**
 * Changed .html/.htm files are parsed by the bundled jsdom package — the same
 * spec-compliant HTML5 parser browsers apply — and every embedded payload is
 * checked under the grammar its consumer enforces. Classic and module
 * <script> bodies go through node:vm's Script and SourceTextModule, the
 * exact parse goals the HTML standard assigns them (the child runs with
 * --experimental-vm-modules so the module constructor exists on Node 22);
 * JSON script types (importmap, speculationrules, application/json and any
 * +json suffix such as ld+json) go through JSON.parse; <style> rules go
 * through the same lightningcss transform the .css check uses, resolved
 * through vite's dependency closure and skipped with a WARN when it cannot
 * be resolved. External src scripts, inert type values, empty bodies and
 * scripts inside <noscript> (inert markup, never executed) are skipped;
 * <template> content is walked because cloned payloads do execute. Each
 * file reports at most 8 payload errors.
 */
const HTML_PAYLOAD_CHECK = `import { readFileSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { Script, SourceTextModule } from 'node:vm';
import jsdomPkg from 'jsdom';
const JSDOM = jsdomPkg.JSDOM ?? jsdomPkg.default?.JSDOM;

// The HTML standard's "JavaScript MIME type essence match" list: the only
// type values that make a classic script executable. Parameters after ';'
// are ignored, matching the essence comparison.
const JS_MIME = new Set([
  'application/ecmascript', 'application/javascript', 'application/x-ecmascript',
  'application/x-javascript', 'text/ecmascript', 'text/javascript',
  'text/javascript1.0', 'text/javascript1.1', 'text/javascript1.2',
  'text/javascript1.3', 'text/javascript1.4', 'text/javascript1.5',
  'text/jscript', 'text/livescript', 'text/x-ecmascript', 'text/x-javascript',
]);

function payloadKind(type) {
  const t = String(type ?? '').split(';', 1)[0].trim().toLowerCase();
  if (t === '' || JS_MIME.has(t)) return 'script';
  if (t === 'module') return 'module';
  if (t === 'importmap' || t === 'speculationrules' || t === 'application/json' || t.endsWith('+json')) return 'json';
  return null;
}

// querySelectorAll does not descend into <template> content, but payloads
// cloned out of a template do execute, so template fragments are walked too.
function* payloadElements(root) {
  for (const el of root.querySelectorAll('script, style')) yield el;
  for (const t of root.querySelectorAll('template')) yield* payloadElements(t.content);
}

let transform = null;
try {
  const req = createRequire(realpathSync(resolve('node_modules/vite/package.json')));
  transform = req('lightningcss').transform;
} catch { /* style payloads warn-skip below */ }

const firstLine = (error) => String(error && error.message ? error.message : error).split('\\n')[0];

function scriptError(error, path, label, n, kind) {
  const stack = typeof error?.stack === 'string' ? error.stack.split('\\n') : [];
  const where = stack[0] && stack[0].startsWith(label + ':') ? ' line ' + stack[0].slice(label.length + 1) : '';
  return path + ' ' + kind + ' block ' + n + where + ': ' + firstLine(error);
}

let failed = false;
for (const path of process.argv.slice(1)) {
  const errors = [];
  let doc = null;
  try {
    doc = new JSDOM(readFileSync(path, 'utf8'), { url: 'https://verify.invalid/' }).window.document;
  } catch (error) {
    errors.push(path + ': ' + firstLine(error));
  }
  if (doc) {
    let scriptN = 0, moduleN = 0, jsonN = 0, styleN = 0, styleWarned = false;
    for (const el of payloadElements(doc)) {
      const code = el.textContent ?? '';
      if (!code.trim()) continue;
      if (el.tagName.toLowerCase() === 'style') {
        styleN += 1;
        if (!transform) {
          if (!styleWarned) {
            console.log('WARN ' + path + ': style payloads skipped, lightningcss is not resolvable through vite');
            styleWarned = true;
          }
          continue;
        }
        try {
          await transform({ filename: path + '#style-' + styleN, code: new TextEncoder().encode(code), errorRecovery: false });
        } catch (error) {
          const loc = error && error.loc && Number.isInteger(error.loc.line)
            ? error.loc.line + ':' + error.loc.column
            : '';
          errors.push(path + ' style block ' + styleN + (loc ? ' at ' + loc : '') + ': ' + firstLine(error));
        }
        continue;
      }
      if (el.hasAttribute('src') || el.closest('noscript')) continue;
      const kind = payloadKind(el.getAttribute('type'));
      if (kind === null) continue;
      const n = kind === 'json' ? ++jsonN : kind === 'module' ? ++moduleN : ++scriptN;
      const label = path + '#' + kind + '-' + n;
      try {
        if (kind === 'json') JSON.parse(code);
        else if (kind === 'module') new SourceTextModule(code, { identifier: label });
        else new Script(code, { filename: label });
      } catch (error) {
        errors.push(scriptError(error, path, label, n, kind === 'json' ? 'json' : kind === 'module' ? 'module script' : 'script'));
      }
    }
  }
  for (const e of errors.slice(0, 8)) console.error(e);
  if (errors.length > 8) console.error(path + ': ' + (errors.length - 8) + ' more payload errors');
  if (errors.length) failed = true;
}
process.exit(failed ? 1 : 0);
`;

/** Parse embedded <script>, JSON-script and <style> payloads in changed html files; false on any payload error. */
export function runHtmlPayloadCheck(root, files, spawn = spawnSync) {
  const result = spawn(process.execPath, ['--no-warnings', '--experimental-vm-modules', '--input-type=module', '-e', HTML_PAYLOAD_CHECK, ...files], {
    cwd: root, encoding: 'utf8', timeout: 120000,
  });
  if (result.status !== 0) {
    if (result.stdout) console.log(result.stdout.trimEnd());
    if (result.stderr) console.error(result.stderr.trimEnd());
    if (result.error) console.error(result.error.message);
    console.log('FAIL html payload syntax check');
    return false;
  }
  console.log('PASS html payload syntax check');
  return true;
}

/**
 * Scripts under src/raycast and examples/universe-site are authored code no
 * other check reads: eslint.config.js ignores both trees (each owns its
 * toolchain), no root tsconfig includes them, and the dotted basenames never
 * reach the shebang buckets. Their consumers are each tree's own tsc, node
 * and vite, so the grammar step here is the TypeScript parser itself — the
 * same parse `tsc --noEmit` and the bundlers apply, minus type resolution
 * the absent per-tree node_modules could never satisfy. `typescript` is a
 * bundled devDependency parsed in a child node process like the yaml/toml
 * checks, so the preflight reports SKIP when node_modules is absent.
 * createSourceFile + parseDiagnostics is a pure parse — no emit, so
 * declaration files and every script extension ([cm]?[jt]sx?) report only
 * real syntax errors; each file reports at most 8 diagnostics.
 */
const DETACHED_SCRIPT_CHECK = `import { readFileSync } from 'node:fs';
import pkg from 'typescript';
const ts = pkg;
const kindOf = (path) => {
  const ext = path.toLowerCase().match(/\\.([cm]?[jt]sx?)$/)?.[1] ?? '';
  if (ext === 'tsx') return ts.ScriptKind.TSX;
  if (ext === 'jsx') return ts.ScriptKind.JSX;
  if (ext.includes('j')) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
};
let failed = false;
for (const path of process.argv.slice(1)) {
  const errors = [];
  try {
    const sf = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.ESNext, true, kindOf(path));
    for (const d of sf.parseDiagnostics ?? []) {
      const pos = typeof d.start === 'number' ? sf.getLineAndCharacterOfPosition(d.start) : null;
      const where = pos ? ':' + (pos.line + 1) + ':' + (pos.character + 1) : '';
      errors.push(path + where + ': ' + ts.flattenDiagnosticMessageText(d.messageText, ' '));
    }
  } catch (error) {
    errors.push(path + ': ' + String(error && error.message ? error.message : error).split('\\n')[0]);
  }
  for (const e of errors.slice(0, 8)) console.error(e);
  if (errors.length > 8) console.error(path + ': ' + (errors.length - 8) + ' more errors');
  if (errors.length) failed = true;
}
process.exit(failed ? 1 : 0);
`;

/** Parse changed scripts under the independently-owned trees with the bundled typescript parser; false on any parse failure. */
export function runDetachedScriptCheck(root, files, spawn = spawnSync) {
  const result = spawn(process.execPath, ['--input-type=module', '-e', DETACHED_SCRIPT_CHECK, ...files], {
    cwd: root, encoding: 'utf8', timeout: 120000,
  });
  if (result.status !== 0) {
    if (result.stdout) console.log(result.stdout.trimEnd());
    if (result.stderr) console.error(result.stderr.trimEnd());
    if (result.error) console.error(result.error.message);
    console.log('FAIL detached script syntax check');
    return false;
  }
  console.log('PASS detached script syntax check');
  return true;
}

/**
 * The contrib/router program files, sorted for a deterministic command
 * line. SUPERVISOR.md documents a non-recursive `contrib/router/*.ts`
 * file-list tsc run; lib/ holds shell helpers and router_io.cjs (a spawned
 * subprocess payload, never imported) and test/ a bash suite, so top-level
 * *.ts is the whole TypeScript program boundary. An absent or unreadable
 * tree yields an empty list — the caller skips rather than fails.
 */
export function contribRouterProgramFiles(root, readdir = readdirSync) {
  let entries;
  try {
    entries = readdir(resolve(root, CONTRIB_ROUTER_DIR), { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isFile() && ROUTER_PROGRAM_FILE.test(entry.name))
    .map((entry) => `${CONTRIB_ROUTER_DIR}/${entry.name}`)
    .sort();
}

/**
 * Every .ts-family file under contrib/ outside the router subtree, sorted
 * for a deterministic command line. The router keeps its documented
 * non-recursive boundary, so the walk prunes the whole contrib/router/
 * subtree rather than re-admitting nested files the boundary excludes;
 * node_modules is pruned the same way — vendored trees are never program
 * roots. An absent or unreadable directory yields an empty list for that
 * branch — the caller skips rather than fails.
 */
export function contribSatelliteProgramFiles(root, readdir = readdirSync) {
  const files = [];
  const walk = (rel) => {
    let entries;
    try {
      entries = readdir(resolve(root, rel), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || child === CONTRIB_ROUTER_DIR) continue;
        walk(child);
      } else if (entry.isFile() && CONTRIB_TS_FILE.test(entry.name)) {
        files.push(child);
      }
    }
  };
  walk(CONTRIB_DIR);
  return files.sort();
}

/**
 * The whole contrib TypeScript program: the router's documented
 * top-level *.ts boundary plus every other .ts-family file under
 * contrib/. Sorted and deduplicated for a deterministic command line, so
 * one tsc run can never split the program's verdict.
 */
export function contribProgramFiles(root, readdir = readdirSync) {
  return [...new Set([
    ...contribRouterProgramFiles(root, readdir),
    ...contribSatelliteProgramFiles(root, readdir),
  ])].sort();
}

/**
 * Type-check the whole contrib program in one tsc run with the flags
 * SUPERVISOR.md documents — file-list mode ignores tsconfig.json, so the
 * flags are the contract, and tsc follows the program's
 * ../../src/core/authority/protected-paths.js import into src/ on its own.
 * Diagnostics already carry path:line. The child gets a generous heap: the
 * src import closure peaks near 1.5 GB, which the default ceiling clips
 * under load. The caller holds a typecheck slot like the project checks —
 * a compiler is a compiler on a shared machine.
 */
export function runContribTypecheck(root, files, spawn = spawnSync) {
  const result = spawn(process.execPath,
    ['--max-old-space-size=4096', 'node_modules/typescript/bin/tsc', '--noEmit',
     '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--target', 'ES2022',
     '--strict', '--skipLibCheck', ...files],
    { cwd: root, encoding: 'utf8', timeout: 300000, killSignal: 'SIGKILL' });
  if (result.status !== 0) {
    if (result.stdout) console.log(result.stdout.trimEnd());
    if (result.stderr) console.error(result.stderr.trimEnd());
    if (result.error) console.error(result.error.message);
    console.log('FAIL contrib typecheck');
    return false;
  }
  console.log('PASS contrib typecheck');
  return true;
}

/** Shared root for the typecheck cache and slots; worktrees resolve to the git common dir. */
export function tscSharedRoot(root, env = process.env, exec = execFileSync) {
  return env.PHANTOM_TSC_CACHE_DIR
    || resolve(root, exec('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim(), 'phantom-tsc-cache');
}

/** Resolve the local and shared incremental build-info paths for this checkout. */
export function tscCachePaths(root, env = process.env, exec = execFileSync) {
  const config = readFileSync(resolve(root, 'tsconfig.json'));
  const lock = readFileSync(resolve(root, 'package-lock.json'));
  const hash = createHash('sha256').update(String(lock.length)).update(':').update(lock).update(config).digest('hex');
  return { local: typecheckArgs(root).at(-1), shared: resolve(root, tscSharedRoot(root, env, exec), `${hash}.tsbuildinfo`) };
}

/** Slot dirs sit beside the cache so PHANTOM_TSC_CACHE_DIR relocates the whole shared root. */
export function tscSlotsDir(root, env = process.env, exec = execFileSync) {
  return resolve(root, tscSharedRoot(root, env, exec), '..', 'phantom-tsc-slots');
}

/** Machine-wide cap on concurrent typechecks; PHANTOM_TSC_SLOTS overrides the default of 3. */
export function tscSlotCount(env = process.env) {
  const raw = env.PHANTOM_TSC_SLOTS;
  if (raw === undefined || raw === '') return 3;
  const count = Number(raw);
  if (!Number.isInteger(count) || count < 1 || count > 64) {
    throw new Error('PHANTOM_TSC_SLOTS must be an integer from 1 to 64');
  }
  return count;
}

/** A pid with no process is gone; EPERM means it lives under another user. */
export function tscSlotHolderAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function sleepSync(milliseconds) {
  if (milliseconds > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/**
 * Free slotPath when its holder is gone: a dead recorded pid, or a dir whose
 * pid file never appeared (holder died between mkdir and write) past a grace
 * window for an in-progress acquire. Returns true when the slot was removed.
 */
export function reclaimStaleTscSlot(slotPath, deps = {}) {
  const {
    read = readFileSync, stat = statSync, rm = rmSync,
    alive = tscSlotHolderAlive, now = Date.now, graceMs = 30_000,
  } = deps;
  const pidPath = join(slotPath, 'pid');
  let text;
  try {
    text = read(pidPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    text = null;
  }
  const holder = text === null ? NaN : Number.parseInt(text, 10);
  if (Number.isInteger(holder) && holder > 0) {
    if (alive(holder)) return false;
    rm(slotPath, { recursive: true, force: true });
    return true;
  }
  let marker;
  try {
    marker = (text === null ? stat(slotPath) : stat(pidPath)).mtimeMs;
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
  if (now() - marker < graceMs) return false;
  rm(slotPath, { recursive: true, force: true });
  return true;
}

/**
 * Take one of `count` machine-wide slots via atomic mkdir, writing the holder
 * pid inside. Polls until a slot frees or `maxWaitMs` elapses (returns null).
 * The returned handle releases once; callers must invoke release() — or use
 * withTscSlot, which also covers timeout and signal exits.
 */
export function acquireTscSlot(slotsDir, options = {}) {
  const {
    count = 3,
    pid = process.pid,
    maxWaitMs = 900_000,
    pollMs = 250,
    mkdir = mkdirSync,
    rm = rmSync,
    write = writeFileSync,
    reclaim = reclaimStaleTscSlot,
    sleep = sleepSync,
    now = Date.now,
  } = options;
  mkdir(slotsDir, { recursive: true });
  const deadline = now() + maxWaitMs;
  for (;;) {
    let reclaimed = false;
    for (let index = 0; index < count; index += 1) {
      const slotPath = join(slotsDir, `slot-${index}`);
      try {
        mkdir(slotPath);
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (reclaim(slotPath)) reclaimed = true;
        continue;
      }
      try {
        write(join(slotPath, 'pid'), `${pid}\n`);
      } catch (error) {
        rm(slotPath, { recursive: true, force: true });
        throw error;
      }
      let released = false;
      return {
        index,
        path: slotPath,
        release: () => {
          if (released) return;
          released = true;
          rm(slotPath, { recursive: true, force: true });
        },
      };
    }
    if (reclaimed) continue;
    const remaining = deadline - now();
    if (remaining <= 0) return null;
    sleep(Math.min(pollMs, remaining));
  }
}

/**
 * Run body() while holding a typecheck slot. The slot is freed on success,
 * thrown failure, and on 'exit'/SIGINT/SIGTERM/SIGHUP so a killed typecheck
 * can never leak a slot. Returns { acquired: false } when no slot freed
 * within the wait bound, otherwise { acquired: true, result }.
 */
export function withTscSlot(slotsDir, options, body) {
  const slot = acquireTscSlot(slotsDir, options);
  if (slot === null) return { acquired: false };
  const release = () => {
    try {
      slot.release();
    } catch { /* release must never throw during exit */ }
  };
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'];
  const handlers = signals.map((signal) => {
    const handler = () => {
      release();
      process.kill(process.pid, signal);
    };
    process.once(signal, handler);
    return [signal, handler];
  });
  process.on('exit', release);
  try {
    return { acquired: true, result: body(slot) };
  } finally {
    process.off('exit', release);
    for (const [signal, handler] of handlers) process.off(signal, handler);
    release();
  }
}

/** Copy through a unique sibling so readers never see a partially written cache. */
export function copyBuildInfo(source, destination) {
  mkdirSync(dirname(destination), { recursive: true });
  const temporary = `${destination}.${process.pid}.${randomUUID()}.tmp`;
  try {
    copyFileSync(source, temporary);
    renameSync(temporary, destination);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/** Native diagnostics (exit 1/2) are final; only crashes use the JS compiler. */
export function runNativeTypecheck(root, timeout, spawn = spawnSync, exists = existsSync, config = 'tsconfig.json') {
  const binary = resolve(root, 'node_modules/.bin/tsgo');
  if (!exists(binary)) return null;
  const result = spawn(binary, typecheckArgs(root, config), {
    cwd: root, stdio: 'inherit', timeout: timeout * 1000, killSignal: 'SIGKILL',
  });
  if (result.error?.code === 'ETIMEDOUT') return false;
  if (result.error || result.signal || result.status === null || result.status > 2) {
    console.warn('Native compiler crashed; falling back to tsc');
    return null;
  }
  return result.status === 0;
}

/** Run one tsconfig project with the backend's native-first diagnostic policy. */
function runProjectTypecheck(root, timeout, run, config, label, spawn, exists) {
  const native = runNativeTypecheck(root, timeout, spawn, exists, config);
  if (native === null) return run(`${label} typecheck`, 'node_modules/typescript/bin/tsc', typecheckArgs(root, config), timeout);
  console.log(`${native ? 'PASS' : 'FAIL'} ${label} typecheck`);
  return native;
}

/** Run the web compiler with the backend's native-first diagnostic policy. */
export function runWebTypecheck(root, timeout, run, spawn = spawnSync, exists = existsSync) {
  return runProjectTypecheck(root, timeout, run, 'src/web-ui/tsconfig.json', 'web', spawn, exists);
}

/** Run the desktop compiler (fleet-map components, desktop scripts) the same way. */
export function runDesktopTypecheck(root, timeout, run, spawn = spawnSync, exists = existsSync) {
  return runProjectTypecheck(root, timeout, run, 'desktop/tsconfig.json', 'desktop', spawn, exists);
}

/** Scope the guard's failing file lists while preserving unexpected failures. */
export function runRealioCheck(root, changed, spawn = spawnSync) {
  const result = spawn(process.execPath, ['scripts/check-realio-lane-membership.mjs'], {
    cwd: root, encoding: 'utf8',
  });
  if (result.error || result.signal || (result.status !== 0 && result.status !== 1)) {
    if (result.stdout) console.log(result.stdout.trimEnd());
    if (result.stderr) console.error(result.stderr.trimEnd());
    if (result.error) console.error(result.error.message);
    console.log('FAIL realio lane lint');
    return false;
  }
  const files = [];
  let failingSection = false;
  for (const line of (result.stderr || '').split('\n')) {
    if (line.startsWith('[check-realio-lane-membership]')) {
      failingSection = /(?:The following test files|stale KNOWN_FAST_SPAWN_FILES|stale REAL_IO_TEST_FILES)/.test(line);
    }
    if (failingSection && /^ {2}test\//.test(line)) files.push(line.slice(2));
  }
  if (result.status === 1 && files.length === 0) {
    if (result.stderr) console.error(result.stderr.trimEnd());
    console.log('FAIL realio lane lint: unrecognized guard failure');
    return false;
  }
  const changedSet = new Set(changed);
  const relevant = files.filter((file) => changedSet.has(file));
  const unrelated = files.filter((file) => !changedSet.has(file));
  if (unrelated.length) console.warn(`WARN realio lane lint: unchanged files: ${unrelated.join(', ')}`);
  if (relevant.length) console.error(`Realio lane violations in changed files: ${relevant.join(', ')}`);
  if (result.status === 0) {
    if (result.stdout) console.log(result.stdout.trimEnd());
    if (result.stderr) console.warn(result.stderr.trimEnd());
  }
  console.log(`${relevant.length ? 'FAIL' : 'PASS'} realio lane lint`);
  return relevant.length === 0;
}

/** Check the generated registry before taking a typecheck slot. */
export function runFleetRegistryCheck(selected, run) {
  if (!selected) {
    console.log('PASS fleet registry skipped: no fleet command changed');
    return true;
  }
  if (run('fleet registry check', 'scripts/gen-fleet-registry.mjs', ['--check'])) return true;
  console.error('Run node scripts/gen-fleet-registry.mjs to update the fleet registry');
  process.exitCode = 1;
  return false;
}

/**
 * Real tree hash of the working state. The live index is copied to a private
 * GIT_INDEX_FILE so `git add -A` stages committed, staged, unstaged and
 * untracked (non-ignored) content in one pass, then `write-tree` emits the
 * hash. Copying the live index preserves its stat cache, so unchanged files
 * are not rehashed; the real index is never touched. A missing index (before
 * the first checkout materializes one) is seeded from HEAD.
 */
export function workingTreeHash(root, exec = execFileSync) {
  const gitDir = exec('git', ['rev-parse', '--git-dir'], { cwd: root, encoding: 'utf8' }).trim();
  const index = join(tmpdir(), `phantom-verify-index-${process.pid}-${randomUUID()}`);
  const env = { ...process.env, GIT_INDEX_FILE: index };
  try {
    try {
      copyFileSync(resolve(root, gitDir, 'index'), index);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      exec('git', ['read-tree', 'HEAD'], { cwd: root, env });
    }
    exec('git', ['add', '-A'], { cwd: root, env });
    return exec('git', ['write-tree'], { cwd: root, env, encoding: 'utf8' }).trim();
  } finally {
    rmSync(index, { force: true });
    rmSync(`${index}.lock`, { force: true });
  }
}

/** Marker root shared across worktrees through the git common dir; PHANTOM_VERIFY_PASSED_DIR relocates it. */
export function verifyPassedDir(root, env = process.env, exec = execFileSync) {
  return env.PHANTOM_VERIFY_PASSED_DIR
    || resolve(root, exec('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim(), 'phantom-verify-passed');
}

/**
 * Inputs a recorded pass is valid for: the working-tree hash, the diff anchor/mode
 * (changed-file selection depends on it), and the installed checker
 * identities, whose drift can change a verdict on an identical tree.
 */
export function verifyDedupeInput(root, exec = execFileSync, exists = existsSync, read = readFileSync, comparison = verificationBase(root, exec)) {
  const version = (pkg) => {
    try {
      const parsed = JSON.parse(read(resolve(root, 'node_modules', pkg, 'package.json'), 'utf8'));
      return typeof parsed.version === 'string' ? parsed.version : '';
    } catch {
      return '';
    }
  };
  return {
    base: comparison.mode === 'merge-base' ? comparison.base : `${comparison.mode}:${comparison.base}`,
    tree: workingTreeHash(root, exec),
    eslint: eslintPreflight(root, exists).ok ? version('eslint') : '',
    typescript: version('typescript'),
    tsgo: exists(resolve(root, 'node_modules/.bin/tsgo')),
    node: process.version,
    platform: process.platform,
  };
}

/** Stable key for a dedupe marker: one sha256 over the JSON input record. */
export function verifyDedupeKey(input) {
  return createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

/** Marker lookup: a readable record whose key matches means this state already passed. */
export function readVerifyPassed(dir, key, read = readFileSync) {
  try {
    const record = JSON.parse(read(join(dir, `${key}.json`), 'utf8'));
    return record && record.key === key ? record : null;
  } catch {
    return null;
  }
}

export const VERIFY_PASSED_CAP = 256;

/**
 * Record a passing state as <dir>/<key>.json through a unique sibling so
 * readers never see a partial write, then prune the oldest markers past `cap`.
 */
export function recordVerifyPassed(dir, input, options = {}) {
  const {
    key = verifyDedupeKey(input), cap = VERIFY_PASSED_CAP, pid = process.pid,
    mkdir = mkdirSync, readdir = readdirSync, rename = renameSync, rm = rmSync,
    stat = statSync, write = writeFileSync, now = Date.now,
  } = options;
  mkdir(dir, { recursive: true });
  const target = join(dir, `${key}.json`);
  const temp = `${target}.${pid}.${randomUUID()}.tmp`;
  try {
    write(temp, `${JSON.stringify({ ...input, key, recordedAt: new Date(now()).toISOString() })}\n`);
    rename(temp, target);
  } finally {
    rm(temp, { force: true });
  }
  const entries = readdir(dir).filter((name) => name.endsWith('.json'));
  if (entries.length <= cap) return target;
  const oldest = entries.map((name) => {
    try {
      return { name, mtime: stat(join(dir, name)).mtimeMs };
    } catch {
      return { name, mtime: 0 };
    }
  }).sort((a, b) => a.mtime - b.mtime);
  for (const entry of oldest.slice(0, entries.length - cap)) rm(join(dir, entry.name), { force: true });
  return target;
}

/** Bypass flag: `--force` on argv or a truthy PHANTOM_VERIFY_FORCE reruns verify instead of skipping. */
export function verifyForceRequested(argv, env = process.env) {
  if (argv.includes('--force')) return true;
  return /^(?:1|true|yes|on)$/i.test(env.PHANTOM_VERIFY_FORCE ?? '');
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  let comparison;
  let dedupe = null;
  try {
    comparison = verificationBase(root);
    if (comparison.mode !== 'merge-base') console.log('WARN no merge base: using working-tree status and diff against HEAD');
    const input = verifyDedupeInput(root, execFileSync, existsSync, readFileSync, comparison);
    dedupe = { dir: verifyPassedDir(root), input, key: verifyDedupeKey(input) };
    if (!verifyForceRequested(process.argv.slice(2))) {
      const hit = readVerifyPassed(dedupe.dir, dedupe.key);
      if (hit) {
        console.log(`SKIP verify-changed: tree ${input.tree.slice(0, 12)} already passed${hit.recordedAt ? ` at ${hit.recordedAt}` : ''}; rerun with --force`);
        return;
      }
    }
  } catch (error) {
    console.warn(`WARN verify dedupe unavailable: ${error.message}`);
    dedupe = null;
  }
  let selection;
  let changed;
  let projects;
  let pythonFiles = [];
  let shellFiles = [];
  let perlFiles = [];
  let powershellFiles = [];
  let nodeFiles = [];
  let conflictFiles = [];
  try {
    changed = collectChangedPaths(root, comparison);
    const existing = changed.filter((path) => {
      try {
        return statSync(resolve(root, path)).isFile();
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
        throw error;
      }
    });
    selection = selectChangedFiles(changed, existing);
    conflictFiles = selectConflictScanFiles(changed, existing);
    projects = typecheckProjects(changed);
    const projectNames = ['backend', 'web', 'desktop'].filter((name) => projects[name]);
    const projectScope = projectNames.length > 1
      ? `${projectNames.slice(0, -1).join(', ')} and ${projectNames.at(-1)}`
      : projectNames[0] ?? null;
    const scope = [projectScope, selection.contribTypecheck && 'contrib'].filter(Boolean).join(' and ') || 'typecheck skipped';
    console.log(`verify: ${new Set(changed).size} changed files (${comparison?.mode ?? 'merge-base'}), ${scope}${projects.backend || projects.web || projects.desktop ? ', incremental' : changed.length ? ': no project change' : ': no changes'}`);
    const shebangScripts = selectShebangScripts(changed, existing, (path) => readFirstLine(root, path));
    pythonFiles = [...new Set([...selection.pythonFiles, ...shebangScripts.python])];
    shellFiles = [...new Set([...selection.shellFiles, ...shebangScripts.shell])];
    perlFiles = [...new Set([...selection.perlFiles, ...shebangScripts.perl])];
    powershellFiles = selection.powershellFiles;
    nodeFiles = shebangScripts.node;
    console.log('PASS file selection');
    const emptyTests = emptyChangedTests(existing.map((path) => resolve(root, path)));
    if (emptyTests.length) {
      console.error(`FAIL empty test files: ${emptyTests.join(', ')}`);
      console.error('A new test file must contain at least one test.');
      process.exitCode = 1;
      return;
    }
    console.log('PASS empty test check');
  } catch (error) {
    console.error(`FAIL file selection: ${error.message}`);
    process.exitCode = 1;
    return;
  }
  const run = (name, script, args = [], timeoutSeconds) => {
    const result = spawnSync(process.execPath, [script, ...args], {
      cwd: root, stdio: 'inherit', timeout: timeoutSeconds && timeoutSeconds * 1000,
      killSignal: timeoutSeconds ? 'SIGKILL' : undefined,
    });
    const passed = !result.error && result.status === 0;
    if (result.error?.code === 'ETIMEDOUT') console.log(`FAIL tsc timed out after ${timeoutSeconds}s`);
    else console.log(`${passed ? 'PASS' : 'FAIL'} ${name}`);
    if (result.error && result.error.code !== 'ETIMEDOUT') console.error(result.error.message);
    if (!passed) process.exitCode = 1;
    return passed;
  };
  if (!runFleetRegistryCheck(selection.fleetRegistry, run)) return;
  if (selection.authorityDrift && !run('authority drift', 'scripts/test-ci.mjs', ['test/authority-codeowners-310b.test.ts', 'test/authority-tier1-closure-310b.test.ts'])) {
    console.error('Review authority drift, then run npm run authority:regen');
    return;
  }
  if (selection.authorityDrift) {
    let overlay = null;
    try {
      if (comparison?.mode !== 'merge-base') console.warn('WARN authority drift on current master skipped: no merge base; local authority checks still run');
      else if (masterMovedAuthorityDrift(root)) overlay = materializeMasterOverlay(root, changed);
    } catch (error) {
      console.log(`SKIP authority drift on current master: ${error.message}`);
    }
    if (overlay) {
      try {
        const result = spawnSync(process.execPath, ['scripts/test-ci.mjs', 'test/authority-codeowners-310b.test.ts', 'test/authority-tier1-closure-310b.test.ts'], { cwd: overlay, stdio: 'inherit' });
        const passed = !result.error && result.status === 0;
        console.log(`${passed ? 'PASS' : 'FAIL'} authority drift on current master`);
        if (!passed) {
          console.error('origin/master moved since this branch forked and the combination drifts. Rebase onto origin/master, then run npm run authority:regen and review the diff.');
          process.exitCode = 1;
          return;
        }
      } finally {
        rmSync(overlay, { recursive: true, force: true });
      }
    }
  }
  if (selection.docsCheck) {
    const docsPreflight = docsCheckPreflight(root);
    if (!docsPreflight.ok) {
      console.log(`SKIP docs check: ${docsPreflight.reason}; check:docs runs on CI and npm run gate`);
    } else {
      run('docs check', 'scripts/check-documentation.mjs');
    }
  } else {
    console.log('PASS docs check skipped: no markdown change or file deletion');
  }
  const preflight = eslintPreflight(root);
  if (!preflight.ok) {
    console.log(`SKIP eslint: ${preflight.reason}; Merge Gate lints on CI`);
  } else if (selection.lintFiles.length) {
    // ESLint applies its own config/ignores; explicit ignored paths are silent.
    run('eslint changed files', 'node_modules/eslint/bin/eslint.js', ['--no-warn-ignored', '--', ...selection.lintFiles.map((path) => `./${path}`)]);
  } else {
    console.log('PASS eslint skipped: no lintable file changed');
  }
  if (pythonFiles.length === 0) {
    console.log('PASS python syntax check skipped: no python change');
  } else {
    const python = pythonPreflight();
    if (!python.ok) {
      console.log(`SKIP python syntax check: ${python.reason}`);
    } else if (!runPythonSyntaxCheck(root, pythonFiles)) {
      process.exitCode = 1;
    }
  }
  if (shellFiles.length === 0) {
    console.log('PASS shell syntax check skipped: no shell change');
  } else {
    const shell = shellPreflight();
    if (!shell.ok) {
      console.log(`SKIP shell syntax check: ${shell.reason}`);
    } else if (!runShellSyntaxCheck(root, shellFiles)) {
      process.exitCode = 1;
    }
  }
  if (perlFiles.length === 0) {
    console.log('PASS perl syntax check skipped: no perl change');
  } else {
    const perl = perlPreflight();
    if (!perl.ok) {
      console.log(`SKIP perl syntax check: ${perl.reason}`);
    } else if (!runPerlSyntaxCheck(root, perlFiles)) {
      process.exitCode = 1;
    }
  }
  if (powershellFiles.length === 0) {
    console.log('PASS powershell syntax check skipped: no powershell change');
  } else {
    const powershell = powershellPreflight();
    if (!powershell.ok) {
      console.log(`SKIP powershell syntax check: ${powershell.reason}`);
    } else if (!runPowerShellSyntaxCheck(root, powershellFiles, powershell.exe)) {
      process.exitCode = 1;
    }
  }
  if (nodeFiles.length === 0) {
    console.log('PASS node syntax check skipped: no node-shebang script changed');
  } else if (!runNodeSyntaxCheck(root, nodeFiles)) {
    process.exitCode = 1;
  }
  if (selection.detachedScriptFiles.length === 0) {
    console.log('PASS detached script syntax check skipped: no script change under src/raycast/ or examples/universe-site/');
  } else {
    const detached = parserPackagePreflight(root, 'typescript');
    if (!detached.ok) {
      console.log(`SKIP detached script syntax check: ${detached.reason}`);
    } else if (!runDetachedScriptCheck(root, selection.detachedScriptFiles)) {
      process.exitCode = 1;
    }
  }
  if (selection.jsonFiles.length === 0) {
    console.log('PASS json syntax check skipped: no json, webmanifest or tsbuildinfo change');
  } else if (!runJsonSyntaxCheck(root, selection.jsonFiles)) {
    process.exitCode = 1;
  }
  if (selection.jsonlFiles.length === 0) {
    console.log('PASS jsonl syntax check skipped: no jsonl change');
  } else if (!runJsonlSyntaxCheck(root, selection.jsonlFiles)) {
    process.exitCode = 1;
  }
  if (selection.xmlFiles.length === 0) {
    console.log('PASS xml syntax check skipped: no xml, plist or svg change');
  } else {
    const python = pythonPreflight(spawnSync, 'changed XML files');
    if (!python.ok) {
      console.log(`SKIP xml syntax check: ${python.reason}`);
    } else if (!runXmlSyntaxCheck(root, selection.xmlFiles)) {
      process.exitCode = 1;
    }
  }
  if (selection.rustFiles.length === 0) {
    console.log('PASS rust syntax check skipped: no rust change');
  } else {
    const rust = rustPreflight();
    if (!rust.ok) {
      console.log(`SKIP rust syntax check: ${rust.reason}`);
    } else if (!runRustSyntaxCheck(root, selection.rustFiles)) {
      process.exitCode = 1;
    }
  }
  if (selection.swiftFiles.length === 0) {
    console.log('PASS swift syntax check skipped: no swift change');
  } else {
    const swift = swiftPreflight();
    if (!swift.ok) {
      console.log(`SKIP swift syntax check: ${swift.reason}`);
    } else if (!runSwiftSyntaxCheck(root, selection.swiftFiles)) {
      process.exitCode = 1;
    }
  }
  if (selection.yamlFiles.length === 0) {
    console.log('PASS yaml syntax check skipped: no yaml or cff change');
  } else {
    const yaml = parserPackagePreflight(root, 'yaml');
    if (!yaml.ok) {
      console.log(`SKIP yaml syntax check: ${yaml.reason}`);
    } else if (!runYamlSyntaxCheck(root, selection.yamlFiles)) {
      process.exitCode = 1;
    }
  }
  if (selection.tomlFiles.length === 0) {
    console.log('PASS toml syntax check skipped: no toml or Cargo.lock change');
  } else {
    const toml = parserPackagePreflight(root, 'smol-toml');
    if (!toml.ok) {
      console.log(`SKIP toml syntax check: ${toml.reason}`);
    } else if (!runTomlSyntaxCheck(root, selection.tomlFiles)) {
      process.exitCode = 1;
    }
  }
  if (selection.cssFiles.length === 0) {
    console.log('PASS css syntax check skipped: no css change');
  } else {
    const css = cssParserPreflight(root);
    if (!css.ok) {
      console.log(`SKIP css syntax check: ${css.reason}`);
    } else if (!runCssSyntaxCheck(root, selection.cssFiles)) {
      process.exitCode = 1;
    }
  }
  if (selection.snapFiles.length === 0) {
    console.log('PASS snap syntax check skipped: no snapshot change');
  } else if (!runSnapSyntaxCheck(root, selection.snapFiles)) {
    process.exitCode = 1;
  }
  if (selection.patchFiles.length === 0) {
    console.log('PASS patch syntax check skipped: no patch or diff change');
  } else if (!runPatchSyntaxCheck(root, selection.patchFiles)) {
    process.exitCode = 1;
  }
  if (selection.htmlFiles.length === 0) {
    console.log('PASS html payload syntax check skipped: no html change');
  } else {
    const html = htmlPayloadPreflight(root);
    if (!html.ok) {
      console.log(`SKIP html payload syntax check: ${html.reason}`);
    } else if (!runHtmlPayloadCheck(root, selection.htmlFiles)) {
      process.exitCode = 1;
    }
  }
  if (selection.seatbeltFiles.length === 0) {
    console.log('PASS seatbelt syntax check skipped: no .sb change');
  } else if (!runSeatbeltSyntaxCheck(root, selection.seatbeltFiles)) {
    process.exitCode = 1;
  }
  if (selection.mdcFiles.length === 0) {
    console.log('PASS mdc frontmatter syntax check skipped: no .mdc change');
  } else {
    const mdc = parserPackagePreflight(root, 'yaml');
    if (!mdc.ok) {
      console.log(`SKIP mdc frontmatter syntax check: ${mdc.reason}`);
    } else if (!runMdcSyntaxCheck(root, selection.mdcFiles)) {
      process.exitCode = 1;
    }
  }
  if (conflictFiles.length === 0) {
    console.log('PASS conflict marker check skipped: no changed file to scan');
  } else if (!runConflictMarkerCheck(root, conflictFiles)) {
    process.exitCode = 1;
  }
  if (selection.quarantineCheck) {
    try {
      run('quarantine ledger', 'scripts/check-quarantine-ledger.mjs', ['--base', (comparison ?? verificationBase(root)).base]);
    } catch (error) {
      console.log(`FAIL quarantine ledger: ${error.message}`);
      process.exitCode = 1;
    }
  } else {
    console.log('PASS quarantine ledger skipped: no test file or quarantine ledger change');
  }
  if (!selection.realioLaneCheck) {
    console.log('PASS realio lane lint skipped: no test file or lane input change');
  } else if (!runRealioCheck(root, changed)) {
    process.exitCode = 1;
  }
  if (!selection.verseSyncIoCheck) {
    console.log('PASS verse sync-I/O lint skipped: no verse route or checker change');
  } else {
    run('verse sync-I/O lint', 'scripts/check-verse-sync-io.mjs');
  }
  if (projects.backend || projects.web || projects.desktop || selection.contribTypecheck) try {
    const timeout = Number(process.env.PHANTOM_TSC_TIMEOUT_SECONDS ?? 900);
    if (!Number.isFinite(timeout) || !Number.isInteger(timeout * 1000) || timeout * 1000 < 1 || timeout * 1000 > 2_147_483_647) {
      throw new Error('PHANTOM_TSC_TIMEOUT_SECONDS must be a positive number of seconds within the supported timeout range');
    }
    const held = withTscSlot(tscSlotsDir(root), { count: tscSlotCount(), maxWaitMs: timeout * 1000 }, () => {
      mkdirSync(resolve(root, '.ashlr-gate/verify'), { recursive: true });
      if (!selection.contribTypecheck) {
        console.log('PASS contrib typecheck skipped: no contrib program input changed');
      } else {
        const contrib = parserPackagePreflight(root, 'typescript');
        if (!contrib.ok) {
          console.log(`SKIP contrib typecheck: ${contrib.reason}`);
        } else {
          const contribFiles = contribProgramFiles(root);
          if (contribFiles.length === 0) {
            console.log('PASS contrib typecheck skipped: no program files under contrib/');
          } else if (!runContribTypecheck(root, contribFiles)) {
            process.exitCode = 1;
          }
        }
      }
      if (projects.backend) {
        const native = runNativeTypecheck(root, timeout);
        if (native !== null) {
          console.log(`${native ? 'PASS' : 'FAIL'} tsgo --noEmit`);
          if (!native) process.exitCode = 1;
        } else {
          const cache = tscCachePaths(root);
          try {
            copyBuildInfo(cache.shared, cache.local);
          } catch (error) {
            if (error.code !== 'ENOENT') throw error;
          }
          if (run('tsc --noEmit', 'node_modules/typescript/bin/tsc', typecheckArgs(root), timeout)) {
            copyBuildInfo(cache.local, cache.shared);
          }
        }
      } else console.log('PASS backend typecheck skipped: no backend change');
      if (projects.web) {
        if (!runWebTypecheck(root, timeout, run)) process.exitCode = 1;
      } else {
        console.log('PASS web typecheck skipped: no changed path under src/web-ui/');
      }
      if (projects.desktop) {
        if (!runDesktopTypecheck(root, timeout, run)) process.exitCode = 1;
      } else {
        console.log('PASS desktop typecheck skipped: no desktop change');
      }
    });
    if (!held.acquired) {
      console.log(`FAIL tsc slot wait: no typecheck slot freed within ${timeout}s`);
      process.exitCode = 1;
    }
  } catch (error) {
    console.error(`FAIL tsc cache: ${error.message}`);
    process.exitCode = 1;
  }
  if (dedupe && !process.exitCode) {
    try {
      recordVerifyPassed(dedupe.dir, dedupe.input, { key: dedupe.key });
      console.log(`PASS verify dedupe: recorded tree ${dedupe.input.tree.slice(0, 12)}`);
    } catch (error) {
      console.warn(`WARN verify dedupe record failed: ${error.message}`);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
