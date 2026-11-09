/**
 * RQ-SWE5-AGENT-SWARM — loopback-only spawn ingest API.
 *
 * A small intake surface beside `phm queue spawn`: dispatchd-side peers POST
 * a spawn.v1 proposal to `POST /v1/spawn` and get back a `spawn-result.v1`
 * JSON receipt of job ids and duplicate skips. The listener binds 127.0.0.1
 * only, requires a `Bearer` token read from the operator-owned token file,
 * and is value-blind: request bodies are never logged and error responses
 * carry rejection codes only — scope, acceptance and dep text never leaves
 * in a response. Every applied proposal goes through the same fail-closed
 * planner as the CLI (`decompose.ts`): schema, dedup, rate limit, depth cap
 * and the no-escalation rules are identical on both surfaces.
 */
import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { lstat, mkdir, open, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { headerValue, isAllowedHost, requestUrl, safeEqual, sendJson } from '../web/read-session.js';
import { SpawnRejection, type SpawnResult } from './decompose.js';

export const SPAWN_INGEST_PATH = '/v1/spawn';
export const SPAWN_INGEST_HEALTH = '/v1/health';
export const SPAWN_INGEST_MAX_BODY = 64 * 1024;

export interface SpawnIngestOptions {
  /** Applies a validated proposal — typically `store.propose`. */
  apply: (proposal: unknown) => Promise<SpawnResult>;
  /** Bearer credential the loopback peer must present (from the token file). */
  token: string;
  /** Port to bind; 0 picks an ephemeral port (reported on the handle). */
  port?: number;
  maxBodyBytes?: number;
}

export interface SpawnIngest {
  /** Bound port on 127.0.0.1. */
  port: number;
  close(): Promise<void>;
}

/**
 * Read the ingest bearer token from `path`, or create it mode 0600 when
 * absent. An existing file must be a regular, owner-only file holding a
 * hex token — anything else fails closed. The value is returned to the
 * caller only; it is never printed or logged.
 */
export async function loadOrCreateIngestToken(path: string): Promise<string> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error('Ingest token must be a regular file');
    if ((info.mode & 0o077) !== 0) throw new Error('Ingest token file must be mode 0600');
    const token = (await readFile(path, 'utf8')).trim();
    if (!/^[a-f0-9]{32,128}$/.test(token)) throw new Error('Invalid ingest token shape');
    return token;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const token = randomBytes(24).toString('hex');
    const file = await open(path, 'wx', 0o600);
    try { await file.writeFile(`${token}\n`); } finally { await file.close(); }
    return token;
  }
}

function rejectionStatus(code: string): number {
  if (code === 'invalid-document') return 400;
  if (code === 'rate-limited') return 429;
  return 422;
}

/** Bounded body read: drains the stream but keeps only the first `cap` bytes. */
async function readBody(req: IncomingMessage, cap: number): Promise<{ text: string; oversize: boolean }> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size <= cap) chunks.push(chunk);
  }
  return { text: Buffer.concat(chunks).toString('utf8'), oversize: size > cap };
}

/**
 * Create the loopback ingest server. Only `POST /v1/spawn` mutates;
 * `GET /v1/health` answers a liveness probe without revealing anything.
 */
export async function createSpawnIngest(options: SpawnIngestOptions): Promise<SpawnIngest> {
  if (typeof options.token !== 'string' || !/^[a-f0-9]{32,128}$/.test(options.token)) {
    throw new Error('Spawn ingest requires a hex bearer token (32-128 chars)');
  }
  const maxBody = options.maxBodyBytes ?? SPAWN_INGEST_MAX_BODY;
  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    res.setHeader('Referrer-Policy', 'no-referrer');
    void (async () => {
      if (!isAllowedHost(req.headers.host)) return sendJson(res, 403, { error: 'forbidden' });
      const url = requestUrl(req);
      if (url === null) return sendJson(res, 400, { error: 'invalid-request' });
      if (req.method === 'GET' && url.pathname === SPAWN_INGEST_HEALTH) return sendJson(res, 200, { ok: true });
      if (req.method !== 'POST' || url.pathname !== SPAWN_INGEST_PATH) return sendJson(res, 404, { error: 'not-found' });
      const presented = headerValue(req, 'authorization').replace(/^Bearer /, '');
      if (presented === '' || !safeEqual(presented, options.token)) return sendJson(res, 401, { error: 'unauthorized' });
      const type = headerValue(req, 'content-type').split(';')[0]!.trim().toLowerCase();
      if (type !== 'application/json') return sendJson(res, 415, { error: 'unsupported-media-type' });
      const declared = Number(headerValue(req, 'content-length'));
      if (Number.isFinite(declared) && declared > maxBody) return sendJson(res, 413, { error: 'too-large' });
      const body = await readBody(req, maxBody);
      if (body.oversize) return sendJson(res, 413, { error: 'too-large' });
      let proposal: unknown;
      try { proposal = JSON.parse(body.text); } catch { return sendJson(res, 400, { error: 'bad-json' }); }
      try {
        return sendJson(res, 200, await options.apply(proposal));
      } catch (error) {
        if (error instanceof SpawnRejection) return sendJson(res, rejectionStatus(error.code), { error: error.code });
        return sendJson(res, 500, { error: 'internal' });
      }
    })().catch(() => {
      if (!res.headersSent) sendJson(res, 500, { error: 'internal' });
      else res.end();
    });
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', () => {
      const address = server.address();
      if (address !== null && typeof address === 'object') resolve(address.port);
      else reject(new Error('Failed to determine bound port'));
    });
  });
  return {
    port,
    close: () => new Promise<void>((resolve, reject) => {
      server.close(error => (error === undefined ? resolve() : reject(error)));
    }),
  };
}
