/** Observe actual source-CLI module loading in fresh processes, without provider or service work. */
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { stripAnsi } from '../src/cli/ui.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixtures: string[] = [];
afterEach(() => { for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true }); });
function run(args: string[], mode: 'block' | 'dispatch' | 'throw' | 'import-failure' = 'dispatch') {
  const home = mkdtempSync(join(tmpdir(), 'phantom-cli-lazy-')); fixtures.push(home);
  const observer = join(home, 'observe.mjs');
  const selectedModule = args[0] === 'setup' ? 'setup.ts' : 'doctor-init.ts';
  // Synchronous loader hooks observe both the initial graph and later literal
  // imports. Fixture command handlers never access providers, stores or services.
  writeFileSync(observer, `import { registerHooks } from 'node:module';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from ${JSON.stringify(import.meta.resolve('typescript'))};
// Keep source imports and fresh-process execution, without tsx's native esbuild
// service. Resolve NodeNext .js specifiers to their source .ts siblings.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith('.js') && specifier.startsWith('.') && context.parentURL) {
      const source = new URL(specifier.slice(0, -3) + '.ts', context.parentURL);
      if (existsSync(source)) return nextResolve(source.href, context);
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
  const name = url.split('/').at(-1);
  if (name !== 'doctor-init.ts' && name !== 'setup.ts') {
    if (!url.endsWith('.ts')) return nextLoad(url, context);
    return { format: 'module', shortCircuit: true, source: ts.transpileModule(
      readFileSync(fileURLToPath(url), 'utf8'),
      { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } },
    ).outputText };
  }
  if (${JSON.stringify(mode)} === 'block') throw Error('Unrelated onboarding module loaded');
  if (name !== ${JSON.stringify(selectedModule)}) throw Error('Unselected onboarding module loaded');
  if (${JSON.stringify(mode)} === 'import-failure') throw Error('fixture import failure');
  const command = name === 'setup.ts' ? 'setup' : null;
  const body = ${JSON.stringify(mode)} === 'throw' ? "throw Error('fixture handler failure')" :
    "console.log(JSON.stringify({command: name, args})); return 17";
  const handler = name => 'export async function ' + name + '(args) {' +
    body.replace('command: name', 'command: ' + JSON.stringify(name)) + '}';
  return { format: 'module', shortCircuit: true, source: command ? handler('cmdSetup') : handler('cmdDoctor') + handler('cmdInit') };
}});`);
  return spawnSync(process.execPath, ['--import', observer, 'src/cli/index.ts', ...args], {
    cwd: root, encoding: 'utf8', timeout: 20_000,
    env: { ...process.env, HOME: home, USERPROFILE: home, ASHLR_HOME: join(home, '.ashlr'), NO_COLOR: '1', FORCE_COLOR: '0' },
  });
}

describe('CLI loads onboarding only for the selected command', () => {
  it('serves help without evaluating doctor or setup dependencies', () => {
    const result = run(['help'], 'block');
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
    expect(result.stderr).toBe(''); expect(result.stdout).toContain('Phantom');
  });
  it('retains the index command and its shared empty-repo guidance', () => {
    const result = run(['index'], 'block');
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
    expect(result.stdout).toContain('ashlr index');
    expect(result.stdout).toContain('No git repos are being tracked yet.');
    expect(result.stdout).toContain('phm config set roots --json');
  });
  it.each([['doctor', 'cmdDoctor'], ['init', 'cmdInit'], ['setup', 'cmdSetup']])(
    'preserves %s handler arguments and returned exit code', (command, handler) => {
      const result = run([command!, '--json', '--fixture']);
      expect(result.error).toBeUndefined(); expect(result.status).toBe(17); expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual({ command: handler, args: ['--json', '--fixture'] });
    });
  it.each(['doctor', 'init', 'setup'])('keeps %s import failures in the common CLI error path', command => {
    const result = run([command], 'import-failure');
    expect(result.error).toBeUndefined(); expect(result.status).toBe(1); expect(result.stdout).toBe('');
    expect(stripAnsi(result.stderr)).toBe('error: fixture import failure\n');
    expect(result.stderr).not.toContain('module not yet built');
  });
  it.each(['doctor', 'init', 'setup'])('keeps %s failures in the common CLI error path', command => {
    const result = run([command], 'throw');
    expect(result.error).toBeUndefined(); expect(result.status).toBe(1); expect(result.stdout).toBe('');
    expect(stripAnsi(result.stderr)).toBe('error: fixture handler failure\n');
    expect(result.stderr).not.toContain('module not yet built');
  });
});

