import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, readSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

/** Pure selection: keep deleted paths for the web decision, but never lint them. */
export function selectChangedFiles(changedPaths, existingPaths) {
  const changed = [...new Set(changedPaths)].filter(Boolean).sort();
  const existing = new Set(existingPaths);
  return {
    lintFiles: changed.filter((path) => existing.has(path) && /\.(?:[cm]?js|[cm]?ts|tsx|jsx)$/.test(path)),
    pythonFiles: changed.filter((path) => existing.has(path) && /\.py$/.test(path)),
    shellFiles: changed.filter((path) => existing.has(path) && /\.sh$/.test(path)),
    jsonFiles: changed.filter((path) => existing.has(path) && /\.json$/.test(path)),
    xmlFiles: changed.filter((path) => existing.has(path) && /\.(?:xml|plist|svg)$/.test(path)),
    webTypecheck: changed.some((path) => path.startsWith('src/web-ui/')),
    authorityDrift: changed.some(affectsAuthorityDrift),
    fleetRegistry: changed.some((path) => /^src\/cli\/fleet-[^/]*\.ts$/.test(path)),
    docsCheck: changed.some((path) => DOC_MARKDOWN.test(path) || !existing.has(path)),
    quarantineCheck: changed.some((path) => QUARANTINE_TEST_FILE.test(path) || path === QUARANTINE_LEDGER),
    rustFiles: changed.filter((path) => existing.has(path) && /\.rs$/.test(path)),
    swiftFiles: changed.filter((path) => existing.has(path) && /\.swift$/.test(path)),
    yamlFiles: changed.filter((path) => existing.has(path) && /\.ya?ml$/.test(path)),
    tomlFiles: changed.filter((path) => existing.has(path) && /\.toml$/.test(path)),
  };
}

/**
 * Extensionless executables carry their language in the shebang, not the
 * filename, so the extension rules above never see them: `bin/ashlr` (node),
 * `contrib/mac/metrics-outcomes` (python3) and `contrib/router/ashlr-router`
 * (bash) all escaped every syntax check. Classify the interpreter from the
 * first line; `env` forwards its own options (`-S`, `VAR=value`) before the
 * real command. Only interpreters with a matching grammar step classify —
 * python, node, and the POSIX shells `bash -n` parses (sh/bash/dash). zsh,
 * ksh, perl and friends return null and stay unchecked, exactly as before.
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
  const buckets = { python: [], shell: [], node: [] };
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

/** Merge-base of HEAD and origin/master — the diff anchor base-scoped checks share. */
export function masterMergeBase(root, exec = execFileSync) {
  return exec('git', ['merge-base', 'HEAD', 'origin/master'], { cwd: root, encoding: 'utf8' }).trim();
}

/** Include committed changes, index/worktree edits, deletions and untracked files. */
export function collectChangedPaths(root) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
  const base = masterMergeBase(root);
  // NUL delimiters preserve whitespace/newlines; disabling renames includes both sides.
  return [
    ...git('diff', '--name-only', '--no-renames', '-z', base, 'HEAD', '--').split('\0'),
    ...git('diff', '--cached', '--name-only', '--no-renames', '-z', '--').split('\0'),
    ...git('diff', '--name-only', '--no-renames', '-z', '--').split('\0'),
    ...git('ls-files', '--others', '--exclude-standard', '-z').split('\0'),
  ].filter(Boolean);
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
 * Strict-parse changed .json files with JSON.parse — the same grammar
 * tscCachePaths already applies to tsconfig.json and sync-plan's checkSyntax
 * applies to fleet machinery — so a failure is a real break for package.json,
 * manifests, schemas and registries. No external interpreter is needed, so
 * unlike the Python and shell checks there is no preflight or SKIP path; every
 * failing path is named with its parse error.
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

