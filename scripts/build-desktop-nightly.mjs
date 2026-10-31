#!/usr/bin/env node
/**
 * build-desktop-nightly.mjs — reproducible unsigned Phantom desktop dev build
 * for the scheduled master CI run.
 *
 * One command turns a clean macOS checkout into a packed dev artifact:
 *
 *   node scripts/build-desktop-nightly.mjs            # full pipeline
 *   node scripts/build-desktop-nightly.mjs --check    # preflight + plan only
 *
 * Pipeline (same shape as .github/workflows/release-desktop.yml, minus every
 * release authority):
 *   1. npm ci
 *   2. node scripts/build-sea.mjs            — npm build + Bun SEA sidecar
 *   3. hidden cutoff-worker smoke            — dist-bin/ashlr entrypoint check
 *   4. node desktop/scripts/prepare-sidecar.mjs
 *   5. tauri icon src-tauri/icons/icon.svg   — raster icons from icon.svg
 *   6. tauri build --debug --no-sign --bundles app -- --locked
 *   7. tar Phantom.app + sha256 + manifest   — into --out (default
 *      desktop/dist-nightly/)
 *
 * Contract (also written into manifest.json):
 *   - UNSIGNED dev build only: `--no-sign` is always passed and every signing
 *     variable in SIGNING_ENV_KEYS is scrubbed from the child environment.
 *   - No release: this script never tags, publishes, drafts or uploads
 *     anywhere. It only writes files under --out and, on GitHub Actions,
 *     appends artifact_* keys to $GITHUB_OUTPUT for the calling job's
 *     actions/upload-artifact step (retention-days: 7).
 *   - Reproducible: every tool is probed against desktop/toolchain.json pins;
 *     a drifted or missing tool fails the build before anything compiles.
 *   - macOS only: the Linux desktop target stays quarantined (glib 0.18.5,
 *     GHSA-wrw7-89jp-8q8g / RUSTSEC-2024-0429) and other hosts are not
 *     admitted. The target OS follows Tauri's own TAURI_ENV_PLATFORM signal
 *     and otherwise the host platform.
 *
 * Exit codes: 0 success, 1 refusal/failure, 2 usage error.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(SCRIPT_DIR, '..');
export const DESKTOP_DIR = join(REPO_ROOT, 'desktop');
export const TOOLCHAIN_PATH = join(DESKTOP_DIR, 'toolchain.json');
export const DEFAULT_OUT_DIR = join(DESKTOP_DIR, 'dist-nightly');

export const QUARANTINE_REF = 'glib 0.18.5 (GHSA-wrw7-89jp-8q8g / RUSTSEC-2024-0429)';

/** Signing variables scrubbed so the nightly artifact can never be signed. */
export const SIGNING_ENV_KEYS = Object.freeze([
  'APPLE_CERTIFICATE',
  'APPLE_CERTIFICATE_PASSWORD',
  'APPLE_SIGNING_IDENTITY',
  'APPLE_ID',
  'APPLE_PASSWORD',
  'APPLE_TEAM_ID',
  'APPLE_API_KEY',
  'APPLE_API_KEY_PATH',
  'APPLE_API_ISSUER',
  'APPLE_PROVIDER_SHORT_NAME',
  'WINDOWS_CERTIFICATE',
  'WINDOWS_CERTIFICATE_PASSWORD',
  'TAURI_WINDOWS_SIGN_PFX',
  'TAURI_WINDOWS_SIGN_PFX_PASSWORD',
  'TAURI_SIGNING_PRIVATE_KEY',
  'TAURI_SIGNING_PRIVATE_KEY_PASSWORD',
]);

/** Files the pipeline depends on; all must be tracked members of a checkout. */
export const REQUIRED_FILES = Object.freeze([
  'package.json',
  'package-lock.json',
  'scripts/build-sea.mjs',
  'desktop/package.json',
  'desktop/toolchain.json',
  'desktop/scripts/prepare-sidecar.mjs',
  'desktop/src-tauri/tauri.conf.json',
  'desktop/src-tauri/Cargo.toml',
  'desktop/src-tauri/Cargo.lock',
  'desktop/src-tauri/icons/icon.svg',
]);

