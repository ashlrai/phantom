/** The loopback OpenAI-compatible endpoint. It binds 127.0.0.1 only (there
 * is no host option), refuses requests whose Host or Origin is not loopback
 * (DNS rebinding, cross-site POSTs), and requires the bearer token from a
 * 0600 file under ~/.ashlr/router so another local user or a browser tab
 * cannot spend the owner's seats. Every completion goes through the same
 * `routedComplete` the CLI and MCP tool use.
 *
 * Supported: GET /v1/models, POST /v1/chat/completions (text messages;
 * `stream: true` returns the finished answer as one SSE chunk), GET /healthz.
 * Tool calls and images are refused with a clear error rather than ignored. */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { isLocalClientRequest } from '../local-runtime/llama/anthropic-proxy.js';
import { isLoopbackHost } from '../local-runtime/llama/config.js';
import { routerGatewayDir } from './config.js';
import type { RoutedCompletionRequest, RoutedCompletionResult, RouterModelEntry } from './complete.js';

export const ROUTER_GATEWAY_HOST = '127.0.0.1';
export const ROUTER_GATEWAY_SCHEMA = 'router.gateway.v1';
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const TOKEN = /^[a-f0-9]{64}$/;

export function routerGatewayTokenPath(): string {
  return join(routerGatewayDir(), 'token');
}

/** Read the gateway token, creating it (0600, in a 0700 dir) on first use. Never logged or printed. */
export function ensureRouterGatewayToken(path = routerGatewayTokenPath()): string {
  if (existsSync(path)) {
    const mode = statSync(path).mode & 0o777;
    if (mode & 0o077) chmodSync(path, 0o600);
    const value = readFileSync(path, 'utf8').trim();
    if (TOKEN.test(value)) return value;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const value = randomBytes(32).toString('hex');
  writeFileSync(path, `${value}\n`, { mode: 0o600 });
  chmodSync(path, 0o600);
  return value;
}

export interface RouterGatewayHandlers {
  complete(req: RoutedCompletionRequest): Promise<RoutedCompletionResult>;
  models(): Promise<RouterModelEntry[]>;
}

export interface RouterGatewayServerOptions {
  port: number;
  token: string;
  maxConcurrent: number;
  handlers: RouterGatewayHandlers;
  now?: () => number;
}

export interface RunningRouterGateway {
  server: Server;
  url: string;
  port: number;
  close(): Promise<void>;
}

class BadRequest extends Error {}

function send(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function sendError(res: ServerResponse, status: number, message: string, code: string): void {
  send(res, status, { error: { message, type: status >= 500 ? 'server_error' : 'invalid_request_error', code } });
}

function authorized(req: IncomingMessage, token: string): boolean {
  const header = req.headers['authorization'];
  if (typeof header !== 'string') return false;
  const match = /^Bearer\s+(\S+)$/i.exec(header.trim());
  if (!match) return false;
  const given = Buffer.from(match[1]!);
  const expected = Buffer.from(token);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new BadRequest(`Request body is larger than ${MAX_BODY_BYTES} bytes.`);
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new BadRequest('Request body is not valid JSON.');
  }
}

function textOf(content: unknown, where: string): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content.map((part, i) => {
      const p = part as { type?: unknown; text?: unknown } | null;
      if (!p || p.type !== 'text' || typeof p.text !== 'string') throw new BadRequest(`${where}[${i}]: only text content is supported.`);
      return p.text;
    }).join('\n');
  }
  if (content === null || content === undefined) return '';
  throw new BadRequest(`${where}: content must be a string or a list of text parts.`);
}

