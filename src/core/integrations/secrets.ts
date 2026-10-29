/**
 * Credential boundary: CLI children use Secrets' `phantom exec` transport;
 * legacy in-process clients read their existing environment on demand. Secrets
 * does not support unattended plaintext extraction into the parent. Provider
 * key resolution must never send its placeholders as API credentials.
 */
import type { AshlrConfig } from '../types.js';
import * as childProcess from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { basename, delimiter, resolve } from 'node:path';
import { fileURLToPath, URL as NodeURL } from 'node:url';
import { promisify } from 'node:util';
import { hasInheritedLocusSession, hasLocusJobEnv } from './locus-job-env.js';

function isPhantomPlaceholderToken(value: string | undefined | null): boolean {
  const trimmed = value?.trim();
  return typeof trimmed === 'string' && /^phm_[A-Za-z0-9_-]+$/.test(trimmed);
}

/** @deprecated Automatic vault extraction is unsupported. Kept for compatibility. */
export function revealSecret(_name: string): string | null {
  return null;
}

/** Existing private environment route; does not probe or read the Secrets vault. */
export function resolveProviderKey(envKey: string, _cfg: AshlrConfig): string | undefined {
  if (!envKey) return undefined;
  const fromEnv = process.env[envKey];
  return fromEnv && fromEnv.trim().length > 0 && !isPhantomPlaceholderToken(fromEnv) ? fromEnv : undefined;
}

/** Value-free diagnostics; configured vault support is not execution readiness. */
export function explainProviderKey(envKey: string, cfg: AshlrConfig):
  'environment-supported' | 'environment-missing' | 'placeholder-unusable' | 'vault-transport-not-supported' {
  if (envKey && isPhantomPlaceholderToken(process.env[envKey])) return 'placeholder-unusable';
  if (resolveProviderKey(envKey, cfg)) return 'environment-supported';
  return cfg.phantom?.enabled ? 'vault-transport-not-supported' : 'environment-missing';
}

/**
 * Read an existing host credential without caching, logging or vault extraction.
 * Callers retain their established validation and empty-value semantics. Child
 * processes should use the Secrets exec transport instead of reading credentials.
 */
export function readEnvironmentCredential(envKey: string): string | undefined {
  return process.env[envKey];
}

// Ordinary host CLI launches share this boundary. Engine/sandbox dispatch keeps
// its own custody and Locus admission: generic Secrets exec is not a sealed-job
// credential bridge. Never inspect credential values to decide whether to wrap;
// a CLI may authenticate with a config file, SSH agent, or vault placeholder.
const CREDENTIAL_CLIS = new Set([
  'gh', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'vercel', 'wrangler', 'supabase',
  'aws', 'az', 'gcloud', 'doctl', 'fly', 'flyctl', 'heroku', 'netlify', 'railway',
  'terraform', 'tofu', 'pulumi', 'docker', 'kubectl', 'helm', 'stack',
  'claude', 'codex', 'gemini', 'grok', 'aw', 'ac', 'ashlrcode', 'morphkit', 'devin',
]);
const LOCAL_GIT_COMMANDS = new Set([
  'status', 'diff', 'log', 'show', 'rev-parse', 'rev-list', 'symbolic-ref',
  'config', 'branch', 'checkout', 'switch', 'restore', 'add', 'commit', 'reset',
  'revert', 'cherry-pick', 'merge', 'merge-base', 'rebase', 'tag', 'worktree',
  'init', 'apply', 'ls-files', 'ls-tree', 'cat-file', 'hash-object', 'update-ref',
  'check-ref-format', 'check-ignore', 'check-attr', 'for-each-ref', 'diff-tree',
  'diff-index', 'diff-files', 'write-tree', 'read-tree', 'reflog', 'stash',
  'clean', 'gc', 'prune', 'fsck', 'describe', 'blame', 'shortlog', 'count-objects',
]);

function credentialCommand(command: string, args: readonly string[]): boolean {
  const name = basename(command.replaceAll('\\', '/')).replace(/\.(?:exe|cmd|bat)$/i, '').toLowerCase();
  if (args.length === 1 && ['--version', '-v', '--help', '-h'].includes(args[0]!)) return false;
  if (name !== 'git') return CREDENTIAL_CLIS.has(name);
  // Skip Git global options, including their values, before identifying the
  // subcommand. Unknown commands/aliases may use remote credentials, so wrap.
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env'].includes(arg)) { i++; continue; }
    if (arg.startsWith('-')) continue;
    if (arg === 'remote') {
      const remoteArgs = args.slice(i + 1).filter(value => value !== '-v' && value !== '--verbose');
      const subcommand = remoteArgs[0];
      if (!subcommand || ['get-url', 'set-url', 'remove', 'rm', 'rename'].includes(subcommand)) return false;
      if (subcommand === 'add' && !remoteArgs.includes('-f') && !remoteArgs.includes('--fetch')) return false;
      return true;
    }
    return !LOCAL_GIT_COMMANDS.has(arg);
  }
  return false;
}

type CredentialOptions = Pick<childProcess.SpawnOptions, 'cwd' | 'env' | 'shell'>;
let warnedMissingSecrets = false;