/** Package fixture deliberately has no dist/: version cannot depend on the CLI. */
function launcherFixture() {
  const home = mkdtempSync(join(tmpdir(), 'phantom-cli-version-')); fixtures.push(home);
  const pkg = join(home, 'package with spaces # % λ');
  mkdirSync(join(pkg, 'bin'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({ type: 'module', version: '7.8.9' }));
  const launcher = join(pkg, 'bin', 'ashlr');
  copyFileSync(join(root, 'bin', 'ashlr'), launcher);
  const run = (args: string[], version = '', file = launcher) => spawnSync(process.execPath, [file, ...args], {
    cwd: home, encoding: 'utf8', timeout: 20_000,
    env: { ...process.env, HOME: home, USERPROFILE: home, ASHLR_HOME: join(home, '.ashlr'), ASHLR_VERSION: version },
  });
  return { pkg, launcher, run };
}

describe('installed version fast path', () => {
  it.each(['--version', '-v', 'version'])('answers %s without a built CLI or current-directory package', command => {
    const { run } = launcherFixture();
    const result = run([command]);
    expect(result.error).toBeUndefined(); expect(result.status).toBe(0);
    expect(result.stderr).toBe(''); expect(result.stdout).toBe('7.8.9\n');
  });
  it('preserves the nonempty binary version override', () => {
    const { run } = launcherFixture();
    const result = run(['--version'], '8.9.10-fixture');
    expect(result.status).toBe(0); expect(result.stderr).toBe('');
    expect(result.stdout).toBe('8.9.10-fixture\n');
  });
  it.each([['--_worker', '--version'], ['-v', '--_worker'], ['version', '--ignored']])(
    'preserves existing dispatcher normalization for %j', (...args) => {
      const { run } = launcherFixture();
      const result = run(args);
      expect(result.status).toBe(0); expect(result.stderr).toBe('');
      expect(result.stdout).toBe('7.8.9\n');
    });
  it('retains unknown when package metadata cannot be read', () => {
    const { pkg, launcher, run } = launcherFixture();
    // Explicit ESM suffix lets Node start even without a package.json.
    const esmLauncher = join(pkg, 'bin', 'ashlr.mjs');
    copyFileSync(launcher, esmLauncher);
    rmSync(join(pkg, 'package.json'));
    const result = run(['--version'], '', esmLauncher);
    expect(result.status).toBe(0); expect(result.stderr).toBe('');
    expect(result.stdout).toBe('unknown\n');
  });
  it('routes only the first effective command and preserves arguments and exit codes', () => {
    const { pkg, run } = launcherFixture();
    mkdirSync(join(pkg, 'dist', 'cli'), { recursive: true });
    writeFileSync(join(pkg, 'dist', 'cli', 'index.js'),
      'console.log(JSON.stringify(process.argv.slice(2))); process.exitCode = 17;');
    writeFileSync(join(pkg, 'dist', 'cli', 'status.js'),
      'export async function runStatus(args) { console.log(JSON.stringify(args)); process.exitCode = 19; }');
    for (const args of [['help', '--version'], ['--versioned'], ['--_worker', '--_worker', '--version']]) {
      const result = run(args);
      expect(result.status).toBe(17); expect(result.stderr).toBe('');
      expect(JSON.parse(result.stdout)).toEqual(args);
    }
    const result = run(['--_worker', 'status', '--json', '--version']);
    expect(result.status).toBe(19); expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual(['--json', '--version']);
  });
});