/** OpenAI chat messages → one system text and one prompt. A multi-turn chat becomes a labelled transcript. */
export function flattenChatMessages(messages: unknown): { system: string; prompt: string } {
  if (!Array.isArray(messages) || messages.length === 0) throw new BadRequest('messages must be a non-empty list.');
  if (messages.length > 500) throw new BadRequest('messages lists more than 500 entries.');
  const system: string[] = [];
  const turns: Array<{ role: 'user' | 'assistant'; text: string }> = [];
  messages.forEach((raw, i) => {
    const m = raw as { role?: unknown; content?: unknown; tool_calls?: unknown } | null;
    if (!m || typeof m !== 'object') throw new BadRequest(`messages[${i}] must be an object.`);
    const text = textOf(m.content, `messages[${i}].content`);
    if (m.role === 'system' || m.role === 'developer') system.push(text);
    else if (m.role === 'user' || m.role === 'assistant') {
      if (m.tool_calls !== undefined) throw new BadRequest('Tool calls are not supported by the router gateway.');
      turns.push({ role: m.role, text });
    } else throw new BadRequest(`messages[${i}].role must be system, developer, user or assistant.`);
  });
  const last = turns.at(-1);
  if (!last || last.role !== 'user') throw new BadRequest('The last message must be from the user.');
  const prompt = turns.length === 1
    ? last.text
    : turns.map((t) => `${t.role === 'user' ? 'User' : 'Assistant'}:\n${t.text}`).join('\n\n');
  return { system: system.join('\n\n'), prompt };
}

/** The OpenAI fields the gateway honours; anything that would silently change meaning is refused. */
export function parseChatRequest(body: unknown): { request: Omit<RoutedCompletionRequest, 'signal'>; stream: boolean } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequest('Request body must be a JSON object.');
  const b = body as Record<string, unknown>;
  if (typeof b['model'] !== 'string' || b['model'].length === 0) throw new BadRequest('model is required ("auto", "<lane>:<model>" or an alias).');
  for (const field of ['tools', 'functions', 'tool_choice', 'function_call']) {
    if (b[field] !== undefined && b[field] !== null && !(Array.isArray(b[field]) && (b[field] as unknown[]).length === 0)) {
      throw new BadRequest('Tool calls are not supported by the router gateway.');
    }
  }
  if (b['n'] !== undefined && b['n'] !== 1) throw new BadRequest('n must be 1.');
  if (b['stream'] !== undefined && typeof b['stream'] !== 'boolean') throw new BadRequest('stream must be a boolean.');
  const cap = b['max_completion_tokens'] ?? b['max_tokens'];
  if (cap !== undefined && cap !== null && (typeof cap !== 'number' || !Number.isSafeInteger(cap) || cap < 1)) {
    throw new BadRequest('max_tokens must be a positive whole number.');
  }
  const { system, prompt } = flattenChatMessages(b['messages']);
  const request: Omit<RoutedCompletionRequest, 'signal'> = { model: b['model'], system, prompt };
  if (typeof cap === 'number') request.maxOutputTokens = Math.min(cap, 128_000);
  return { request, stream: b['stream'] === true };
}

const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

function statusOf(result: Extract<RoutedCompletionResult, { ok: false }>): number {
  switch (result.status) {
    case 'bad-request': return 400;
    case 'no-route': return 503;
    case 'cancelled': return 499;
    default: return 502;
  }
}

function completionBody(result: Extract<RoutedCompletionResult, { ok: true }>, id: string, created: number, promptChars: number): unknown {
  const promptTokens = Math.ceil(promptChars / 4);
  const completionTokens = estimateTokens(result.text);
  return {
    id, object: 'chat.completion', created, model: `${result.seatId}:${result.model}`,
    choices: [{ index: 0, message: { role: 'assistant', content: result.text }, finish_reason: 'stop' }],
    // Lane CLIs do not all report tokens; these are 4-chars-per-token estimates (phantom.usageEstimated).
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens, total_tokens: promptTokens + completionTokens },
    phantom: phantomExtension(result),
  };
}

function phantomExtension(result: Extract<RoutedCompletionResult, { ok: true }>): unknown {
  return {
    schema: result.schema, requested: result.requested, route: result.route, seatId: result.seatId, engine: result.engine,
    model: result.model, why: result.decision?.why ?? null, attempts: result.attempts, elapsedMs: result.elapsedMs, usageEstimated: true,
  };
}

