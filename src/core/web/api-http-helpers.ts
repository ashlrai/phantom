import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sanitizePublicJson } from '../util/public-json.js';

/** Write a JSON response. Never throws. */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  try {
    const boundedBody = body && typeof body === 'object' && 'error' in body && (body as { error: unknown }).error != null
      ? { ...body, error: String((body as { error: unknown }).error).slice(0, 512) }
      : body;
    const payload = JSON.stringify(sanitizePublicJson(boundedBody) ?? null);
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    res.end(payload);
  } catch {
    try {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
      }
      res.end('{"error":"internal error"}');
    } catch {
      // Socket already closed — swallow.
    }
  }
}

export const DEFAULT_MAX_BODY_BYTES = 65_536;

/** Read a bounded request body, decoding UTF-8 once after all chunks arrive. */
/**
 * Buffer chunks as bytes and decode once so split multi-byte UTF-8 characters
 * remain intact.
 */
export function readBody(req: IncomingMessage, maxBytes: number = DEFAULT_MAX_BODY_BYTES): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let tooLarge = false;

    req.on('data', (chunk: Buffer | string) => {
      if (tooLarge) return;
      const b = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
      total += b.length;
      if (total > maxBytes) {
        tooLarge = true;
        chunks.length = 0;
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(b);
    });
    req.on('end', () => { if (!tooLarge) resolve(Buffer.concat(chunks).toString('utf8')); });
    req.on('error', reject);
  });
}

/** Read a request header, collapsing Node's repeated-header array to its first entry. */
function headerValue(req: IncomingMessage, name: string): string {
  const raw = req.headers[name];
  if (Array.isArray(raw)) return raw[0] ?? '';
  return raw ?? '';
}

function safeEqual(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, 'utf8');
    const bb = Buffer.from(b, 'utf8');
    if (ba.length !== bb.length) return false;
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

/** Require the shared token and JSON content type before dispatching a mutation. */
export function passesMutationGate(req: IncomingMessage, res: ServerResponse, token: string): boolean {
  if (!safeEqual(headerValue(req, 'x-ashlr-token'), token)) {
    sendJson(res, 401, { error: 'unauthorized: missing or invalid x-ashlr-token' });
    return false;
  }
  const contentType = headerValue(req, 'content-type');
  if (!contentType.toLowerCase().trim().startsWith('application/json')) {
    sendJson(res, 415, { error: 'Content-Type must be application/json' });
    return false;
  }
  return true;
}
