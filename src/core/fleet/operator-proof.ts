/** Email sender proof: DKIM for the From domain, plus one shared pairing secret. */
import { timingSafeEqual } from 'node:crypto';
import { readFileSync, lstatSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

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
  const fromEnv = process.env['PHANTOM_OPERATOR_SECRET'];
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