const READ_ONLY_MODES = Object.freeze(['--check']);
const STEP_TIMEOUT_MS = Object.freeze({
  install: 15 * 60_000,
  'sidecar-build': 30 * 60_000,
  'sidecar-smoke': 60_000,
  'sidecar-stage': 60_000,
  icons: 60_000,
  bundle: 60 * 60_000,
  package: 10 * 60_000,
});

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function loadToolchainPins(path = TOOLCHAIN_PATH) {
  const pins = readJson(path);
  for (const key of ['node', 'npm', 'bun', 'rust', 'tauriCli']) {
    if (typeof pins[key] !== 'string' || !/^\d+\.\d+\.\d+$/.test(pins[key])) {
      throw new Error(`desktop/toolchain.json pin ${key} must be an exact x.y.z version`);
    }
  }
  return pins;
}

/**
 * Target OS follows Tauri's own cross-build signal: TAURI_ENV_PLATFORM wins,
 * otherwise the host platform. Only 'darwin' is admitted to the nightly lane.
 */
export function resolveDesktopNightlyTarget(env = process.env, platform = process.platform) {
  const raw = env.TAURI_ENV_PLATFORM || platform;
  if (raw === 'linux') {
    return { raw, admitted: false, reason: 'linux-quarantined' };
  }
  if (raw !== 'darwin') {
    return { raw, admitted: false, reason: 'unsupported-target' };
  }
  return { raw: 'darwin', os: 'macos', admitted: true, reason: null };
}

export function extractVersion(text) {
  return text?.match(/\d+\.\d+\.\d+/)?.[0] ?? null;
}

/** Tool probes keyed to toolchain.json pins. rustc and cargo share the rust pin. */
export function toolProbes(pins) {
  return [
    { tool: 'node', expected: pins.node, command: ['node', ['--version']] },
    { tool: 'npm', expected: pins.npm, command: ['npm', ['--version']] },
    { tool: 'bun', expected: pins.bun, command: ['bun', ['--version']] },
    { tool: 'rustc', expected: pins.rust, command: ['rustc', ['--version']] },
    { tool: 'cargo', expected: pins.rust, command: ['cargo', ['--version']] },
    { tool: 'tauri', expected: pins.tauriCli, command: ['tauri', ['--version']] },
  ];
}

export function probeTools(pins, env = process.env) {
  return toolProbes(pins).map((probe) => {
    let actual = null;
    const [file, args] = probe.command;
    const result = spawnSync(file, args, { encoding: 'utf8', env, timeout: 15_000 });
    if (!result.error && result.status === 0) {
      actual = extractVersion(`${result.stdout}${result.stderr}`);
    }
    return { tool: probe.tool, expected: probe.expected, actual, ok: actual === probe.expected };
  });
}

/**
 * Ordered build steps as data. `command` steps spawn file+args from `cwd`;
 * 'sidecar-smoke' and 'package' run in-process. Build mode executes exactly
 * this list, so --check reports the real pipeline.
 */
export function buildStepPlan() {
  return [
    { name: 'install', cwd: REPO_ROOT, command: ['npm', ['ci']], timeoutMs: STEP_TIMEOUT_MS.install },
    { name: 'sidecar-build', cwd: REPO_ROOT, command: [process.execPath, ['scripts/build-sea.mjs']], timeoutMs: STEP_TIMEOUT_MS['sidecar-build'] },
    { name: 'sidecar-smoke', cwd: REPO_ROOT, inProcess: true, timeoutMs: STEP_TIMEOUT_MS['sidecar-smoke'] },
    { name: 'sidecar-stage', cwd: REPO_ROOT, command: [process.execPath, ['desktop/scripts/prepare-sidecar.mjs']], timeoutMs: STEP_TIMEOUT_MS['sidecar-stage'] },
    { name: 'icons', cwd: DESKTOP_DIR, command: ['tauri', ['icon', 'src-tauri/icons/icon.svg']], timeoutMs: STEP_TIMEOUT_MS.icons },
    {
      name: 'bundle',
      cwd: DESKTOP_DIR,
      command: ['tauri', ['build', '--debug', '--no-sign', '--bundles', 'app', '--', '--locked']],
      env: { CI: '1' },
      timeoutMs: STEP_TIMEOUT_MS.bundle,
    },
    { name: 'package', cwd: REPO_ROOT, inProcess: true, timeoutMs: STEP_TIMEOUT_MS.package },
  ];
}

