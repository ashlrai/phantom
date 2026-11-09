/** Email sender proof: DKIM for the From domain, plus one shared pairing secret. */
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, writeSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readEnvironmentCredential } from '../integrations/secrets.js';
import { ensurePrivateDirectory } from '../verse/preferences.js';

export type OperatorSecretState = 'absent' | 'invalid' | 'ready';

/** A pairing secret is 16–128 characters with no whitespace. */
export function operatorSecretState(value: string | undefined): OperatorSecretState {
  if (value === undefined || value.length === 0) return 'absent';
  if (value.length < 16 || value.length > 128 || /\s/.test(value)) return 'invalid';
  return 'ready';
}

export function secretsMatch(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  if (a.length !== b.length) {
    timingSafeEqual(a, a);
    return false;
  }
  return timingSafeEqual(a, b);
}

/** Drop one exact secret line. The remaining text is the order or the question. */
export function stripPairingSecret(body: string, secret: string): { presented: boolean; body: string } {
  const lines = body.replace(/\r\n/g, '\n').split('\n');
  const index = lines.findIndex((line) => secretsMatch(line.trim(), secret));
  if (index < 0) return { presented: false, body: body.trim() };
  lines.splice(index, 1);
  return { presented: true, body: lines.join('\n').trim() };
}

/** DKIM pass for the sender's domain. A bare "pass" or another domain is not enough. */
export function dkimPasses(authenticationResults: string | null | undefined, from: string): boolean {
  if (!authenticationResults) return false;
  const domain = from.split('@')[1]?.toLowerCase();
  if (!domain || domain.includes(' ')) return false;
  return authenticationResults.split(';').some((part) => {
    const item = part.toLowerCase();
    return /\bdkim=pass\b/.test(item) && !/\bdkim=fail\b/.test(item)
      && item.split(/\s+/).some(token => token === `header.d=${domain}` || token === `d=${domain}`);
  });
}

/**
 * Env `PHANTOM_OPERATOR_SECRET`, or a private `~/.ashlr/comms/operator-secret` file.
 * The value is never logged. An unreadable or wrong-mode file is invalid, not absent.
 */
export function readOperatorSecret(): { state: OperatorSecretState; secret?: string } {
  const fromEnv = readEnvironmentCredential('PHANTOM_OPERATOR_SECRET');
  if (fromEnv !== undefined) {
    const state = operatorSecretState(fromEnv);
    return state === 'ready' ? { state, secret: fromEnv } : { state };
  }
  const path = join(homedir(), '.ashlr', 'comms', 'operator-secret');
  try {
    const info = lstatSync(path);
    if (!info.isFile() || (info.mode & 0o077) !== 0) return { state: 'invalid' };
    const text = readFileSync(path, 'utf8').replace(/\n$/, '');
    const state = operatorSecretState(text);
    return state === 'ready' ? { state, secret: text } : { state };
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? { state: 'absent' } : { state: 'invalid' };
  }
}

/** Explicit local setup only. Never rotates an existing credential or returns its value. */
export function initializeOperatorSecret(): { ok: boolean; created: boolean } {
  const environment = readEnvironmentCredential('PHANTOM_OPERATOR_SECRET');
  if (environment !== undefined && operatorSecretState(environment) !== 'absent') return { ok: operatorSecretState(environment) === 'ready', created: false };
  // Existing reader policy may recognize a credential; never create a POSIX-only secret on Windows.
  if (process.platform === 'win32') return { ok: readOperatorSecret().state === 'ready', created: false };
  const root = join(homedir(), '.ashlr');
  const directory = join(root, 'comms');
  const path = join(directory, 'operator-secret');
  let created = false;
  try {
    ensurePrivateDirectory(root); ensurePrivateDirectory(directory);
    const parent = lstatSync(directory, { bigint: true });
    const anchor = lstatSync(root, { bigint: true });
    if ((parent.mode & 0o077n) !== 0n || (anchor.mode & 0o022n) !== 0n) return { ok: false, created };
    try {
      const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      created = true;
      try {
        const bytes = Buffer.from(randomBytes(32).toString('hex') + '\n');
        let offset = 0;
        while (offset < bytes.length) {
          const count = writeSync(fd, bytes, offset, bytes.length - offset);
          if (count <= 0) throw new Error('secret initialization failed');
          offset += count;
        }
        fsyncSync(fd);
      } finally { closeSync(fd); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const before = fstatSync(fd, { bigint: true });
      if (!before.isFile() || before.nlink !== 1n || before.uid !== parent.uid || (before.mode & 0o777n) !== 0o600n
        || before.size < 16n || before.size > 129n) return { ok: false, created };
      const secret = readFileSync(fd, 'utf8').replace(/\n$/, '');
      const after = fstatSync(fd, { bigint: true });
      const named = lstatSync(path, { bigint: true });
      const finalParent = lstatSync(directory, { bigint: true });
      const finalAnchor = lstatSync(root, { bigint: true });
      const same = (a: typeof before, b: typeof before) => a.dev === b.dev && a.ino === b.ino && a.mode === b.mode
        && a.uid === b.uid && a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
      return { ok: same(before, after) && same(after, named) && parent.dev === finalParent.dev && parent.ino === finalParent.ino && parent.mode === finalParent.mode && parent.uid === finalParent.uid
        && anchor.dev === finalAnchor.dev && anchor.ino === finalAnchor.ino && anchor.mode === finalAnchor.mode && anchor.uid === finalAnchor.uid
        && operatorSecretState(secret) === 'ready', created };
    } finally { closeSync(fd); }
  } catch { return { ok: false, created }; }
}
