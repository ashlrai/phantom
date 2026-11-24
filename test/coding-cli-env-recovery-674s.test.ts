import { describe, expect, it } from 'vitest';
import { isSecretEnvName, scrubAdapterEnv } from '../src/core/providers/coding-cli/env.js';

const HARDENING = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_SSH_COMMAND: 'ssh -oBatchMode=yes',
};

describe('scrubAdapterEnv (recovered from PR #5952)', () => {
  it('keeps allowlisted identity, locale, temp and CLI-home names', () => {
    const src = {
      PATH: '/fake/bin', HOME: '/fake/home', USER: 'fake', LOGNAME: 'fake',
      LANG: 'C', LC_ALL: 'C', TERM: 'dumb', TMPDIR: '/fake/tmp', TEMP: '/fake/tmp',
      TMP: '/fake/tmp', SHELL: '/fake/sh', SystemRoot: 'FAKE_VALUE', windir: 'FAKE_VALUE',
      PATHEXT: 'FAKE_VALUE', COMSPEC: 'FAKE_VALUE', APPDATA: 'FAKE_VALUE',
      LOCALAPPDATA: 'FAKE_VALUE', USERPROFILE: 'FAKE_VALUE', XDG_CONFIG_HOME: '/fake/c',
      XDG_DATA_HOME: '/fake/d', XDG_CACHE_HOME: '/fake/k', CODEX_HOME: '/fake/codex',
      CLAUDE_CONFIG_DIR: '/fake/claude',
    };
    expect(scrubAdapterEnv(src)).toEqual({ ...src, ...HARDENING });
  });

  it('drops undefined and empty allowlisted values', () => {
    const out = scrubAdapterEnv({ PATH: '', HOME: undefined, USER: 'fake' });
    expect(out).toEqual({ USER: 'fake', ...HARDENING });
    expect('PATH' in out).toBe(false);
    expect('HOME' in out).toBe(false);
  });

  it('returns only hardening defaults for empty input', () => {
    expect(scrubAdapterEnv({})).toEqual(HARDENING);
  });

  it('excludes unknown and future names, even harmless-looking ones', () => {
    const out = scrubAdapterEnv({
      PATH: '/fake/bin', RANDOM_NAME: 'FAKE_VALUE', FUTURE_CLI_HOME_X: 'FAKE_VALUE',
      EDITOR: 'FAKE_VALUE', NODE_OPTIONS: 'FAKE_VALUE',
    });
    expect(Object.keys(out).sort()).toEqual(['GIT_CONFIG_NOSYSTEM', 'GIT_SSH_COMMAND', 'GIT_TERMINAL_PROMPT', 'PATH']);
  });

  it('excludes denylisted auth, askpass and socket names', () => {
    const names = ['GH_TOKEN', 'GITHUB_TOKEN', 'GIT_ASKPASS', 'SSH_AUTH_SOCK', 'SSH_ASKPASS',
      'SOME_PROVIDER_TOKEN', 'SOME_API_KEY', 'SOME_SECRET', 'SOME_PASSWORD'];
    const src: NodeJS.ProcessEnv = { PATH: '/fake/bin' };
    for (const n of names) src[n] = 'FAKE_VALUE';
    const out = scrubAdapterEnv(src);
    for (const n of names) {
      expect(n in out).toBe(false);
      expect(isSecretEnvName(n)).toBe(true);
    }
    expect(isSecretEnvName('PATH')).toBe(false);
    expect(out.PATH).toBe('/fake/bin');
  });

  it('forces git hardening over inherited values', () => {
    const out = scrubAdapterEnv({ GIT_TERMINAL_PROMPT: '1', GIT_SSH_COMMAND: 'FAKE_VALUE' });
    expect(out).toEqual(HARDENING);
  });

  it('does not mutate input and returns a fresh object', () => {
    const src: NodeJS.ProcessEnv = { PATH: '/fake/bin', GH_TOKEN: 'FAKE_VALUE' };
    const snapshot = { ...src };
    const out = scrubAdapterEnv(src);
    expect(src).toEqual(snapshot);
    expect(out).not.toBe(src);
    out.PATH = 'changed';
    expect(src.PATH).toBe('/fake/bin');
  });
});