export function sidecarTriple(env = process.env) {
  const result = spawnSync('rustc', ['-vV'], { encoding: 'utf8', env, timeout: 15_000 });
  const triple = result.status === 0 ? result.stdout.match(/^host:\s+(\S+)/m)?.[1] : null;
  if (!triple) throw new Error('could not resolve host triple from rustc -vV');
  return triple;
}

export function nightlyArtifactName({ version, triple, profile = 'debug' }) {
  const arch = triple.split('-')[0];
  if (!version || !arch) throw new Error('version and triple are required for the artifact name');
  return `Phantom_${version}_${arch}-nightly-${profile}.app.tar.gz`;
}

export function scrubSigningEnv(env = process.env) {
  const scrubbed = SIGNING_ENV_KEYS.filter((key) => env[key] !== undefined);
  const clean = { ...env };
  for (const key of scrubbed) delete clean[key];
  return { env: clean, scrubbed };
}

export function desktopVersion() {
  const version = readJson(join(DESKTOP_DIR, 'src-tauri', 'tauri.conf.json'))?.version;
  if (typeof version !== 'string' || !version) throw new Error('desktop/src-tauri/tauri.conf.json has no version');
  return version;
}

export function preflight({ env = process.env, platform = process.platform, outDir = DEFAULT_OUT_DIR } = {}) {
  let pins = null;
  let pinsError = null;
  try {
    pins = loadToolchainPins();
  } catch (error) {
    pinsError = error.message;
  }
  const target = resolveDesktopNightlyTarget(env, platform);
  const missingFiles = REQUIRED_FILES.filter((rel) => !existsSync(join(REPO_ROOT, rel)));
  const toolchain = pins ? probeTools(pins, env) : [];
  const version = missingFiles.includes('desktop/src-tauri/tauri.conf.json') ? null : desktopVersion();
  let triple = null;
  try {
    triple = sidecarTriple(env);
  } catch { /* reported through the toolchain probe rows */ }
  const plan = {
    outDir,
    version,
    triple,
    profile: 'debug',
    artifactName: version && triple ? nightlyArtifactName({ version, triple, profile: 'debug' }) : null,
    steps: buildStepPlan().map((step) => {
      const entry = { ...step };
      delete entry.timeoutMs;
      return entry;
    }),
  };
  const ok = !pinsError && target.admitted && missingFiles.length === 0 && toolchain.every((row) => row.ok);
  return { ok, target, host: platform, pinsError, toolchain, missingFiles, plan };
}

function refusalText(report) {
  if (!report.target.admitted && report.target.reason === 'linux-quarantined') {
    return `ASHLR_DESKTOP_NIGHTLY_ADMISSION_REFUSED: refusing Linux desktop build while Tauri v2 resolves vulnerable ${QUARANTINE_REF}`;
  }
  if (!report.target.admitted) {
    return `ASHLR_DESKTOP_NIGHTLY_ADMISSION_REFUSED: target '${report.target.raw}' is not admitted; the nightly dev build is macOS-only`;
  }
  const problems = [];
  if (report.pinsError) problems.push(`desktop/toolchain.json: ${report.pinsError}`);
  for (const row of report.toolchain.filter((t) => !t.ok)) {
    problems.push(`tool ${row.tool} is ${row.actual ?? 'missing'} but desktop/toolchain.json pins ${row.expected}`);
  }
  for (const file of report.missingFiles) problems.push(`missing required file ${file}`);
  return `ASHLR_DESKTOP_NIGHTLY_PREFLIGHT_FAILED: ${problems.join('; ') || 'unknown preflight failure'}`;
}

