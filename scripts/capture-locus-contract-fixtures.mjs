#!/usr/bin/env node
// Capture real `locus` CLI output for test/locus-producer-contract.test.ts.
//
//   node scripts/capture-locus-contract-fixtures.mjs --locus-bin /abs/path/to/locus \
//     --source-commit <locus git sha> [--out test/fixtures/locus-contract/0.5.0]
//
// Every scenario runs in a throwaway LOCUS_HOME and cwd with a scrubbed
// environment: no provider credentials, no network, no Phantom on PATH. The
// sandbox path is replaced by <LOCUS_HOME> and the run aborts if the control
// capability value appears anywhere in captured output.
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

function arg(name) {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

const locusBin = arg('--locus-bin');
const sourceCommit = arg('--source-commit');
if (!locusBin || !isAbsolute(locusBin) || !/^[0-9a-f]{40}$/u.test(sourceCommit ?? '')) {
  console.error('usage: --locus-bin <absolute path> --source-commit <40-hex sha> [--out <dir>]');
  process.exit(2);
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
const versionOut = spawnSync(locusBin, ['--version'], { encoding: 'utf8' }).stdout.trim();
const version = versionOut.match(/^locus\s+(\S+)$/u)?.[1];
if (!version) throw new Error(`unexpected locus --version output: ${versionOut}`);
const out = resolve(arg('--out') ?? join('test', 'fixtures', 'locus-contract', version));
mkdirSync(out, { recursive: true });

try {
  const manifest = { producer: 'locus', version, sourceCommit, capturedAt: new Date().toISOString().slice(0, 10), scenarios: {} };
  const baseEnv = { PATH: '/usr/bin:/bin', LANG: 'C', NO_COLOR: '1' };
  writeFileSync(join(out, 'version.txt'), `${versionOut}\n`);
  writeFileSync(join(out, 'help.txt'), spawnSync(locusBin, ['--help'], { encoding: 'utf8', env: baseEnv }).stdout);

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
    const run = spawnSync('/bin/sh', ['-c', script], { cwd, env: { ...env, LOCUS_BIN: locusBin, RAW: raw }, stdio: 'ignore' });
    if (run.status !== 0) throw new Error(`${scenario.name}: capture shell exited ${run.status}`);
    const setupExits = scenario.setup.map((_, i) => Number(readFileSync(join(raw, `setup.${i}`), 'utf8')));
    // quickstart exits 1 (protected) when doctor warns, e.g. Phantom absent.
    if (setupExits.some(code => code !== 0 && code !== 1)) throw new Error(`${scenario.name}: setup exits ${setupExits}`);
    let capability = null;
    try { capability = readFileSync(join(home, 'control_capability'), 'utf8').trim(); } catch { /* none */ }
    const exits = {};
    for (const [file] of PROBES) {
      const text = readFileSync(join(raw, file), 'utf8').split(home).join('<LOCUS_HOME>').split(cwd).join('<CWD>');
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