// ElementTree is the well-formedness grammar plutil, site generators and
// SVG renderers all enforce on XML-family files: one interpreter run covers
// the batch and the first parse error fails the check. A .plist has three
// encodings and only the XML one starts with "<" (after an optional BOM or
// whitespace), so binary and OpenStep ASCII plists — comments and all —
// skip the parser instead of failing it; a .xml or .svg that is not XML at
// all must parse. Named HTML entities like &nbsp; are undefined in XML and
// fail; that strictness is deliberate — the file is malformed XML even
// where browsers render it leniently.
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

/** Syntax-check changed XML-family files (.xml, .plist, .svg); false on any interpreter or parse failure. */
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
 * .yaml/.yml and .toml files — GitHub workflows, dependabot, codecov,
 * socket, the pnpm workspace and lock manifests, agent-network, lexicon
 * and cliff configs, Cargo.toml — are consumed by parsers a text diff can
 * never prove. `yaml` and `smol-toml` are already bundled dependencies, so
 * the grammar steps use the same parsers the codebase itself ships, but
 * they run in a child node process: a top-level import here would keep
 * this script from loading at all when node_modules is absent, while the
 * preflight reports that case as SKIP like the ESLint and docs checks.
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

/** Syntax-check changed .yaml/.yml files with the bundled yaml parser; false on any parse failure. */
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

/** Syntax-check changed .toml files with the bundled smol-toml parser; false on any parse failure. */
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

/** Shared root for the typecheck cache and slots; worktrees resolve to the git common dir. */
export function tscSharedRoot(root, env = process.env, exec = execFileSync) {
  return env.PHANTOM_TSC_CACHE_DIR
    || resolve(root, exec('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8' }).trim(), 'phantom-tsc-cache');
}

/** Resolve the local and shared incremental build-info paths for this checkout. */
export function tscCachePaths(root, env = process.env, exec = execFileSync) {
  const config = readFileSync(resolve(root, 'tsconfig.json'));
  const lock = readFileSync(resolve(root, 'package-lock.json'));
  const buildInfo = JSON.parse(config.toString()).compilerOptions?.tsBuildInfoFile;
  if (typeof buildInfo !== 'string' || !buildInfo) throw new Error('tsconfig.json must specify tsBuildInfoFile');
  const hash = createHash('sha256').update(String(lock.length)).update(':').update(lock).update(config).digest('hex');
  return { local: resolve(root, buildInfo), shared: resolve(root, tscSharedRoot(root, env, exec), `${hash}.tsbuildinfo`) };
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
  const result = spawn(binary, ['--noEmit', '-p', config], {
    cwd: root, stdio: 'inherit', timeout: timeout * 1000, killSignal: 'SIGKILL',
  });
  if (result.error?.code === 'ETIMEDOUT') return false;
  if (result.error || result.signal || result.status === null || result.status > 2) {
    console.warn('Native compiler crashed; falling back to tsc');
    return null;
  }
  return result.status === 0;
}