function runStep(step, env) {
  const started = Date.now();
  if (step.inProcess && step.name === 'sidecar-smoke') {
    const bin = join(REPO_ROOT, 'dist-bin', 'ashlr');
    for (const flag of ['--_cutoff-checkpoint-supervisor', '--_cutoff-checkpoint-worker']) {
      const r = spawnSync(bin, [flag, 'invalid', 'invalid'], { encoding: 'utf8', env, timeout: step.timeoutMs });
      if (r.status !== 1 || r.stdout !== '' || r.stderr !== '') {
        throw new Error(`${flag} hidden entrypoint failed closed incorrectly`);
      }
    }
    return { name: step.name, seconds: (Date.now() - started) / 1000 };
  }
  if (!step.command) throw new Error(`step ${step.name} is not executable here`);
  const [file, args] = step.command;
  const result = spawnSync(file, args, {
    cwd: step.cwd,
    env: { ...env, ...(step.env ?? {}) },
    stdio: 'inherit',
    timeout: step.timeoutMs,
  });
  if (result.error) throw new Error(`step ${step.name} failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`step ${step.name} exited ${result.status}`);
  return { name: step.name, seconds: (Date.now() - started) / 1000 };
}

/** Files a previous nightly run may have left in the out dir; anything else refuses cleanup. */
const REUSABLE_OUT_NAMES = /^Phantom_.+-nightly-(?:debug|release)\.app\.tar\.gz(?:\.sha256)?$/;
const STALE_TMP_TAR = /^\.Phantom_.+\.app\.tar\.gz\.tmp\.tar$/;

export function packageArtifact({ outDir, version, triple, env }) {
  const profile = 'debug';
  const bundleDir = join(DESKTOP_DIR, 'src-tauri', 'target', profile, 'bundle', 'macos');
  const appPath = join(bundleDir, 'Phantom.app');
  if (!statSync(appPath, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`expected app bundle missing: ${appPath}`);
  }
  // Never rm a directory wholesale: --out may point anywhere. Only a missing
  // dir, an empty dir, or previous nightly output gets reused.
  if (existsSync(outDir)) {
    for (const entry of readdirSync(outDir)) {
      if (entry === 'manifest.json' || REUSABLE_OUT_NAMES.test(entry) || STALE_TMP_TAR.test(entry)) {
        rmSync(join(outDir, entry), { recursive: true, force: true });
      } else {
        throw new Error(`refusing to reuse non-empty artifact dir ${outDir}: unexpected entry ${entry}`);
      }
    }
  } else {
    mkdirSync(outDir, { recursive: true });
  }
  const name = nightlyArtifactName({ version, triple, profile });
  const artifact = join(outDir, name);
  // tar -czf embeds the compression time in the gzip header, which makes every
  // run produce different bytes for identical input. Write an uncompressed tar
  // and gzip -n it (zeroed header) so the artifact hash is stable for a given
  // bundle — the manifest's sha256 then means something.
  const tmpTar = join(outDir, `.${name}.tmp.tar`);
  try {
    const tar = spawnSync('tar', ['-cf', tmpTar, '-C', bundleDir, 'Phantom.app'], {
      encoding: 'utf8', env, timeout: STEP_TIMEOUT_MS.package,
    });
    if (tar.error || tar.status !== 0) {
      throw new Error(`tar failed: ${tar.error?.message ?? ''}${tar.stderr ?? ''}`);
    }
    const gzip = spawnSync('gzip', ['-n', '-f', tmpTar], {
      encoding: 'utf8', env, timeout: STEP_TIMEOUT_MS.package,
    });
    if (gzip.error || gzip.status !== 0) {
      throw new Error(`gzip failed: ${gzip.error?.message ?? ''}${gzip.stderr ?? ''}`);
    }
  } catch (error) {
    rmSync(tmpTar, { force: true });
    throw error;
  }
  renameSync(`${tmpTar}.gz`, artifact);
  const bytes = statSync(artifact).size;
  const sha256 = createHash('sha256').update(readFileSync(artifact)).digest('hex');
  writeFileSync(`${artifact}.sha256`, `${sha256}  ${name}\n`, { mode: 0o644 });
  return { name, path: artifact, bytes, sha256 };
}

export function createManifest({ version, triple, profile, toolchain, scrubbed, artifact, steps, env }) {
  return {
    schemaVersion: 1,
    kind: 'phantom-desktop-nightly',
    createdAt: new Date().toISOString(),
    source: {
      repository: env.GITHUB_REPOSITORY ?? 'ashlrai/phantom',
      commit: env.GITHUB_SHA ?? null,
      ref: env.GITHUB_REF ?? null,
      runId: env.GITHUB_RUN_ID ?? null,
      runAttempt: env.GITHUB_RUN_ATTEMPT ?? null,
    },
    version,
    target: { os: 'macos', triple, profile },
    toolchain: Object.fromEntries(toolchain.map((t) => [t.tool, t.actual])),
    unsigned: true,
    releaseArtifact: false,
    scrubbedSigningEnv: scrubbed,
    retentionDays: 7,
    artifacts: [
      { file: artifact.name, kind: 'app-tarball', bytes: artifact.bytes, sha256: artifact.sha256 },
      { file: `${artifact.name}.sha256`, kind: 'sha256-sidecar' },
    ],
    steps,
  };
}

function githubOutputs({ artifact, manifestPath, outDir }) {
  if (!process.env.GITHUB_OUTPUT) return;
  appendFileSync(process.env.GITHUB_OUTPUT, [
    `artifact_name=${artifact.name}`,
    `artifact_dir=${outDir}`,
    `artifact_file=${artifact.path}`,
    `artifact_sha256=${artifact.sha256}`,
    `manifest_path=${manifestPath}`,
    '',
  ].join('\n'));
}

function usage() {
  console.log(`Usage: node scripts/build-desktop-nightly.mjs [--check] [--out <dir>]

Reproducible unsigned Phantom desktop dev build for the scheduled master CI run.

  --check      preflight only: print the admission report and step plan as JSON
  --out <dir>  artifact output directory (default: desktop/dist-nightly/)
  -h, --help   this help

The pipeline installs dependencies, builds the Bun SEA sidecar, stages it for
Tauri, builds an unsigned --debug Phantom.app and packs it as
Phantom_<version>_<arch>-nightly-debug.app.tar.gz with a sha256 sidecar and a
provenance manifest. It never signs, tags, publishes or creates a release.`);
}

function parseArgs(argv) {
  const args = { check: false, outDir: DEFAULT_OUT_DIR };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '-h' || arg === '--help') return { help: true };
    if (READ_ONLY_MODES.includes(arg)) { args.check = true; continue; }
    if (arg === '--out') {
      if (!argv[i + 1]) throw Object.assign(new Error('--out requires a directory'), { usage: true });
      args.outDir = resolve(argv[++i]);
      continue;
    }
    throw Object.assign(new Error(`unknown argument: ${arg}`), { usage: true });
  }
  return args;
}

async function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    usage();
    process.exit(2);
  }
  if (args.help) { usage(); return; }

  const report = preflight({ outDir: args.outDir });
  if (args.check) {
    if (!report.ok) console.error(refusalText(report));
    process.stdout.write(`${JSON.stringify({ schemaVersion: 1, mode: 'check', ...report }, null, 2)}\n`);
    process.exit(report.ok ? 0 : 1);
  }
  if (!report.ok) {
    console.error(refusalText(report));
    process.exit(1);
  }

  const { env, scrubbed } = scrubSigningEnv();
  if (scrubbed.length) {
    console.log(`[desktop-nightly] unsigned build: scrubbed signing env: ${scrubbed.join(', ')}`);
  }
  let triple;
  let version;
  try {
    triple = sidecarTriple(env);
    version = desktopVersion();
  } catch (error) {
    console.error(`[desktop-nightly] ${error.message}`);
    process.exit(1);
  }
  const records = [];
  for (const step of buildStepPlan()) {
    if (step.name === 'package') continue;
    console.log(`[desktop-nightly] step ${step.name} …`);
    try {
      records.push(runStep(step, env));
    } catch (error) {
      console.error(`[desktop-nightly] ${error.message}`);
      process.exit(1);
    }
    console.log(`[desktop-nightly] step ${step.name} ok (${records.at(-1).seconds.toFixed(1)}s)`);
  }

  console.log('[desktop-nightly] step package …');
  try {
    const artifact = packageArtifact({ outDir: args.outDir, version, triple, env });
    const manifest = createManifest({
      version, triple, profile: 'debug', toolchain: report.toolchain,
      scrubbed, artifact, steps: records, env,
    });
    const manifestPath = join(args.outDir, 'manifest.json');
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o644 });
    githubOutputs({ artifact, manifestPath, outDir: args.outDir });
    console.log(`[desktop-nightly] artifact: ${artifact.path}`);
    console.log(`[desktop-nightly] sha256:   ${artifact.sha256}`);
    console.log(`[desktop-nightly] manifest: ${manifestPath}`);
  } catch (error) {
    console.error(`[desktop-nightly] ${error.message}`);
    process.exit(1);
  }
}

const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : '';
if (import.meta.url === invokedPath) {
  await main();
}
