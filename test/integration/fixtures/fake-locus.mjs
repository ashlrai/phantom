/**
 * Loaded with NODE_OPTIONS in the disposable CLI process and its Node children.
 * LOCUS_BIN points to Node: a child invoked as `agent report --json` becomes
 * this fake Locus before Node tries to load a main module. This works without
 * shell scripts, a native Locus installation, or platform-specific executables.
 * All other child-process calls execute normally; only their argv is observed.
 */
import childProcess from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename } from 'node:path';

const ledger = process.env.PHM_LOCUS_FIXTURE_ARGV;
const pinFile = process.env.PHM_LOCUS_FIXTURE_PIN;
if (!ledger || !pinFile) throw new Error('fake Locus requires private fixture paths');

function record(entry) {
  appendFileSync(ledger, JSON.stringify(entry) + '\n', { mode: 0o600 });
}

record({ kind: 'process', argv: process.argv, execArgv: process.execArgv, argv0: process.argv0 });
if (basename(process.argv[1] ?? '') === 'agent') {
  const args = ['agent', ...process.argv.slice(2)];
  record({ kind: 'locus', argv: args });
  if (JSON.stringify(args) !== JSON.stringify(['agent', 'report', '--json'])) {
    process.stderr.write('Unexpected fake Locus invocation\n');
    process.exit(2);
  }
  const pin = JSON.parse(readFileSync(pinFile, 'utf8'));
  // The private wire response deliberately contains a canary outside the
  // public report projection. It must never be echoed by the Phantom CLI.
  record({ kind: 'pin', credentialPresent: process.env.AWS_SECRET_ACCESS_KEY === pin.report.pin.credential });
  process.stdout.write(JSON.stringify(pin.report), () => process.exit(pin.exitCode));
} else {
  observeChildren();
}

// Observe every public child-process entry point, including string commands,
// before execution. Never record child envs or the private pin's contents.
function observeChildren() {
  for (const method of ['spawn', 'spawnSync', 'execFile', 'execFileSync', 'exec', 'execSync', 'fork']) {
    const original = childProcess[method];
    childProcess[method] = function (...args) {
      const options = args.find(arg => arg && typeof arg === 'object' && !Array.isArray(arg));
      record({ kind: method, argv: [String(args[0]), ...(Array.isArray(args[1]) ? args[1] : [])],
        execArgv: options?.execArgv, argv0: options?.argv0 });
      return Reflect.apply(original, this, args);
    };
  }
  syncBuiltinESMExports();
}
