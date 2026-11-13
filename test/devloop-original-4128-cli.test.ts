/**
 * RQ-SWE4-DEVLOOP-1 (#4128) CLI-slice preservation: `phm check` resolves
 * <cwd>/scripts/gate.mjs, spawns it as `node scripts/gate.mjs --check ...rest`
 * with inherited stdio, and returns the child's real exit status. The gate
 * parser's own --check coverage lives in test/gate.test.ts (CODEOWNERS
 * protected, unchanged here); this file adds the missing end-to-end CLI
 * evidence through the real src/cli/index.ts entrypoint against a tiny fake
 * gate child that records its argv. No real gate, compiler, build, fleet or
 * HOME state is touched — every run gets a temporary HOME/ASHLR_HOME and a
 * temporary checkout root.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const TSX_LOADER = resolve('node_modules/tsx/dist/loader.mjs');
const CLI_ENTRY = resolve('src/cli/index.ts');

const tempDirs: string[] = [];

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'devloop-4128-')));
  tempDirs.push(dir);
  return dir;
}

// The fake gate child: records the argv it was spawned with, then either
// prints a synthetic --check JSON result, exits nonzero, or kills only
// itself so the CLI observes a null child status.
const FAKE_GATE = `import { writeFileSync } from 'node:fs';
const argv = process.argv.slice(2);
if (process.env.FAKE_GATE_ARGV_LOG) writeFileSync(process.env.FAKE_GATE_ARGV_LOG, JSON.stringify(argv));
const mode = process.env.FAKE_GATE_MODE ?? 'ok';
if (mode === 'signal') process.kill(process.pid, 'SIGTERM');
if (mode === 'fail') { console.error('fake gate: forced failure'); process.exit(7); }
console.log(JSON.stringify({ ok: true, mode: 'check', echoedArgv: argv }));
`;

// A temporary checkout root: only the file `phm check` looks up exists.
function makeCheckout(withGate = true): string {
  const root = makeTempDir();
  if (withGate) {
    mkdirSync(join(root, 'scripts'), { recursive: true });
    writeFileSync(join(root, 'scripts', 'gate.mjs'), FAKE_GATE);
  }
  return root;
}

function runCheck(args: string[], options: { cwd: string; home: string; env?: NodeJS.ProcessEnv }) {
  return spawnSync(process.execPath, ['--import', TSX_LOADER, CLI_ENTRY, 'check', ...args], {
    cwd: options.cwd,
    env: {
      ...process.env,
      HOME: options.home,
      USERPROFILE: options.home,
      ASHLR_HOME: join(options.home, '.ashlr'),
      ASHLR_LOCUS_FIRM: '0',
      NO_COLOR: '1',
      ...options.env,
    },
    encoding: 'utf8',
    timeout: 60_000,
  });
}

describe('phm check CLI slice (original #4128)', () => {
  it('forwards the exact --check prefix and --base/--json args, returning the child JSON and exit 0', () => {
    const checkout = makeCheckout();
    const home = makeTempDir();
    const argvLog = join(home, 'gate-argv.json');
    const result = runCheck(['--base', 'origin/main', '--json'], {
      cwd: checkout,
      home,
      env: { FAKE_GATE_ARGV_LOG: argvLog },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(argvLog, 'utf8'))).toEqual([
      '--check',
      '--base',
      'origin/main',
      '--json',
    ]);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ok: true,
      mode: 'check',
      echoedArgv: ['--check', '--base', 'origin/main', '--json'],
    });
  }, 60_000);

  it('forwards a --base=<ref> spelling and unrelated args verbatim', () => {
    const checkout = makeCheckout();
    const home = makeTempDir();
    const argvLog = join(home, 'gate-argv.json');
    const result = runCheck(['--base=HEAD~2', '--verbose'], {
      cwd: checkout,
      home,
      env: { FAKE_GATE_ARGV_LOG: argvLog },
    });
    expect(result.status, result.stderr).toBe(0);
    expect(JSON.parse(readFileSync(argvLog, 'utf8'))).toEqual([
      '--check',
      '--base=HEAD~2',
      '--verbose',
    ]);
  }, 60_000);

  it('propagates a nonzero child exit status', () => {
    const checkout = makeCheckout();
    const home = makeTempDir();
    const result = runCheck([], {
      cwd: checkout,
      home,
      env: { FAKE_GATE_MODE: 'fail' },
    });
    expect(result.status).toBe(7);
    expect(result.stderr).toContain('fake gate: forced failure');
  }, 60_000);

  it('exits 2 with a root diagnostic when scripts/gate.mjs is missing', () => {
    const emptyRoot = makeTempDir();
    const result = runCheck(['--json'], { cwd: emptyRoot, home: makeTempDir() });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('phm check: run from the Phantom repository root');
    expect(result.stderr).toContain('scripts/gate.mjs missing');
  }, 60_000);

  it('check --help prints usage with exit 0 without running the child, even outside a checkout', () => {
    const outside = makeTempDir();
    const help = runCheck(['--help'], { cwd: outside, home: makeTempDir() });
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain('phm check');
    expect(help.stdout).toContain('--base <ref>');

    const checkout = makeCheckout();
    const home = makeTempDir();
    const argvLog = join(home, 'gate-argv.json');
    const inside = runCheck(['--help'], {
      cwd: checkout,
      home,
      env: { FAKE_GATE_ARGV_LOG: argvLog },
    });
    expect(inside.status, inside.stderr).toBe(0);
    expect(inside.stdout).toContain('phm check');
    expect(existsSync(argvLog)).toBe(false);
  }, 60_000);

  it('falls back to exit 1 when the child ends without a status (killed by a signal)', () => {
    const checkout = makeCheckout();
    const home = makeTempDir();
    // The fake gate kills only its own process; the CLI must observe
    // result.status === null and map it to failure, never to success.
    const result = runCheck([], {
      cwd: checkout,
      home,
      env: { FAKE_GATE_MODE: 'signal' },
    });
    expect(result.status).toBe(1);
  }, 60_000);
});
