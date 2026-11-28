/**
 * Shared HTTP request/response helpers for Verse API route modules.
 * Purely async / in-memory — never performs synchronous filesystem or process I/O.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { VerseApiContext } from './verse-api.js';
import { passesMutationGate, readBody, sendJson } from '../web/api-http-helpers.js';

export interface ReadMutationBodyOptions {
  /** Maximum request body size in bytes (defaults to readBody's 64 KiB cap). */
  maxBytes?: number;
  /** Reject any query parameters before reading the body. */
  rejectQuery?: boolean;
}

/** Write a 400 VERSE_INVALID JSON response. */
export function sendInvalid(res: ServerResponse, message: string): void {
  sendJson(res, 400, { code: 'VERSE_INVALID', error: message });
}

/** Parse query parameters and refuse any parameter outside `allowed`. */
export function readQuery(req: IncomingMessage, res: ServerResponse, allowed: readonly string[]): URLSearchParams | null {
  let params: URLSearchParams;
  try { params = new URL(req.url ?? '/', 'http://localhost').searchParams; }
  catch { sendInvalid(res, 'invalid query string'); return null; }
  for (const key of params.keys()) {
    if (!allowed.includes(key)) { sendInvalid(res, `unknown query parameter: ${key}`); return null; }
  }
  return params;
}

/** Refuse any query parameter on routes that accept none. */
export function hasNoQuery(req: IncomingMessage, res: ServerResponse): boolean {
  return readQuery(req, res, []) !== null;
}

/**
 * Guard and parse a Verse mutation body: 404 without dispatch, mutation-token +
 * JSON Content-Type gate, optional empty-query check, bounded body read (413),
 * and strict JSON-object parse (400).
 */
export async function readMutationBody(
  ctx: Pick<VerseApiContext, 'allowDispatch' | 'token'>,
  req: IncomingMessage,
  res: ServerResponse,
  opts: ReadMutationBodyOptions = {},
): Promise<Record<string, unknown> | null> {
  if (!ctx.allowDispatch) { sendJson(res, 404, { error: 'not found' }); return null; }
  if (!passesMutationGate(req, res, ctx.token)) return null;
  if (opts.rejectQuery && !hasNoQuery(req, res)) return null;
  let raw: string;
  try { raw = await readBody(req, opts.maxBytes); }
  catch { sendJson(res, 413, { code: 'VERSE_TOO_LARGE', error: 'request body too large' }); return null; }
  let parsed: unknown;
  try { parsed = raw.length === 0 ? {} : (JSON.parse(raw) as unknown); }
  catch { sendInvalid(res, 'invalid JSON body'); return null; }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    sendInvalid(res, 'body must be a JSON object');
    return null;
  }
  return parsed as Record<string, unknown>;
}
