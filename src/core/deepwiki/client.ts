/**
 * Minimal DeepWiki MCP client (streamable HTTP, JSON-RPC 2.0).
 *
 * Calls the read-only DeepWiki tools `read_wiki_structure`, `read_wiki_contents`
 * and `ask_question`. No credentials are sent or read: the public endpoint
 * serves indexed public repos, and a private repo only resolves once it is
 * connected in the owner's Devin account. Until then every failure maps to a
 * typed `unavailable` / `not_indexed` result so callers can degrade instead of
 * throwing. Wiki text is untrusted data, never instructions.
 */

export const DEEPWIKI_MCP_URL = 'https://mcp.deepwiki.com/mcp';
export const DEEPWIKI_TIMEOUT_MS = 15_000;
export const DEEPWIKI_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const NOT_INDEXED_RE = /not (?:found|indexed)|no (?:wiki|documentation)|has not been indexed|private repo/i;

export type DeepWikiResult =
  | { status: 'ok'; text: string }
  | { status: 'not_indexed'; reason: string }
  | { status: 'unavailable'; reason: string };

export interface DeepWikiClientOptions {
  endpoint?: string;
  timeoutMs?: number;
  maxResponseBytes?: number;
  fetchImpl?: typeof fetch;
}

export function isRepoName(value: string): boolean {
  return REPO_RE.test(value) && !value.split('/').some(part => part === '.' || part === '..');
}

/** https anywhere, plain http only on loopback. */
export function validateEndpoint(raw: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('DeepWiki endpoint is not a valid URL'); }
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error('DeepWiki endpoint must be https (http only on loopback)');
  }
  if (url.username || url.password) throw new Error('DeepWiki endpoint must not embed credentials');
  return url;
}

interface RpcMessage { id?: number; result?: unknown; error?: { message?: string } }

/** Parse a JSON body or an SSE stream into the JSON-RPC message with the given id. */
export function parseRpcBody(body: string, contentType: string, id: number): RpcMessage | undefined {
  const candidates: string[] = [];
  if (contentType.includes('text/event-stream')) {
    for (const event of body.split(/\r?\n\r?\n/)) {
      const data = event.split(/\r?\n/).filter(l => l.startsWith('data:')).map(l => l.slice(5).trimStart()).join('\n');
      if (data) candidates.push(data);
    }
  } else {
    candidates.push(body);
  }
  for (const raw of candidates) {
    try {
      const parsed = JSON.parse(raw) as RpcMessage | RpcMessage[];
      for (const msg of Array.isArray(parsed) ? parsed : [parsed]) if (msg?.id === id) return msg;
    } catch { /* skip non-JSON events */ }
  }
  return undefined;
}

async function readCapped(res: Response, cap: number): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > cap) { await reader.cancel(); throw new Error(`response exceeds ${cap} bytes`); }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export class DeepWikiClient {
  private readonly url: URL;
  private readonly timeoutMs: number;
  private readonly cap: number;
  private readonly doFetch: typeof fetch;
  private sessionId: string | undefined;
  private nextId = 1;
  private ready = false;

  constructor(options: DeepWikiClientOptions = {}) {
    this.url = validateEndpoint(options.endpoint ?? DEEPWIKI_MCP_URL);
    this.timeoutMs = options.timeoutMs ?? DEEPWIKI_TIMEOUT_MS;
    this.cap = options.maxResponseBytes ?? DEEPWIKI_MAX_RESPONSE_BYTES;
    this.doFetch = options.fetchImpl ?? fetch;
  }

  private async post(payload: object, id?: number): Promise<RpcMessage | undefined> {
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
    };
    if (this.sessionId) headers['mcp-session-id'] = this.sessionId;
    const res = await this.doFetch(this.url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      redirect: 'error',
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    const session = res.headers.get('mcp-session-id');
    if (session) this.sessionId = session;
    if (!res.ok) { await res.body?.cancel(); throw new Error(`HTTP ${res.status}`); }
    if (id === undefined) { await res.body?.cancel(); return undefined; }
    const msg = parseRpcBody(await readCapped(res, this.cap), res.headers.get('content-type') ?? '', id);
    if (!msg) throw new Error('no JSON-RPC response');
    return msg;
  }

  private async initialize(): Promise<void> {
    if (this.ready) return;
    const id = this.nextId++;
    const init = await this.post({
      jsonrpc: '2.0', id, method: 'initialize',
      params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'phantom-deepwiki', version: '1' } },
    }, id);
    if (init?.error) throw new Error(init.error.message ?? 'initialize failed');
    await this.post({ jsonrpc: '2.0', method: 'notifications/initialized' });
    this.ready = true;
  }

  /** Call one DeepWiki tool; never throws. */
  async callTool(name: string, args: Record<string, string>): Promise<DeepWikiResult> {
    try {
      await this.initialize();
      const id = this.nextId++;
      const msg = await this.post({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }, id);
      const result = msg?.result as { content?: { type?: string; text?: string }[]; isError?: boolean } | undefined;
      const text = (result?.content ?? []).filter(c => c.type === 'text' && typeof c.text === 'string').map(c => c.text).join('\n');
      const rpcError = msg?.error?.message;
      if (rpcError || result?.isError) {
        const reason = (rpcError ?? text ?? 'tool error').slice(0, 300);
        return NOT_INDEXED_RE.test(reason) ? { status: 'not_indexed', reason } : { status: 'unavailable', reason };
      }
      if (!text) return { status: 'unavailable', reason: 'empty tool response' };
      return NOT_INDEXED_RE.test(text.slice(0, 300)) && text.length < 600
        ? { status: 'not_indexed', reason: text.slice(0, 300) }
        : { status: 'ok', text };
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      return { status: 'unavailable', reason: reason.slice(0, 300) };
    }
  }

  readWikiStructure(repo: string): Promise<DeepWikiResult> { return this.callTool('read_wiki_structure', { repoName: repo }); }
  readWikiContents(repo: string): Promise<DeepWikiResult> { return this.callTool('read_wiki_contents', { repoName: repo }); }
  askQuestion(repo: string, question: string): Promise<DeepWikiResult> { return this.callTool('ask_question', { repoName: repo, question }); }
}
