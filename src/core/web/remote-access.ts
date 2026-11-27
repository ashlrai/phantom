/** Cloudflare Access identity check for the opt-in phone gateway. */
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { constants, closeSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, rmSync, writeSync, type Stats } from 'node:fs';
import { isIP } from 'node:net';
import { isWebRecord } from './api-http-helpers.js';

const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** Verify a path is non-symlink, owned by this user, mode-077-clean, and matches `kind`. */
export function assertPrivatePath(path: string, kind: 'file' | 'directory' | 'socket', message: string): Stats {
  const stat = lstatSync(path);
  const ok = kind === 'directory' ? stat.isDirectory() : kind === 'socket' ? stat.isSocket() : stat.isFile();
  if (stat.isSymbolicLink() || !ok || (stat.mode & 0o077) !== 0
    || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw new Error(message);
  }
  return stat;
}

/** `lstatSync(path)` returning null only on ENOENT. */
export function lstatOrNull(path: string): Stats | null {
  try { return lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Validate a base64url string whose decoded byte length matches `byteLength`. */
export function isBase64UrlOfByteLength(value: unknown, byteLength: number): value is string {
  return typeof value === 'string' && BASE64URL.test(value) && Buffer.from(value, 'base64url').length === byteLength;
}

/** Read and parse a private, bounded JSON object file owned by this user. */
export function readPrivateJsonRecord(
  path: string,
  maxBytes: number,
  labels: { notPrivate: string; tooLarge: string; unreadable: string; invalid: string },
): Record<string, unknown> {
  if (assertPrivatePath(path, 'file', labels.notPrivate).size > maxBytes) throw new Error(labels.tooLarge);
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown; }
  catch { throw new Error(labels.unreadable); }
  if (!isWebRecord(parsed)) throw new Error(labels.invalid);
  return parsed;
}

/** Create a private 0700 dir, hold an exclusive non-following 0600 lock, and release in `finally`. */
export function withPrivateFileLock<T>(
  root: string,
  lockPath: string,
  dirNotPrivate: string,
  lockNotPrivate: string,
  fn: () => T,
): T {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  assertPrivatePath(root, 'directory', dirNotPrivate);
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  const fd = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
  try {
    writeSync(fd, `${process.pid}\n`);
    fsyncSync(fd);
    if ((fstatSync(fd).mode & 0o077) !== 0) throw new Error(lockNotPrivate);
    return fn();
  } finally {
    closeSync(fd);
    rmSync(lockPath, { force: true });
  }
}

export interface RemoteAccessConfig {
  /** Exact public HTTPS origin, also used for WebAuthn. */
  publicOrigin: string;
  /** Cloudflare One team issuer, e.g. https://team.cloudflareaccess.com. */
  teamDomain: string;
  /** Access self-hosted application's AUD tag. */
  audience: string;
  /** Explicit human identity IDs; an Access policy alone does not pair a device. */
  allowedSubjects: readonly string[];
}

export interface RemoteAccessIdentity {
  subject: string;
  email: string;
  expiresAt: number;
}

const TEAM_DOMAIN = /^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/;
const AUDIENCE = /^[a-f0-9]{64}$/i;

/** True only for a bare public HTTPS origin (no path, IP literal, or localhost). */
export function isPublicHttpsOrigin(value: string): boolean {
  try {
    const origin = new URL(value);
    return origin.protocol === 'https:' && origin.origin === value && origin.hostname.includes('.')
      && isIP(origin.hostname) === 0
      && origin.hostname !== 'localhost' && !origin.hostname.endsWith('.localhost');
  } catch {
    return false;
  }
}

/** Validate the exact `{ access, gatewayPort }` shape of a remote gateway config record. */
export function parseRemoteGatewayConfigRecord(
  value: unknown,
): { access: RemoteAccessConfig; gatewayPort: number } | null {
  if (!isWebRecord(value)) return null;
  if (Object.keys(value).some((key) => key !== 'access' && key !== 'gatewayPort')) return null;
  const access = parseRemoteAccessConfig(value.access);
  const gatewayPort = value.gatewayPort;
  if (!access || !Number.isInteger(gatewayPort) || (gatewayPort as number) < 1 || (gatewayPort as number) > 65535) {
    return null;
  }
  return { access, gatewayPort: gatewayPort as number };
}

/** No defaults: incomplete provisioned config cannot make a gateway usable. */
export function parseRemoteAccessConfig(value: unknown): RemoteAccessConfig | null {
  if (!isWebRecord(value)) return null;
  const { publicOrigin, teamDomain, audience, allowedSubjects } = value;
  if (typeof publicOrigin !== 'string' || typeof teamDomain !== 'string' || typeof audience !== 'string') return null;
  if (!TEAM_DOMAIN.test(teamDomain) || !AUDIENCE.test(audience)) return null;
  if (!Array.isArray(allowedSubjects) || allowedSubjects.length === 0
    || allowedSubjects.some((subject: unknown) => typeof subject !== 'string' || !/^[A-Za-z0-9_-]{8,256}$/.test(subject))) return null;
  if (!isPublicHttpsOrigin(publicOrigin)) return null;
  return { publicOrigin, teamDomain, audience, allowedSubjects: [...new Set(allowedSubjects as string[])] };
}

/**
 * Production uses only the configured team's JWKS URL. Tests inject a local
 * verifier key set; neither a JWT's iss nor kid may choose a network location.
 */
export function createRemoteAccessVerifier(configInput: unknown, testKeys?: JWTVerifyGetKey) {
  const config = parseRemoteAccessConfig(configInput);
  if (!config) throw new Error('Remote Access configuration is incomplete or invalid');
  const keys = testKeys ?? createRemoteJWKSet(new URL(`${config.teamDomain}/cdn-cgi/access/certs`));
  return async (assertion: string | undefined): Promise<RemoteAccessIdentity | null> => {
    if (!assertion || assertion.length > 16_384 || assertion.split('.').length !== 3) return null;
    try {
      const { payload } = await jwtVerify(assertion, keys, {
        issuer: config.teamDomain,
        audience: config.audience,
        algorithms: ['RS256'],
        requiredClaims: ['exp', 'iat', 'nbf', 'sub'],
      });
      // Service tokens also say type=app, but have an empty sub and no email.
      if (payload.type !== 'app' || typeof payload.sub !== 'string'
        || !config.allowedSubjects.includes(payload.sub)
        || typeof payload.email !== 'string' || !payload.email.trim()
        || typeof payload.exp !== 'number' || payload.common_name !== undefined
        || payload.service_token_id !== undefined) return null;
      return { subject: payload.sub, email: payload.email, expiresAt: payload.exp * 1_000 };
    } catch { return null; }
  };
}

/** Use only Access's signed assertion header; its browser cookie is not proof. */
export async function verifyRemoteAccessHeader(
  headers: Record<string, string | string[] | undefined>,
  verify: ReturnType<typeof createRemoteAccessVerifier>,
): Promise<RemoteAccessIdentity | null> {
  const assertion = headers['cf-access-jwt-assertion'];
  return verify(typeof assertion === 'string' ? assertion : undefined);
}
