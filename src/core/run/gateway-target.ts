/**
 * Governed-client gateway target validator (slice A: pure, not wired).
 *
 * Decides whether a governed first-party client (anthropic-client.ts,
 * openai-agents/client.ts) may send its request to an operator-configured
 * gateway instead of the provider. Nothing calls this yet; no client
 * behavior changes until a later, separately reviewed PR wires it in.
 *
 * Rules (docs/GOVERNED-GATEWAY-DESIGN.md, decisions of 2026-10-19):
 *   - Opt-in only: the top-level `gateways.<client>.enabled` must be literally
 *     `true`. Anything else resolves to the first-party target.
 *   - The environment never selects a target. This module reads no env vars.
 *   - Schemes: `https:` always; `http:` only for loopback. Nothing else.
 *   - Loopback means the IP literals 127.0.0.1 and [::1] only. The name
 *     `localhost` (and `*.localhost`) is refused, as is every other IP literal.
 *   - Non-loopback targets need an exact `host:port` entry in `allowedHosts`.
 *   - Refused: userinfo, query, fragment, non-canonical hosts (trailing dot,
 *     numeric shorthands, percent-encoding, non-ASCII), dot segments, empty
 *     segments, backslashes, percent-encoding and whitespace in the path.
 *   - Refusal reasons are closed codes and never contain the input.
 *
 * The provenance marker records `via: gateway` with the host only. It never
 * carries the key, the path prefix or the full URL.
 */
import type { GatewayClientId } from '../config.js';

export type GatewayRefusalReason =
  | 'config-invalid'
  | 'entry-invalid'
  | 'unknown-key'
  | 'base-url-invalid'
  | 'scheme-not-allowed'
  | 'userinfo-not-allowed'
  | 'query-not-allowed'
  | 'fragment-not-allowed'
  | 'host-not-canonical'
  | 'loopback-name-not-allowed'
  | 'ip-literal-not-allowed'
  | 'http-requires-loopback'
  | 'port-invalid'
  | 'path-not-allowed'
  | 'allowlist-invalid'
  | 'host-not-allowlisted';

export interface FirstPartyTarget {
  readonly kind: 'first-party';
}

export interface GatewayTarget {
  readonly kind: 'gateway';
  readonly client: GatewayClientId;
  /** `scheme://host[:port]` as normalized by URL. */
  readonly origin: string;
  /** Path prefix with no trailing slash; '' when none. */
  readonly prefix: string;
  /** Canonical hostname (IPv6 in brackets). */
  readonly host: string;
  /** Effective port, including the scheme default. */
  readonly port: number;
  readonly loopback: boolean;
}

export type GatewayResolution =
  | { readonly ok: true; readonly target: FirstPartyTarget | GatewayTarget }
  | { readonly ok: false; readonly reason: GatewayRefusalReason };

/** Value-free provenance marker for ledger and audit records. */
export interface GatewayViaMarker {
  readonly via: 'gateway';
  readonly host: string;
}

const FIRST_PARTY: FirstPartyTarget = Object.freeze({ kind: 'first-party' });
const ENTRY_KEYS = new Set(['enabled', 'baseUrl', 'allowedHosts']);
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '[::1]']);
const MAX_URL_LENGTH = 2048;
const MAX_ALLOWED_HOSTS = 64;
// Printable ASCII without space. Rejects whitespace, control characters and
// non-ASCII before URL parsing can silently strip or transcode them.
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;
const SAFE_PATH = /^[A-Za-z0-9._~\-/]*$/;
const IPV4_LITERAL = /^\d{1,3}(?:\.\d{1,3}){3}$/;

