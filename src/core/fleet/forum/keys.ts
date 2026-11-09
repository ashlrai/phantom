/**
 * Per-agent forum keys. Material comes from the environment, a private key
 * file, or the macOS keychain. Nothing here is written into the repo.
 */
import { execFile } from 'node:child_process';
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { isAgentId } from './canon.js';

export type KeychainExec = (args: string[]) => Promise<string>;

const HEX_KEY = /^[0-9a-f]{64}$/;

export function parseEnvKeys(raw: string | undefined): Map<string, string> {
  const keys = new Map<string, string>();
  if (!raw) return keys;
  for (const part of raw.split(',')) {
    const index = part.indexOf(':');
    if (index < 1) continue;
    const id = part.slice(0, index);
    const key = part.slice(index + 1);
    if (isAgentId(id) && HEX_KEY.test(key)) keys.set(id, key);
  }
  return keys;
}

export async function readKeyFile(path: string | undefined): Promise<Map<string, string>> {
  const keys = new Map<string, string>();
  if (!path || !isAbsolute(path)) return keys;
  let stat;
  try { stat = await lstat(path); } catch { return keys; }
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > 64 * 1024) return keys;
  if (process.platform !== 'win32' && (stat.mode & 0o077) !== 0) return keys;
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(path, 'utf8')); } catch { return keys; }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return keys;
  const agents = (parsed as { agents?: unknown }).agents;
  if (agents === null || typeof agents !== 'object' || Array.isArray(agents)) return keys;
  for (const [id, key] of Object.entries(agents)) {
    if (isAgentId(id) && typeof key === 'string' && HEX_KEY.test(key)) keys.set(id, key);
  }
  return keys;
}

export async function readKeychainKey(id: string, exec: KeychainExec = defaultKeychain): Promise<string | null> {
  if (process.env.PHANTOM_FORUM_KEYCHAIN !== '1' || process.platform !== 'darwin' || !isAgentId(id)) return null;
  try {
    const output = (await exec(['find-generic-password', '-s', 'phantom-forum-agent', '-a', id, '-w'])).trim();
    return HEX_KEY.test(output) ? output : null;
  } catch {
    return null;
  }
}

function defaultKeychain(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('security', args, { timeout: 2000, maxBuffer: 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

export async function resolveAgentKey(id: string, env: NodeJS.ProcessEnv, exec?: KeychainExec): Promise<string | null> {
  const fromEnv = parseEnvKeys(env.PHANTOM_FORUM_AGENT_KEYS).get(id);
  if (fromEnv) return fromEnv;
  const fromFile = (await readKeyFile(env.PHANTOM_FORUM_KEY_FILE)).get(id);
  if (fromFile) return fromFile;
  return readKeychainKey(id, exec);
}
