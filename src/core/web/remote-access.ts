/** Cloudflare Access identity check and shared helpers for the opt-in phone gateway. */
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, rmSync, writeSync, type Stats } from 'node:fs';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { isIP } from 'node:net';

export const REMOTE_UUID_RE = /^[0-9a-f-]{36}$/;
export const REMOTE_SUBJECT_RE = /^[A-Za-z0-9_-]{8,256}$/;
export const REMOTE_BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
export const REMOTE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
const GATEWAY_CONFIG_MAX_BYTES = 8192;

export function isRemoteRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function isPublicHttpsOrigin(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const origin = new URL(value);
    return origin.protocol === 'https:' && origin.origin === value && origin.hostname.includes('.')
      && isIP(origin.hostname) === 0
      && origin.hostname !== 'localhost' && !origin.hostname.endsWith('.localhost');
  } catch { return false; }
}

export function isBase64UrlOfByteLength(value: unknown, byteLength: number): value is string {
  return typeof value === 'string' && REMOTE_BASE64URL_RE.test(value)
    && Buffer.from(value, 'base64url').length === byteLength;
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}

export function lstatOrNull(path: string): Stats | null {
  try { return lstatSync(path); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function isPrivateOwnedStat(stat: Stats, kind: 'file' | 'directory' | 'socket'): boolean {
  const matchesKind = kind === 'directory' ? stat.isDirectory() : kind === 'socket' ? stat.isSocket() : stat.isFile();
  return !stat.isSymbolicLink() && matchesKind
    && (stat.mode & 0o077) === 0
    && (typeof process.getuid !== 'function' || stat.uid === process.getuid());
}

export function assertPrivatePath(path: string, kind: 'file' | 'directory' | 'socket', message: string): Stats {
  const stat = lstatSync(path);
  if (!isPrivateOwnedStat(stat, kind)) throw new Error(message);
  return stat;
}

export function ensurePrivateDirectory(root: string, message: string): void {
  mkdirSync(root, { recursive: true, mode: 0o700 });
  assertPrivatePath(root, 'directory', message);
}

export function withExclusivePrivateLock<T>(
  root: string,
  lockPath: string,
  messages: { dir: string; lock: string },
  run: () => T,
): T {
  ensurePrivateDirectory(root, messages.dir);
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  const fd = openSync(lockPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | noFollow, 0o600);
  try {
    writeSync(fd, `${process.pid}\n`);
    fsyncSync(fd);
    if ((fstatSync(fd).mode & 0o077) !== 0) throw new Error(messages.lock);
    return run();
  } finally {
    closeSync(fd);
    rmSync(lockPath, { force: true });
  }
}

export function readPrivateJsonObject(
  path: string,
  maxBytes: number,
  label: string,
  notPrivateMessage = `${label} is not private`,
): Record<string, unknown> {
  const stat = assertPrivatePath(path, 'file', notPrivateMessage);
  if (stat.size > maxBytes) throw new Error(`${label} is too large`);
  let data: unknown;
  try { data = JSON.parse(readFileSync(path, 'utf8')) as unknown; }
  catch { throw new Error(`${label} is unreadable`); }
  if (!isRemoteRecord(data)) throw new Error(`${label} is invalid`);
  return data;
}

export async function readBoundedResponse(response: Response, maxBytes: number): Promise<Buffer | null> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > maxBytes || !response.body) return null;
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) { await reader.cancel(); return null; }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
  } finally { reader.releaseLock(); }
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

/** No defaults: incomplete provisioned config cannot make a gateway usable. */
export function parseRemoteAccessConfig(value: unknown): RemoteAccessConfig | null {
  if (!isRemoteRecord(value)) return null;
  const { publicOrigin, teamDomain, audience, allowedSubjects } = value;
  if (!isPublicHttpsOrigin(publicOrigin) || typeof teamDomain !== 'string' || typeof audience !== 'string') return null;
  if (!TEAM_DOMAIN.test(teamDomain) || !AUDIENCE.test(audience)) return null;
  if (!Array.isArray(allowedSubjects) || allowedSubjects.length === 0
    || allowedSubjects.some((subject: unknown) => typeof subject !== 'string' || !REMOTE_SUBJECT_RE.test(subject))) return null;
  return { publicOrigin, teamDomain, audience, allowedSubjects: [...new Set(allowedSubjects as string[])] };
}

/** Read and validate a private 0600 remote gateway config without following symlinks. */
export function readRemoteGatewayConfig(path: string): { access: RemoteAccessConfig; gatewayPort: number } {
  const before = lstatSync(path);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error('Remote gateway config must be a private 0600 file owned by this user');
  }
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = fstatSync(fd);
    if (!isPrivateOwnedStat(stat, 'file') || stat.ino !== before.ino || stat.dev !== before.dev
      || stat.size > GATEWAY_CONFIG_MAX_BYTES) {
      throw new Error('Remote gateway config must be a private 0600 file owned by this user');
    }
    const buffer = Buffer.alloc(GATEWAY_CONFIG_MAX_BYTES + 1);
    let size = 0;
    while (size < buffer.length) {
      const count = readSync(fd, buffer, size, buffer.length - size, null);
      if (!count) break;
      size += count;
    }
    if (size > GATEWAY_CONFIG_MAX_BYTES) {
      throw new Error('Remote gateway config must be a private 0600 file owned by this user');
    }
    const value: unknown = JSON.parse(buffer.subarray(0, size).toString('utf8'));
    if (!isRemoteRecord(value) || Object.keys(value).some((key) => key !== 'access' && key !== 'gatewayPort')) {
      throw new Error('Invalid remote gateway config');
    }
    const access = parseRemoteAccessConfig(value.access);
    const gatewayPort = value.gatewayPort;
    if (!access || !Number.isInteger(gatewayPort) || (gatewayPort as number) < 1 || (gatewayPort as number) > 65535) {
      throw new Error('Remote gateway Access config or port is invalid');
    }
    return { access, gatewayPort: gatewayPort as number };
  } finally { closeSync(fd); }
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