function installedSecrets(options: CredentialOptions): string | undefined {
  const env = options.env ?? process.env;
  const pathKey = process.platform === 'win32' ? Object.keys(env).find(key => key.toUpperCase() === 'PATH') : 'PATH';
  const searchPath = (pathKey ? env[pathKey] : undefined) ?? (process.platform === 'win32' ? '' : '/usr/bin:/bin');
  const cwd = options.cwd instanceof NodeURL ? fileURLToPath(options.cwd) : options.cwd ?? process.cwd();
  // Secrets ships a native executable. Do not launch a .cmd via a shell: that
  // would reinterpret the caller's argv and weaken the no-shell contract.
  const filename = process.platform === 'win32' ? 'phantom.exe' : 'phantom';
  for (const directory of searchPath.split(delimiter)) {
    const candidate = resolve(cwd, directory, filename);
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EACCES' || code === 'EPERM') {
        throw new Error('Phantom Secrets executable discovery was denied; refusing unwrapped credential execution');
      }
      // This PATH entry does not contain an executable Secrets CLI.
    }
  }
  if (process.platform === 'win32') {
    for (const directory of searchPath.split(delimiter)) {
      // An npm shim is an installed but unsupported transport, not permission
      // to bypass Secrets or to reinterpret arbitrary arguments with cmd.exe.
      const shim = resolve(cwd, directory, 'phantom.cmd');
      let present = false;
      try { present = statSync(shim).isFile(); } catch { /* absent */ }
      if (present) throw new Error('Phantom Secrets requires its native phantom.exe on PATH for shell-free credential execution');
    }
  }
  return undefined;
}

function credentialInvocation(invocation: unknown[], required = false): unknown[] {
  const command = invocation[0];
  if (typeof command !== 'string') return invocation; // Let Node report invalid input.
  const hasArgs = Array.isArray(invocation[1]);
  const args = hasArgs ? invocation[1] as string[] : [];
  if (!required && !credentialCommand(command, args)) return invocation;
  const rest = invocation.slice(hasArgs ? 2 : 1);
  const options = rest[0] && typeof rest[0] === 'object' ? rest[0] as CredentialOptions : {};
  // Refuse before probing PATH or launching anything, including absent-Secrets
  // fallback. A generic host vault cannot choose a sealed job's identity.
  if (hasLocusJobEnv() || hasInheritedLocusSession() ||
      options.env?.LOCUS_SESSION_ID !== undefined || options.env?.LOCUS_EXECUTOR_CAPABILITY !== undefined) {
    throw new Error('Locus sealed jobs cannot use generic Secrets exec until a qualified scoped credential bridge exists');
  }
  if (options.shell) throw new Error('Credential CLI execution requires argv without a shell');
  const phantom = installedSecrets(options);
  if (phantom) return [phantom, ['exec', '--', command, ...args], ...rest];
  if (!warnedMissingSecrets) {
    warnedMissingSecrets = true;
    // Fixed, value-free diagnostic: no argv, paths, environment, or CLI stderr.
    process.stderr.write('Warning: Phantom Secrets is not installed on the child PATH; credential CLIs are running without phantom exec.\n');
  }
  return invocation;
}

/** Preserve Node's subprocess options/results; never retry a failed Secrets exec. */
export const credentialSpawnSync: typeof childProcess.spawnSync = ((...args: unknown[]) =>
  Reflect.apply(childProcess.spawnSync, undefined, credentialInvocation(args))) as typeof childProcess.spawnSync;

/** Provider/deploy boundaries may accept arbitrary operator-configured CLI names. */
export const providerSpawnSync: typeof childProcess.spawnSync = ((...args: unknown[]) =>
  Reflect.apply(childProcess.spawnSync, undefined, credentialInvocation(args, true))) as typeof childProcess.spawnSync;

export const credentialExecFileSync: typeof childProcess.execFileSync = ((...args: unknown[]) =>
  Reflect.apply(childProcess.execFileSync, undefined, credentialInvocation(args))) as typeof childProcess.execFileSync;

export const credentialSpawn: typeof childProcess.spawn = ((...args: unknown[]) =>
  Reflect.apply(childProcess.spawn, undefined, credentialInvocation(args))) as typeof childProcess.spawn;

export const credentialExecFile: typeof childProcess.execFile = ((...args: unknown[]) =>
  Reflect.apply(childProcess.execFile, undefined, credentialInvocation(args))) as typeof childProcess.execFile;

// Node's execFile custom promisifier resolves BOTH streams and exposes .child.
// Copying the original custom function would silently bypass this boundary.
Object.defineProperty(credentialExecFile, promisify.custom, {
  value: (...args: unknown[]) => {
    let child: childProcess.ChildProcess | undefined;
    const promise = new Promise<{ stdout: string | Buffer; stderr: string | Buffer }>((resolvePromise, reject) => {
      child = Reflect.apply(credentialExecFile, undefined, [...args,
        (error: childProcess.ExecFileException | null, stdout: string | Buffer, stderr: string | Buffer) => {
          if (error) reject(Object.assign(error, { stdout, stderr }));
          else resolvePromise({ stdout, stderr });
        }]);
    });
    return Object.assign(promise, { child });
  },
});
