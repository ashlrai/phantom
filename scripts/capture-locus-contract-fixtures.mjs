#!/usr/bin/env node
// Capture real `locus` CLI output for test/locus-producer-contract.test.ts.
//
//   node scripts/capture-locus-contract-fixtures.mjs --locus-bin /abs/path/to/locus \
//     --locus-src /abs/path/to/locus/checkout --source-commit <locus git sha> \
//     [--out test/fixtures/locus-contract/<version>] [--timeout-seconds 30]
//
// The binary must be built from --source-commit; the published schemas are
// copied from that commit of --locus-src. Per-run values (timestamps, session
// ids, seals, worker dirs) and countdown sign classes are normalized. This
// stabilizes those fields; other producer/environment changes remain visible.
// Binary/source correspondence is caller-supplied, not attested by this tool.
//
// Every scenario runs in a throwaway LOCUS_HOME and cwd with a scrubbed
// environment without inherited provider credentials. These local CLI probes
// are not OS network-isolated; the restricted PATH does not prove Phantom absent. The
// sandbox path is replaced by <LOCUS_HOME> and the run aborts if the control
// capability value appears anywhere in captured output.
import { spawn } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

const locusBin = arg('--locus-bin');
const locusSrc = arg('--locus-src');
const sourceCommit = arg('--source-commit');
if (!locusBin || !isAbsolute(locusBin) || !locusSrc || !isAbsolute(locusSrc) || !/^[0-9a-f]{40}$/u.test(sourceCommit ?? '')) {
  console.error('usage: --locus-bin <absolute path> --locus-src <absolute checkout> --source-commit <40-hex sha> [--out <dir>]');
  process.exit(2);
}
const SCHEMAS = ['agent-report.schema.json', 'doctor.schema.json'];
const VOLATILE_KEYS = ['expires_at', 'ts', 'session_id', 'seal', 'worker_home'];
const timeoutSeconds = Number(arg('--timeout-seconds') ?? '30');
if (!Number.isInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 600) throw new Error('--timeout-seconds must be 1-600');

// Preserve expired/readiness booleans and the numeric sign category. The
// normalized countdown is not an actual time-to-expiry measurement.
function normalizeJson(value) {
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => {
    if (VOLATILE_KEYS.includes(key) && typeof item === 'string') return [key, `<${key.toUpperCase()}>`];
    if (key === 'expires_in_secs' && typeof item === 'number') {
      if (!Number.isSafeInteger(item)) throw new Error('expires_in_secs must be a safe integer or null');
      return [key, item > 0 ? 1 : item < 0 ? -1 : 0];
    }
    return [key, normalizeJson(item)];
  }));
}

const PROBES = [
  ['agent-report.json', ['agent', 'report', '--json']],
  ['status-oneline.txt', ['status', '--oneline']],
  ['verify-session.json', ['verify', 'session', '--json']],
  ['watch-once.json', ['watch', '--once', '--json']],
];

const SCENARIOS = [
  { name: 'fresh-home', setup: [] },
  { name: 'pinned-capability-not-exported', setup: [['quickstart']] },
  { name: 'pinned-capability-exported', setup: [['quickstart']], exportCapability: true },
];

const root = realpathSync(mkdtempSync(join(tmpdir(), 'locus-contract-')));
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const boundedRunner = join(repoRoot, 'scripts', 'run-bounded-command.mjs');
const baseEnv = { PATH: '/usr/bin:/bin', LANG: 'C', NO_COLOR: '1' };
let probeNumber = 0;

// Reuse the existing deadline/process-group owner unchanged. Only the wrapper
// child receives the scratch environment; the capture process keeps its own.
async function run(command, args, cwd, env) {
  const prefix = join(root, `probe-${probeNumber++}`);
  const stdout = openSync(`${prefix}.out`, 'w', 0o600);
  const stderr = openSync(`${prefix}.err`, 'w', 0o600);
  let child;
  try {
    child = spawn(process.execPath, [boundedRunner, '--signal=TERM', '--kill-after=5s', `${timeoutSeconds}s`, command, ...args],
      { cwd, env, stdio: ['ignore', stdout, stderr] });
    const code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done); });
    if (code !== 0) throw new Error(`capture command failed (${code === 124 ? 'deadline exceeded' : `exit ${code}`}): ${command}`);
    return readFileSync(`${prefix}.out`, 'utf8');
  } finally {
    closeSync(stdout); closeSync(stderr);
  }
}

