import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DeepWikiClient, isRepoName, parseRpcBody, validateEndpoint } from '../src/core/deepwiki/client.js';
import { fetchDeepWikiContext, renderDeepWikiContext } from '../src/core/deepwiki/context.js';

const calls: { method: string; session?: string }[] = [];
function transport(onTool: (tool: string, args: Record<string, string>) => string, sse = false): typeof fetch {
  calls.length = 0;
  return (async (_input, init) => {
    const msg = JSON.parse(String(init?.body)) as { id?: number; method: string; params?: { name: string; arguments: Record<string, string> } };
    calls.push({ method: msg.method, session: (init?.headers as Record<string, string>)['mcp-session-id'] });
    if (msg.id === undefined) return new Response(null, { status: 202 });
    const result = msg.method === 'initialize' ? { protocolVersion: '2025-03-26' } : { content: [{ type: 'text', text: onTool(msg.params!.name, msg.params!.arguments) }] };
    const body = JSON.stringify({ jsonrpc: '2.0', id: msg.id, result });
    return new Response(sse ? `event: message\ndata: ${body}\n\n` : body, { headers: { 'content-type': sse ? 'text/event-stream' : 'application/json', 'mcp-session-id': 'sess-1' } });
  }) as typeof fetch;
}

describe('deepwiki client', () => {
  it('validates repo names and endpoints', () => {
    expect(isRepoName('ashlrai/phantom')).toBe(true);
    for (const bad of ['phantom', 'a/b/c', '../x', 'a/..', 'a b/c', '']) expect(isRepoName(bad)).toBe(false);
    expect(() => validateEndpoint('http://example.com/mcp')).toThrow(/https/);
    const credentialed = new URL('https://example.com/mcp');
    credentialed.username = 'user';
    credentialed.password = 'pass';
    expect(() => validateEndpoint(credentialed.href)).toThrow(/credentials/);
    expect(() => validateEndpoint('nope')).toThrow(/valid URL/);
    expect(validateEndpoint('http://127.0.0.1:1/mcp').hostname).toBe('127.0.0.1');
  });

  it('parses JSON and SSE bodies by id', () => {
    expect(parseRpcBody('{"id":2,"result":1}', 'application/json', 2)?.result).toBe(1);
    expect(parseRpcBody('data: {"id":1}\n\ndata: {"id":3,"result":"x"}\n\n', 'text/event-stream', 3)?.result).toBe('x');
    expect(parseRpcBody('garbage', 'application/json', 1)).toBeUndefined();
  });

  for (const sse of [false, true]) {
    it(`initializes a session then calls tools (${sse ? 'sse' : 'json'})`, async () => {
      const fetchImpl = transport((tool, args) => `${tool}:${args.repoName}:${args.question ?? ''}`, sse);
      const client = new DeepWikiClient({ fetchImpl });
      expect(await client.readWikiStructure('a/b')).toEqual({ status: 'ok', text: 'read_wiki_structure:a/b:' });
      expect(await client.askQuestion('a/b', 'why?')).toEqual({ status: 'ok', text: 'ask_question:a/b:why?' });
      expect(calls.map(c => c.method)).toEqual(['initialize', 'notifications/initialized', 'tools/call', 'tools/call']);
      expect(calls[2]!.session).toBe('sess-1');
    });
  }

  it('maps unindexed repos, HTTP errors and dead endpoints to typed results', async () => {
    const fetchImpl = transport(() => 'Repository not found. Visit deepwiki.com to index it.');
    expect((await new DeepWikiClient({ fetchImpl }).readWikiStructure('a/b')).status).toBe('not_indexed');
    const httpError = await new DeepWikiClient({ fetchImpl: async () => new Response(null, { status: 503 }) }).readWikiStructure('a/b');
    expect(httpError).toEqual({ status: 'unavailable', reason: 'HTTP 503' });
    const dead = await new DeepWikiClient({ fetchImpl: async () => { throw new Error('network unavailable'); } }).readWikiStructure('a/b');
    expect(dead.status).toBe('unavailable');
  });

  it('rejects oversized responses', async () => {
    const fetchImpl = transport(() => 'x'.repeat(5000));
    const r = await new DeepWikiClient({ fetchImpl, maxResponseBytes: 1000 }).readWikiStructure('a/b');
    expect(r).toMatchObject({ status: 'unavailable' });
  });
});

describe('fetchDeepWikiContext', () => {
  it('returns bounded structure, contents and answer', async () => {
    const fetchImpl = transport(tool => `${tool} ${'z'.repeat(4000)}`);
    const ctx = await fetchDeepWikiContext('a/b', { fetchImpl, contents: true, question: 'q', maxBytes: 3000 });
    expect(ctx.status).toBe('ok');
    expect(ctx.structure && ctx.contents && ctx.answer).toBeTruthy();
    expect(ctx.truncated).toBe(true);
    expect(Buffer.byteLength(ctx.structure!)).toBeLessThanOrEqual(1000);
    const text = renderDeepWikiContext(ctx);
    expect(text).toContain('untrusted reference data');
    expect(text).toContain('## Answer');
  });

  it('respects a small byte budget across all sections', async () => {
    const client = {
      readWikiStructure: async () => ({ status: 'ok' as const, text: 'x'.repeat(100) }),
      readWikiContents: async () => ({ status: 'ok' as const, text: 'y'.repeat(100) }),
      askQuestion: async () => ({ status: 'ok' as const, text: 'z'.repeat(100) }),
    } as unknown as DeepWikiClient;
    const ctx = await fetchDeepWikiContext('a/b', { client, contents: true, question: 'q', maxBytes: 30 });
    expect(Buffer.byteLength((ctx.structure ?? '') + (ctx.contents ?? '') + (ctx.answer ?? ''))).toBeLessThanOrEqual(30);
    expect(ctx.truncated).toBe(true);
  });

  it('degrades without throwing for bad repo, bad endpoint and unindexed repo', async () => {
    expect((await fetchDeepWikiContext('nope')).status).toBe('unavailable');
    expect((await fetchDeepWikiContext('a/b', { endpoint: 'http://example.com' })).reason).toMatch(/https/);
    const fetchImpl = transport(() => 'Repository not indexed');
    const ctx = await fetchDeepWikiContext('a/b', { fetchImpl });
    expect(ctx.status).toBe('not_indexed');
    expect(renderDeepWikiContext(ctx)).toContain('Proceed from the repository itself');
  });
});

describe('.devin/wiki.json', () => {
  it('stays within DeepWiki limits and has unique pages with real parents', () => {
    const cfg = JSON.parse(readFileSync(new URL('../.devin/wiki.json', import.meta.url), 'utf8')) as {
      repo_notes: { content: string }[]; pages: { title: string; purpose: string; parent?: string }[];
    };
    expect(cfg.pages.length).toBeLessThanOrEqual(30);
    expect(cfg.repo_notes.length).toBeLessThanOrEqual(100);
    for (const n of cfg.repo_notes) expect(n.content.length).toBeLessThanOrEqual(10_000);
    const titles = cfg.pages.map(p => p.title);
    expect(new Set(titles).size).toBe(titles.length);
    for (const p of cfg.pages) if (p.parent) expect(titles).toContain(p.parent);
  });
});
