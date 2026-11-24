import { execFile } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, join } from 'node:path';
import { InstallError } from './storage.js';

export type InstallRunner = (command: string, args: string[], options: { cwd: string; home: string }) => Promise<void>;

function npmCli(): string {
  // Execute npm's JavaScript directly: Windows .cmd shims otherwise require a shell.
  // Do not trust npm_execpath or relative PATH entries inherited from another tool.
  const directories = new Set([dirname(process.execPath), ...(process.env.PATH ?? '').split(delimiter).filter(isAbsolute)]);
  for (const directory of directories) {
    const adjacent = join(directory, 'node_modules', 'npm', 'bin', 'npm-cli.js');
    if (existsSync(adjacent)) return adjacent;
    try {
      const resolved = realpathSync(join(directory, 'npm'));
      if (resolved.endsWith(join('npm', 'bin', 'npm-cli.js'))) return resolved;
    } catch { /* Continue through trusted absolute executable locations. */ }
  }
  throw new InstallError('npm CLI is unavailable. Install Node.js with npm and retry.');
}

/** No shell, inherited credentials, user package-manager config, or child output in diagnostics. */
export const runInstallCommand: InstallRunner = (command, args, { cwd, home }) => new Promise((resolve, reject) => {
  const nullFile = process.platform === 'win32' ? 'NUL' : '/dev/null';
  const child = execFile(command === 'npm' ? process.execPath : command, command === 'npm' ? [npmCli(), ...args] : args, {
    cwd, timeout: 120_000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
    env: {
      PATH: process.env.PATH, HOME: home, USERPROFILE: home,
      ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot } : {}),
      GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_SYSTEM: nullFile, GIT_CONFIG_GLOBAL: nullFile,
      GIT_TERMINAL_PROMPT: '0', GIT_ATTR_NOSYSTEM: '1',
      npm_config_userconfig: join(home, 'npm-user.rc'), npm_config_globalconfig: join(home, 'npm-global.rc'),
      npm_config_cache: join(home, 'npm-cache'), npm_config_update_notifier: 'false',
      npm_config_registry: 'https://registry.npmjs.org/',
    },
  }, error => {
    if (error) {
      reject(new InstallError('Tool installation command failed; child output withheld. Check prerequisites and retry.'));
    } else resolve();
  });
  child.stdin?.end();
});
