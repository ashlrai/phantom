/**
 * Shared HTTP request/response helpers for Verse API modules.
 *
 * Centralizes standard Verse error responses (`VERSE_INVALID`, `VERSE_REFUSED`,
 * `VERSE_TOO_LARGE`), strict query-parameter validation, and the mutation
 * dispatch/token/JSON-object gate so route modules stay thin and consistent.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import { passesMutationGate, readBody, sendJson } from '../web/api-http-helpers.js';

export interface MutationGateContext {
  allowDispatch: boolean;
  token: string;
}

export interface ReadQueryOptions {
  /** Query parameters permitted to appear more than once when `rejectRepeats` is true. */
  repeatable?: readonly string[];
  /** Reject repeated query parameters outside `repeatable` (default: false). */
  rejectRepeats?: boolean;
  /** Truncate echoed unknown query parameter names to at most this many characters. */
  maxKeyChars?: number;
}

export interface ReadMutationBodyOptions {
  /** Maximum request body size in bytes (defaults to `readBody`'s 64 KiB cap). */
  maxBytes?: number;
  /** Treat an empty body as `{}` (default: true). */
  allowEmpty?: boolean;
  /** Trim whitespace before checking emptiness when `allowEmpty` is true (default: false). */
  trimEmpty?: boolean;
  /** Reject any top-level body key outside this allowlist with 400 `VERSE_INVALID`. */
  allowedKeys?: readonly string[];
  /** Reject any query parameters before reading the body (default: false). */
  requireNoQuery?: boolean;
  /** Truncate echoed unknown query parameter names when `requireNoQuery` is true. */
  maxQueryKeyChars?: number;
}

/** Respond with a 400 `VERSE_INVALID` JSON error. */
export function sendInvalid(res: ServerResponse, message: string): void {
  sendJson(res, 400, { code: 'VERSE_INVALID', error: message });
}

/** Respond with a 409 `VERSE_REFUSED` JSON error. */
export function sendRefused(res: ServerResponse, reason: string): void {
  sendJson(res, 409, { code: 'VERSE_REFUSED', error: reason });
}

/**
 * Parse and validate `req.url`'s query parameters against `allowed`.
 * Returns `null` after sending a 400 `VERSE_INVALID` response on malformed
 * query strings, unknown parameters, or disallowed repeats.
 */
export function readAllowedQuery(
  req: IncomingMessage,
  res: ServerResponse,
  allowed: readonly string[],
  options: ReadQueryOptions = {},
): URLSearchParams | null {
  let params: URLSearchParams;
  try {
    params = new URL(req.url ?? '/', 'http://localhost').searchParams;
  } catch {
    sendInvalid(res, 'invalid query string');
    return null;
  }
  const {
    repeatable = [],
    rejectRepeats = false,
    maxKeyChars,
  } = options;
  const seen = new Set<string>();
  for (const key of params.keys()) {
    if (!allowed.includes(key)) {
      const shown = maxKeyChars === undefined ? key : key.slice(0, maxKeyChars);
      sendInvalid(res, `unknown query parameter: ${shown}`);
      return null;
    }
    if (rejectRepeats && !repeatable.includes(key) && seen.has(key)) {
      sendInvalid(res, `query parameter ${key} may appear only once`);
      return null;
    }
    seen.add(key);
  }
  return params;
}

/** Reject any query parameter on `req` with 400 `VERSE_INVALID`. */
export function hasNoQuery(
  req: IncomingMessage,
  res: ServerResponse,
  maxKeyChars?: number,
): boolean {
  return readAllowedQuery(req, res, [], { maxKeyChars }) !== null;
}

/**
 * Enforce the standard Verse mutation gate (404 when dispatch is disabled,
 * constant-time mutation token + JSON content-type via `passesMutationGate`,
 * optional empty-query check) and parse a bounded JSON object body.
 * Returns `null` after sending the error response on any failure.
 */
export async function readMutationBody(
  ctx: MutationGateContext,
  req: IncomingMessage,
  res: ServerResponse,
  options: ReadMutationBodyOptions = {},
): Promise<Record<string, unknown> | null> {
  if (!ctx.allowDispatch) {
    sendJson(res, 404, { error: 'not found' });
    return null;
  }
  if (!passesMutationGate(req, res, ctx.token)) return null;
  if (options.requireNoQuery && !hasNoQuery(req, res, options.maxQueryKeyChars)) return null;

  let raw: string;
  try {
    raw = await readBody(req, options.maxBytes);
  } catch {
    sendJson(res, 413, { code: 'VERSE_TOO_LARGE', error: 'request body too large' });
    return null;
  }

  const allowEmpty = options.allowEmpty ?? true;
  const isEmpty = options.trimEmpty ? raw.trim().length === 0 : raw.length === 0;
  let parsed: unknown;
  try {
    parsed = allowEmpty && isEmpty ? {} : (JSON.parse(raw) as unknown);
  } catch {
    sendInvalid(res, 'invalid JSON body');
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    sendInvalid(res, 'body must be a JSON object');
    return null;
  }

  const body = parsed as Record<string, unknown>;
  if (options.allowedKeys !== undefined) {
    for (const key of Object.keys(body)) {
      if (!options.allowedKeys.includes(key)) {
        sendInvalid(res, `unknown key: ${key.slice(0, 64)}`);
        return null;
      }
    }
  }
  return body;
}
