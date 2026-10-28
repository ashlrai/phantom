/** Observe actual source-CLI module loading in fresh processes, without provider or service work. */
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { transformSync } from 'esbuild';
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
registerHooks({ load(url, context, nextLoad) {
  const name = url.split('/').at(-1);
  if (name !== 'doctor-init.ts' && name !== 'setup.ts') return nextLoad(url, context);
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
  return spawnSync(process.execPath, ['--import', 'tsx', '--import', observer, 'src/cli/index.ts', ...args], {
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

// Transpile the real metadata graph without bundling or a TS runtime loader.
// This preserves Node's production module loading costs and works before a build.
function metadataFixture(): string {
  const fixture = mkdtempSync(join(tmpdir(), 'phantom-cli-timing-'));
  fixtures.push(fixture);
  writeFileSync(join(fixture, 'package.json'), readFileSync(join(root, 'package.json')));
  mkdirSync(join(fixture, 'bin'));
  writeFileSync(join(fixture, 'bin/ashlr'), readFileSync(join(root, 'bin/ashlr')));
  const seen = new Set<string>();
  function emit(relative: string): void {
    if (seen.has(relative)) return;
    seen.add(relative);
    const source = readFileSync(join(root, 'src', relative.replace(/\.js$/, '.ts')), 'utf8');
    const { code } = transformSync(source, { loader: 'ts', format: 'esm', target: 'es2022' });
    const output = join(fixture, 'dist', relative);
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, code);
    for (const match of code.matchAll(/^import\s+.*?from\s+['"](\.[^'"]+)['"]/gm)) {
      emit(join(dirname(relative), match[1]!));
    }
  }
  emit('cli/index.js');
  emit('cli/help.js');
  return fixture;
}

describe('CLI cold start', () => {
  it.each([['--version'], ['-v'], ['version'], ['--help'], ['-h'], ['help'], []].map(args => ({ args })))(
    'keeps metadata invocation %j free of config and command implementation graphs', ({ args }) => {
      const home = mkdtempSync(join(tmpdir(), 'phantom-cli-metadata-'));
      fixtures.push(home);
      const observer = join(home, 'metadata.mjs');
      writeFileSync(observer, `import { registerHooks } from 'node:module';
registerHooks({ load(url, context, nextLoad) {
  if (url.endsWith('/claude-broker-tool-invocation.ts')) throw Error('Metadata loaded broker worker dependencies');
  if (/\\/(?:core\\/(?:config|index-engine|tidy)|cli\\/(?:status|open|picker|doctor-init|setup))\\.ts$/.test(url)) {
    throw Error('Metadata loaded an unrelated module: ' + url);
  }
  return nextLoad(url, context);
}});`);
      const result = spawnSync(process.execPath, ['--import', 'tsx', '--import', observer, 'src/cli/index.ts', ...args], {
        cwd: root, encoding: 'utf8', timeout: 20_000,
        env: { ...process.env, HOME: home, USERPROFILE: home, ASHLR_HOME: join(home, '.ashlr'), NO_COLOR: '1' },
      });
      expect(result.error).toBeUndefined();
      expect(result.status, result.stderr).toBe(0);
      expect(result.stderr).toBe('');
      if (['--version', '-v', 'version'].includes(args[0] ?? '')) {
        expect(result.stdout.trim()).toBe(process.env.ASHLR_VERSION || JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version);
      } else {
        expect(result.stdout).toContain('doctor');
      }
      expect(readdirSync(home)).toEqual(['metadata.mjs']);
    },
  );

  it('keeps fresh-process version and help startup within a generous budget', () => {
    const fixture = metadataFixture();
    const env = { ...process.env, HOME: fixture, USERPROFILE: fixture, ASHLR_HOME: join(fixture, '.ashlr'), NO_COLOR: '1' };
    delete env.ASHLR_VERSION;
    for (const arg of ['--version', '--help']) {
      const times: number[] = [];
      for (let sample = 0; sample < 7; sample++) {
        const start = performance.now();
        const result = spawnSync(process.execPath, [join(fixture, 'bin/ashlr'), arg], {
          encoding: 'utf8', timeout: 5000, env,
        });
        times.push(performance.now() - start);
        expect(result.error).toBeUndefined();
        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr).toBe('');
        expect(result.stdout).toContain(arg === '--help' ? 'Phantom' : JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version);
      }
      const median = times.sort((a, b) => a - b)[3]!;
      // The 40ms target is measured separately on an idle Linux equivalent.
      // Allow shared CI hosts ample headroom while catching second-scale regressions.
      expect(median, `${arg} median ${median.toFixed(1)}ms`).toBeLessThan(1000);
    }
  });
});