function sendStream(res: ServerResponse, result: Extract<RoutedCompletionResult, { ok: true }>, id: string, created: number): void {
  const model = `${result.seatId}:${result.model}`;
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store', connection: 'close' });
  const chunk = (delta: unknown, finish: string | null, extra: Record<string, unknown> = {}): string =>
    `data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;
  res.write(chunk({ role: 'assistant', content: result.text }, null));
  res.write(chunk({}, 'stop', { phantom: phantomExtension(result) }));
  res.end('data: [DONE]\n\n');
}

/** Start the endpoint on 127.0.0.1:`port` (0 = any free port, for tests). */
export async function startRouterGatewayServer(opts: RouterGatewayServerOptions): Promise<RunningRouterGateway> {
  if (!TOKEN.test(opts.token)) throw new Error('The router gateway token is malformed.');
  const now = opts.now ?? Date.now;
  let active = 0;
  const server = createServer((req, res) => {
    void (async () => {
      const path = (req.url ?? '/').split('?')[0];
      if (!isLocalClientRequest(req.headers)) { sendError(res, 403, 'Only loopback clients may use the router gateway.', 'not_loopback'); return; }
      if (req.method === 'GET' && path === '/healthz') { send(res, 200, { ok: true, schema: ROUTER_GATEWAY_SCHEMA }); return; }
      if (!authorized(req, opts.token)) { sendError(res, 401, 'Missing or wrong bearer token (see ~/.ashlr/router/token).', 'unauthorized'); return; }
      if (req.method === 'GET' && (path === '/v1/models' || path === '/models')) {
        const rows = await opts.handlers.models();
        send(res, 200, { object: 'list', data: rows.map((row) => ({ id: row.id, object: 'model', created: 0, owned_by: 'phantom', phantom: row })) });
        return;
      }
      if (path !== '/v1/chat/completions' && path !== '/chat/completions') { sendError(res, 404, 'Not found.', 'not_found'); return; }
      if (req.method !== 'POST') { sendError(res, 405, 'Use POST.', 'method_not_allowed'); return; }
      if (active >= opts.maxConcurrent) { sendError(res, 429, 'The router gateway is at its concurrency limit; retry shortly.', 'busy'); return; }
      active++;
      const abort = new AbortController();
      res.on('close', () => { if (!res.writableFinished) abort.abort(); });
      try {
        let parsed: ReturnType<typeof parseChatRequest>;
        try {
          parsed = parseChatRequest(await readBody(req));
        } catch (error) {
          if (error instanceof BadRequest) { sendError(res, 400, error.message, 'bad_request'); return; }
          throw error;
        }
        const result = await opts.handlers.complete({ ...parsed.request, signal: abort.signal });
        if (abort.signal.aborted || res.destroyed) return;
        if (!result.ok) {
          send(res, statusOf(result), { error: { message: result.reason, type: result.status === 'bad-request' ? 'invalid_request_error' : 'server_error', code: result.status }, phantom: result });
          return;
        }
        const id = `chatcmpl-${randomUUID()}`;
        const created = Math.floor(now() / 1000);
        if (parsed.stream) sendStream(res, result, id, created);
        else send(res, 200, completionBody(result, id, created, parsed.request.system.length + parsed.request.prompt.length));
      } finally {
        active--;
      }
    })().catch(() => {
      if (!res.headersSent) sendError(res, 500, 'The router gateway failed to handle the request.', 'internal');
      else res.destroy();
    });
  });
  server.requestTimeout = 0;
  server.headersTimeout = 30_000;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port, ROUTER_GATEWAY_HOST, () => { server.off('error', reject); resolve(); });
  });
  const address = server.address() as AddressInfo;
  if (!isLoopbackHost(address.address)) {
    server.close();
    throw new Error('The router gateway refused to run on a non-loopback address.');
  }
  return {
    server,
    port: address.port,
    url: `http://${ROUTER_GATEWAY_HOST}:${address.port}/v1`,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections?.(); server.close(() => resolve()); }),
  };
}
