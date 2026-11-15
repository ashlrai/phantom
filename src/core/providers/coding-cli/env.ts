/**
 * Environment for a coding-CLI adapter. The process keeps its own on-disk
 * login (HOME and the CLI config dirs). Phantom-managed tokens and keys are
 * not copied, including the engine OAuth names the sandboxed fleet still
 * forwards to its own claude spawn.
 */

const KEEP = [
  'PATH',
  'HOME',
  'USER',
  'LOGNAME',
  'LANG',
  'LC_ALL',
  'TERM',
  'TMPDIR',
  'TEMP',
  'TMP',
  'SHELL',
  'SystemRoot',
  'windir',
  'PATHEXT',
  'COMSPEC',
  'APPDATA',
  'LOCALAPPDATA',
  'USERPROFILE',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'XDG_CACHE_HOME',
  'CODEX_HOME',
  'CLAUDE_CONFIG_DIR',
] as const;

const SECRET = /(_|^)(TOKEN|SECRET|KEY|PAT|PASSWORD|PASSWD|CREDENTIALS?|API[_-]?KEY|OAUTH|CREDS?)$/i;

const EXACT_DENY = new Set([
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'GIT_ASKPASS',
  'SSH_AUTH_SOCK',
  'SSH_ASKPASS',
]);

/** Allowlisted identity and CLI-home variables only. Secret-shaped names drop. */
export function scrubAdapterEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const key of KEEP) {
    const value = source[key];
    if (typeof value !== 'string' || value === '') continue;
    if (SECRET.test(key) || EXACT_DENY.has(key)) continue;
    out[key] = value;
  }
  out.GIT_TERMINAL_PROMPT = '0';
  out.GIT_CONFIG_NOSYSTEM = '1';
  out.GIT_SSH_COMMAND = 'ssh -oBatchMode=yes';
  return out;
}

/** True when a name would be stripped. Used by tests and log redaction. */
export function isSecretEnvName(name: string): boolean {
  return SECRET.test(name) || EXACT_DENY.has(name);
}