/** Run the web compiler with the backend's native-first diagnostic policy. */
export function runWebTypecheck(root, timeout, run, spawn = spawnSync, exists = existsSync) {
  const config = 'src/web-ui/tsconfig.json';
  const native = runNativeTypecheck(root, timeout, spawn, exists, config);
  if (native === null) return run('web typecheck', 'node_modules/typescript/bin/tsc', ['--noEmit', '-p', config], timeout);
  console.log(`${native ? 'PASS' : 'FAIL'} web typecheck`);
  return native;
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
 * Inputs a recorded pass is valid for: the working-tree hash, the merge-base
 * (changed-file selection depends on it), and the installed checker
 * identities, whose drift can change a verdict on an identical tree.
 */
export function verifyDedupeInput(root, exec = execFileSync, exists = existsSync, read = readFileSync) {
  const version = (pkg) => {
    try {
      const parsed = JSON.parse(read(resolve(root, 'node_modules', pkg, 'package.json'), 'utf8'));
      return typeof parsed.version === 'string' ? parsed.version : '';
    } catch {
      return '';
    }
  };
  return {
    base: exec('git', ['merge-base', 'HEAD', 'origin/master'], { cwd: root, encoding: 'utf8' }).trim(),
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
  let dedupe = null;
  try {
    const input = verifyDedupeInput(root);
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
  let pythonFiles = [];
  let shellFiles = [];
  let nodeFiles = [];
  try {
    changed = collectChangedPaths(root);
    const existing = changed.filter((path) => {
      try {
        return statSync(resolve(root, path)).isFile();
      } catch (error) {
        if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return false;
        throw error;
      }
    });
    selection = selectChangedFiles(changed, existing);
    const shebangScripts = selectShebangScripts(changed, existing, (path) => readFirstLine(root, path));
    pythonFiles = [...new Set([...selection.pythonFiles, ...shebangScripts.python])];
    shellFiles = [...new Set([...selection.shellFiles, ...shebangScripts.shell])];
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
      if (masterMovedAuthorityDrift(root)) overlay = materializeMasterOverlay(root, changed);
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
  if (nodeFiles.length === 0) {
    console.log('PASS node syntax check skipped: no node-shebang script changed');
  } else if (!runNodeSyntaxCheck(root, nodeFiles)) {
    process.exitCode = 1;
  }
  if (selection.jsonFiles.length === 0) {
    console.log('PASS json syntax check skipped: no json change');
  } else if (!runJsonSyntaxCheck(root, selection.jsonFiles)) {
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
    console.log('PASS yaml syntax check skipped: no yaml change');
  } else {
    const yaml = parserPackagePreflight(root, 'yaml');
    if (!yaml.ok) {
      console.log(`SKIP yaml syntax check: ${yaml.reason}`);
    } else if (!runYamlSyntaxCheck(root, selection.yamlFiles)) {
      process.exitCode = 1;
    }
  }
  if (selection.tomlFiles.length === 0) {
    console.log('PASS toml syntax check skipped: no toml change');
  } else {
    const toml = parserPackagePreflight(root, 'smol-toml');
    if (!toml.ok) {
      console.log(`SKIP toml syntax check: ${toml.reason}`);
    } else if (!runTomlSyntaxCheck(root, selection.tomlFiles)) {
      process.exitCode = 1;
    }
  }
  if (selection.quarantineCheck) {
    try {
      run('quarantine ledger', 'scripts/check-quarantine-ledger.mjs', ['--base', masterMergeBase(root)]);
    } catch (error) {
      console.log(`FAIL quarantine ledger: ${error.message}`);
      process.exitCode = 1;
    }
  } else {
    console.log('PASS quarantine ledger skipped: no test file or quarantine ledger change');
  }
  try {
    const timeout = Number(process.env.PHANTOM_TSC_TIMEOUT_SECONDS ?? 900);
    if (!Number.isFinite(timeout) || !Number.isInteger(timeout * 1000) || timeout * 1000 < 1 || timeout * 1000 > 2_147_483_647) {
      throw new Error('PHANTOM_TSC_TIMEOUT_SECONDS must be a positive number of seconds within the supported timeout range');
    }
    const held = withTscSlot(tscSlotsDir(root), { count: tscSlotCount(), maxWaitMs: timeout * 1000 }, () => {
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
        if (run('tsc --noEmit', 'node_modules/typescript/bin/tsc', ['--noEmit', '-p', 'tsconfig.json'], timeout)) {
          copyBuildInfo(cache.local, cache.shared);
        }
      }
      if (selection.webTypecheck) {
        if (!runWebTypecheck(root, timeout, run)) process.exitCode = 1;
      } else {
        console.log('PASS web typecheck skipped: no changed path under src/web-ui/');
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
  if (!runRealioCheck(root, changed)) process.exitCode = 1;
  run('verse sync-I/O lint', 'scripts/check-verse-sync-io.mjs');
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