function refuse(reason: GatewayRefusalReason): GatewayResolution {
  return Object.freeze({ ok: false as const, reason });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

interface Authority {
  readonly host: string;
  readonly port: string | undefined;
}

/** Split a raw authority (no userinfo) into host and optional port text. */
function splitAuthority(raw: string): Authority | undefined {
  if (raw.startsWith('[')) {
    const close = raw.indexOf(']');
    if (close < 0) return undefined;
    const rest = raw.slice(close + 1);
    if (rest !== '' && !rest.startsWith(':')) return undefined;
    return { host: raw.slice(0, close + 1), port: rest === '' ? undefined : rest.slice(1) };
  }
  const colon = raw.lastIndexOf(':');
  if (colon < 0) return { host: raw, port: undefined };
  return { host: raw.slice(0, colon), port: raw.slice(colon + 1) };
}

function isIpLiteral(host: string): boolean {
  return host.startsWith('[') || IPV4_LITERAL.test(host);
}

function isLoopbackName(host: string): boolean {
  return host === 'localhost' || host.endsWith('.localhost');
}

/**
 * Normalize one `allowedHosts` entry to `host:port`. The port is required and
 * the host must already be canonical, so `Gw.Example.com:443` is accepted as
 * `gw.example.com:443` but `gw.example.com`, `*.example.com` and
 * `gw.example.com.:443` are not.
 */
function normalizeAllowEntry(entry: unknown): string | undefined {
  if (typeof entry !== 'string' || entry.length === 0 || entry.length > 300) return undefined;
  if (!PRINTABLE_ASCII.test(entry) || /[/?#@\\%*]/.test(entry)) return undefined;
  const parts = splitAuthority(entry);
  if (!parts || parts.port === undefined || !/^\d{1,5}$/.test(parts.port)) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(`https://${entry}/`);
  } catch {
    return undefined;
  }
  const host = parts.host.toLowerCase();
  if (parsed.hostname !== host || host === '' || host.endsWith('.')) return undefined;
  if (isIpLiteral(host) || isLoopbackName(host)) return undefined;
  const port = Number(parts.port);
  if (port < 1 || port > 65535) return undefined;
  return `${host}:${port}`;
}

/**
 * Validate a gateway `baseUrl` (and its allowlist) for one client. Pure: no
 * I/O, no env, no DNS. Returns a frozen target or a closed refusal reason.
 */
export function validateGatewayBaseUrl(
  client: GatewayClientId,
  baseUrl: unknown,
  allowedHosts: unknown,
): GatewayResolution {
  if (typeof baseUrl !== 'string' || baseUrl.length === 0 || baseUrl.length > MAX_URL_LENGTH) {
    return refuse('base-url-invalid');
  }
  if (!PRINTABLE_ASCII.test(baseUrl) || baseUrl.includes('\\')) return refuse('base-url-invalid');
  const head = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(baseUrl);
  if (!head) return refuse('base-url-invalid');
  const scheme = head[1]!.toLowerCase();
  if (scheme !== 'https' && scheme !== 'http') return refuse('scheme-not-allowed');
  const rest = baseUrl.slice(head[0].length);
  if (!rest.startsWith('//')) return refuse('base-url-invalid');
  if (baseUrl.includes('#')) return refuse('fragment-not-allowed');
  if (baseUrl.includes('?')) return refuse('query-not-allowed');

  const afterSlashes = rest.slice(2);
  const slash = afterSlashes.indexOf('/');
  const rawAuthority = slash < 0 ? afterSlashes : afterSlashes.slice(0, slash);
  const rawPath = slash < 0 ? '' : afterSlashes.slice(slash);
  if (rawAuthority.includes('@')) return refuse('userinfo-not-allowed');

  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return refuse('base-url-invalid');
  }
  if (parsed.username !== '' || parsed.password !== '') return refuse('userinfo-not-allowed');
  if (parsed.search !== '') return refuse('query-not-allowed');
  if (parsed.hash !== '') return refuse('fragment-not-allowed');

  const parts = splitAuthority(rawAuthority);
  if (!parts) return refuse('host-not-canonical');
  const host = parts.host.toLowerCase();
  // URL silently rewrites trailing dots, numeric shorthands (0x7f.1,
  // 2130706433), percent-encoding and IDNA. Require the raw text to already be
  // the canonical form so the allowlist compares what the operator wrote.
  if (host === '' || parsed.hostname !== host || host.endsWith('.')) return refuse('host-not-canonical');

  if (parts.port !== undefined && !/^\d{1,5}$/.test(parts.port)) return refuse('port-invalid');
  const defaultPort = scheme === 'https' ? 443 : 80;
  const port = parsed.port === '' ? defaultPort : Number(parsed.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return refuse('port-invalid');
  if (parts.port !== undefined && Number(parts.port) !== port) return refuse('port-invalid');

  const loopback = LOOPBACK_HOSTS.has(host);
  if (!loopback) {
    if (isLoopbackName(host)) return refuse('loopback-name-not-allowed');
    if (isIpLiteral(host)) return refuse('ip-literal-not-allowed');
    if (scheme !== 'https') return refuse('http-requires-loopback');
  }

  if (!SAFE_PATH.test(rawPath)) return refuse('path-not-allowed');
  const trimmed = rawPath.replace(/\/+$/, '');
  if (trimmed !== '') {
    const segments = trimmed.slice(1).split('/');
    if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
      return refuse('path-not-allowed');
    }
  }
  if (rawPath.length > 1 && /\/\/+$/.test(rawPath)) return refuse('path-not-allowed');
  if (parsed.pathname.replace(/\/+$/, '') !== trimmed) return refuse('path-not-allowed');

  if (allowedHosts !== undefined) {
    if (!Array.isArray(allowedHosts) || allowedHosts.length > MAX_ALLOWED_HOSTS) return refuse('allowlist-invalid');
    const normalized: string[] = [];
    for (const entry of allowedHosts) {
      const value = normalizeAllowEntry(entry);
      if (value === undefined) return refuse('allowlist-invalid');
      normalized.push(value);
    }
    if (!loopback && !normalized.includes(`${host}:${port}`)) return refuse('host-not-allowlisted');
  } else if (!loopback) {
    return refuse('host-not-allowlisted');
  }

  const target: GatewayTarget = Object.freeze({
    kind: 'gateway' as const,
    client,
    origin: parsed.origin,
    prefix: trimmed,
    host,
    port,
    loopback,
  });
  return Object.freeze({ ok: true as const, target });
}

/**
 * Resolve the target for one governed client from the raw top-level
 * `gateways` config value. Absent block, absent entry, or `enabled` not
 * literally `true` resolves to first-party. A present but malformed block,
 * or an opted-in entry that fails validation, refuses (fails closed) rather
 * than silently falling back.
 */
export function resolveGatewayTarget(client: GatewayClientId, gateways: unknown): GatewayResolution {
  if (gateways === undefined || gateways === null) return Object.freeze({ ok: true as const, target: FIRST_PARTY });
  if (!isPlainObject(gateways)) return refuse('config-invalid');
  if (!Object.prototype.hasOwnProperty.call(gateways, client)) {
    return Object.freeze({ ok: true as const, target: FIRST_PARTY });
  }
  const entry = gateways[client];
  if (entry === undefined || entry === null) return Object.freeze({ ok: true as const, target: FIRST_PARTY });
  if (!isPlainObject(entry)) return refuse('entry-invalid');
  if (Object.keys(entry).some((key) => !ENTRY_KEYS.has(key))) return refuse('unknown-key');
  if (entry['enabled'] !== true) return Object.freeze({ ok: true as const, target: FIRST_PARTY });
  return validateGatewayBaseUrl(client, entry['baseUrl'], entry['allowedHosts']);
}

/**
 * Build the request URL for a gateway target and a fixed client API path such
 * as `/v1/messages`. The path is a constant owned by the client, never caller
 * input; it must be a clean absolute path.
 */
export function gatewayRequestUrl(target: GatewayTarget, apiPath: string): string {
  if (!/^\/[A-Za-z0-9._~\-/]*$/.test(apiPath) || apiPath.includes('//')
    || apiPath.split('/').some((segment) => segment === '.' || segment === '..')) {
    throw new Error('gateway api path invalid');
  }
  return `${target.origin}${target.prefix}${apiPath}`;
}

/** Provenance marker: `via: gateway` plus the host. Never the key or URL. */
export function gatewayViaMarker(target: GatewayTarget): GatewayViaMarker {
  return Object.freeze({ via: 'gateway' as const, host: target.host });
}

/**
 * Audit summary suffix for a run of a governed client: ` via=gateway host=<host>`
 * when config routes it through a valid gateway, '' for first-party. Host only,
 * never the key, port, URL or path. A remote (non-loopback) target, which the
 * clients refuse in this slice, gives ` gateway=refused reason=non-loopback`
 * with no host. An invalid config adds nothing here because the client itself
 * refuses before any contact.
 */
export function gatewayAuditSuffix(client: GatewayClientId, gateways: unknown): string {
  const resolved = resolveGatewayTarget(client, gateways);
  if (!resolved.ok || resolved.target.kind !== 'gateway') return '';
  // This slice is loopback only: the clients refuse a remote https target
  // before any contact, so the audit records that refusal (value-free, no
  // host) and never a `via=gateway` line for a host that was not used.
  if (!resolved.target.loopback) return ' gateway=refused reason=non-loopback';
  return ` via=gateway host=${resolved.target.host}`;
}