try {
  const metadataHome = join(root, 'metadata', 'home');
  const metadataCwd = join(root, 'metadata', 'cwd');
  mkdirSync(metadataHome, { recursive: true }); mkdirSync(metadataCwd, { recursive: true });
  const metadataEnv = { ...baseEnv, HOME: metadataHome, LOCUS_HOME: metadataHome };
  const versionOut = (await run(locusBin, ['--version'], metadataCwd, metadataEnv)).trim();
  // The version becomes a default output-path segment; reject paths and malformed releases.
  const version = versionOut.match(/^locus\s+((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/u)?.[1];
  if (!version) throw new Error(`unexpected locus --version output: ${versionOut}`);
  const out = resolve(arg('--out') ?? join(repoRoot, 'test', 'fixtures', 'locus-contract', version));
  mkdirSync(out, { recursive: true });
  const manifest = { producer: 'locus', version, sourceCommit, binarySourceProvenance: 'caller-supplied-not-attested',
    normalizedKeys: [...VOLATILE_KEYS, 'expires_in_secs'], countdownNormalization: 'positive=1; zero=0; negative=-1; null unchanged; readiness/expired unchanged', scenarios: {} };
  for (const schema of SCHEMAS) {
    const text = await run('/usr/bin/git', ['-C', locusSrc, 'show', `${sourceCommit}:schema/${schema}`], metadataCwd, metadataEnv);
    writeFileSync(join(out, schema), text);
  }
  writeFileSync(join(out, 'version.txt'), `${versionOut}\n`);
  writeFileSync(join(out, 'help.txt'), await run(locusBin, ['--help'], metadataCwd, metadataEnv));

  for (const scenario of SCENARIOS) {
    const home = join(root, scenario.name, 'home');
    const cwd = join(root, scenario.name, 'cwd');
    mkdirSync(home, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    const env = { ...baseEnv, HOME: home, LOCUS_HOME: home };
    if (scenario.exportCapability) env.LOCUS_EXPORT_CAPABILITY = '1';
    const dir = join(out, scenario.name);
    const raw = join(root, scenario.name, 'raw');
    mkdirSync(dir, { recursive: true });
    mkdirSync(raw, { recursive: true });
    // One /bin/sh per scenario, the way a human runs Locus: the shell is the
    // session supervisor for setup and every probe. When Node is the direct
    // parent, Locus 0.5.0's broker startup times out and the pin is refused;
    // when the supervisor exits before the probes, the pin seal reads invalid.
    const script = [
      'set -u',
      ...scenario.setup.map((step, i) => `"$LOCUS_BIN" ${step.join(' ')} >/dev/null 2>&1; echo $? > "$RAW/setup.${i}"`),
      'if [ "${LOCUS_EXPORT_CAPABILITY:-}" = 1 ]; then LOCUS_CONTROL_CAPABILITY="$(cat "$LOCUS_HOME/control_capability")"; export LOCUS_CONTROL_CAPABILITY; fi',
      ...PROBES.map(([file, args]) => `"$LOCUS_BIN" ${args.join(' ')} > "$RAW/${file}" 2>/dev/null </dev/null; echo $? > "$RAW/${file}.exit"`),
    ].join('\n');
    await run('/bin/sh', ['-c', script], cwd, { ...env, LOCUS_BIN: locusBin, RAW: raw });
    const setupExits = scenario.setup.map((_, i) => Number(readFileSync(join(raw, `setup.${i}`), 'utf8')));
    // quickstart exits 1 (protected) when doctor warns, e.g. Phantom absent.
    if (setupExits.some(code => code !== 0 && code !== 1)) throw new Error(`${scenario.name}: setup exits ${setupExits}`);
    let capability = null;
    try { capability = readFileSync(join(home, 'control_capability'), 'utf8').trim(); } catch { /* none */ }
    const exits = {};
    for (const [file] of PROBES) {
      const original = readFileSync(join(raw, file), 'utf8');
      if (capability && original.includes(capability)) throw new Error(`${scenario.name}: capability value leaked into ${file}`);
      const replaced = original.split(home).join('<LOCUS_HOME>').split(cwd).join('<CWD>');
      const text = file === 'watch-once.json'
        ? replaced.trim().split(/\r?\n/u).map(line => JSON.stringify(normalizeJson(JSON.parse(line)))).join('\n') + '\n'
        : file.endsWith('.json') ? JSON.stringify(normalizeJson(JSON.parse(replaced)), null, 2) + '\n' : replaced;
      if (capability && text.includes(capability)) throw new Error(`${scenario.name}: capability value leaked into ${file}`);
      if (text.includes(root)) throw new Error(`${scenario.name}: sandbox path left in ${file}`);
      writeFileSync(join(dir, file), text);
      exits[file] = Number(readFileSync(join(raw, `${file}.exit`), 'utf8'));
    }
    manifest.scenarios[scenario.name] = { setup: scenario.setup.map(s => `locus ${s.join(' ')}`), setupExits, capabilityExported: Boolean(scenario.exportCapability), exits };
  }
  writeFileSync(join(out, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`wrote ${out}`);
} finally {
  rmSync(root, { recursive: true, force: true });
}
