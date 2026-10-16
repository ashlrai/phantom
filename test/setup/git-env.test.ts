import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { scrubAmbientGitEnv } from './home.js';

it('removes environment-injected git config and repository location', () => {
  const env: NodeJS.ProcessEnv = {
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'url.https://github.com/.insteadOf',
    GIT_CONFIG_VALUE_0: 'git@github.com:',
    GIT_CONFIG_PARAMETERS: "'core.bare'='true'",
    GIT_CONFIG_GLOBAL: '/real/home/.gitconfig',
    GIT_DIR: '/real/repo/.git',
    GIT_WORK_TREE: '/real/repo',
    GIT_INDEX_FILE: '/real/repo/.git/index',
    GIT_OBJECT_DIRECTORY: '/real/repo/.git/objects',
    GIT_ALTERNATE_OBJECT_DIRECTORIES: '/elsewhere/objects',
    GIT_COMMON_DIR: '/real/repo/.git',
    GIT_NAMESPACE: 'ns',
    GIT_PREFIX: 'sub/',
    GIT_CONFIG_SYSTEM: '/etc/gitconfig',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_SSL_CAINFO: '/ca.pem',
    GIT_TERMINAL_PROMPT: '0',
    PATH: '/usr/bin',
  };
  scrubAmbientGitEnv(env);
  expect(env).toEqual({
    GIT_CONFIG_SYSTEM: '/etc/gitconfig',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_SSL_CAINFO: '/ca.pem',
    GIT_TERMINAL_PROMPT: '0',
    PATH: '/usr/bin',
  });
});

it('runs every test module with no environment-injected git config', () => {
  for (const key of Object.keys(process.env)) {
    expect(key).not.toMatch(/^GIT_CONFIG_(?:COUNT|KEY_\d+|VALUE_\d+|PARAMETERS|GLOBAL)$/i);
    expect(key).not.toMatch(/^GIT_(?:DIR|WORK_TREE|INDEX_FILE|COMMON_DIR)$/i);
  }
  const repo = mkdtempSync(join(process.env.HOME!, 'git-env-'));
  try {
    execFileSync('git', ['init', '-q', repo]);
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'git@github.com:owner/project.git']);
    expect(execFileSync('git', ['-C', repo, 'remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim())
      .toBe('git@github.com:owner/project.git');
    const origins = execFileSync('git', ['-C', repo, 'config', '--show-origin', '--list'], { encoding: 'utf8' });
    expect(origins).not.toMatch(/^command line:/mu);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
