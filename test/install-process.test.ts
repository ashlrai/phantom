import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInstallCommand } from '../src/core/install/process.js';
import { InstallError } from '../src/core/install/storage.js';

describe('install subprocess isolation', () => {
  let directory: string;
  let home: string;

  beforeEach(async () => {
    directory = await realpath(await mkdtemp(join(tmpdir(), 'phm-install-process-')));
    home = join(directory, 'execution');
    await mkdir(home);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });

  it('strips parent credentials and execution overrides, isolates config, and closes stdin', async () => {
    vi.stubEnv('PHANTOM_INSTALL_TEST_SECRET', 'synthetic-parent-only');
    vi.stubEnv('GIT_ASKPASS', 'synthetic-parent-helper');
    vi.stubEnv('NODE_OPTIONS', '--require=synthetic-missing-parent-module');
    vi.stubEnv('npm_config_registry', 'https://invalid.example/');
    const report = join(directory, 'child.json');
    const source = `
      import { writeFileSync } from 'node:fs';
      const timer = setTimeout(() => process.exit(19), 2000);
      let bytes = 0;
      process.stdin.on('data', chunk => { bytes += chunk.length; });
      process.stdin.on('end', () => {
        clearTimeout(timer);
        writeFileSync(process.argv[1], JSON.stringify({
          parentSecretPresent: Object.hasOwn(process.env, 'PHANTOM_INSTALL_TEST_SECRET'),
          parentHelperPresent: Object.hasOwn(process.env, 'GIT_ASKPASS'),
          parentNodeOptionsPresent: Object.hasOwn(process.env, 'NODE_OPTIONS'),
          home: process.env.HOME,
          userProfile: process.env.USERPROFILE,
          userConfig: process.env.npm_config_userconfig,
          globalConfig: process.env.npm_config_globalconfig,
          cache: process.env.npm_config_cache,
          registry: process.env.npm_config_registry,
          gitPrompt: process.env.GIT_TERMINAL_PROMPT,
          cwd: process.cwd(), stdinBytes: bytes
        }));
      });
      process.stdin.resume();
    `;
    await runInstallCommand(process.execPath, ['--input-type=module', '-e', source, report], { cwd: directory, home });
    expect(JSON.parse(await readFile(report, 'utf8'))).toEqual({
      parentSecretPresent: false, parentHelperPresent: false, parentNodeOptionsPresent: false,
      home, userProfile: home, userConfig: join(home, 'npm-user.rc'),
      globalConfig: join(home, 'npm-global.rc'), cache: join(home, 'npm-cache'),
      registry: 'https://registry.npmjs.org/', gitPrompt: '0', cwd: directory, stdinBytes: 0,
    });
  });

  it('returns only a fixed diagnostic when a real child emits private output and fails', async () => {
    const marker = 'SYNTHETIC_PRIVATE_CHILD_OUTPUT';
    const failure = await runInstallCommand(process.execPath, ['-e',
      'process.stdout.write(process.argv[1]); process.stderr.write(process.argv[1]); process.exitCode = 7;', marker],
    { cwd: directory, home }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(InstallError);
    expect((failure as Error).message).toBe('Tool installation command failed; child output withheld. Check prerequisites and retry.');
    expect(String(failure)).not.toContain(marker);
    expect(JSON.stringify(failure)).not.toContain(marker);
    expect(failure).not.toHaveProperty('stdout');
    expect(failure).not.toHaveProperty('stderr');
    expect(failure).not.toHaveProperty('cause');
  });

  it('lets real npm load distinct isolated config files without network access', async () => {
    // npm --version bypasses config loading and would miss the duplicate-path regression.
    await writeFile(join(home, 'npm-user.rc'), '');
    await writeFile(join(home, 'npm-global.rc'), '');
    await expect(runInstallCommand('npm', ['config', 'get', 'registry'],
      { cwd: directory, home })).resolves.toBeUndefined();
  });
});
