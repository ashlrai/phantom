import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { createOmlxBusAdapter, OmlxRuntimeError } from '../src/core/fleet/bus-adapters/omlx.js';

const servers: Server[] = [];
async function stub(handler: (req: IncomingMessage, res: ServerResponse) => void): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('stub did not bind');
  return `http://127.0.0.1:${address.port}/v1`;
}

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
    server.closeAllConnections();
  })));
});

const request = { model: 'test-model', messages: [{ role: 'user' as const, content: 'Say hello' }] };
const completion = (extra: Record<string, unknown> = {}) => ({
  model: 'test-model',
  choices: [{ message: { role: 'assistant', content: 'Hello' }, finish_reason: 'stop' }],
  ...extra,
});

describe('oMLX bus adapter — real loopback transport', () => {
  it('discovers models and completes through local-runtime with keyless OpenAI requests', async () => {
    const seen: Array<{ url?: string; method?: string; auth?: string; body: unknown }> = [];
    const baseUrl = await stub((req, res) => {
      let text = '';
      req.on('data', (chunk) => { text += chunk; });
      req.on('end', () => {
        seen.push({ url: req.url, method: req.method, auth: req.headers.authorization, body: text ? JSON.parse(text) : null });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify(req.url === '/v1/models'
          ? { data: [{ id: 'test-model' }] }
          : completion({ usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } })));
      });
    });
    const adapter = createOmlxBusAdapter({ baseUrl: `${baseUrl}/` });
    expect(adapter.id).toBe('omlx');
    expect(adapter.baseUrl).toBe(baseUrl);
    expect(Object.isFrozen(adapter)).toBe(true);
    expect(await adapter.listModels()).toEqual(['test-model']);
    expect(await adapter.complete({ ...request, maxTokens: 16, temperature: 0 })).toEqual({
      model: 'test-model', text: 'Hello', finishReason: 'stop',
      usage: { promptTokens: 7, completionTokens: 3, totalTokens: 10 },
    });
    expect(seen).toEqual([
      { url: '/v1/models', method: 'GET', auth: undefined, body: null },
      { url: '/v1/chat/completions', method: 'POST', auth: undefined,
        body: { ...request, stream: false, max_tokens: 16, temperature: 0 } },
    ]);
  });

  it('pins localhost to loopback and preserves unknown usage', async () => {
    const baseUrl = await stub((_req, res) => res.end(JSON.stringify(completion())));
    const adapter = createOmlxBusAdapter({ baseUrl: baseUrl.replace('127.0.0.1', 'localhost') });
    expect(adapter.baseUrl).toBe(baseUrl);
    expect((await adapter.complete(request)).usage).toBeNull();
    expect(createOmlxBusAdapter().baseUrl).toBe('http://127.0.0.1:8000/v1');
    expect(createOmlxBusAdapter({ baseUrl: 'http://[::1]:8000/v1' }).baseUrl).toBe('http://[::1]:8000/v1');
  });

  it.each([
    'http://192.168.1.2:8000/v1', 'https://example.com/v1', 'http://0.0.0.0:8000/v1',
    'http://localhost.example.com/v1', 'http://2130706433:8000/v1', 'http://0x7f.1:8000/v1',
    'http://127.0.0.1.:8000/v1', 'http://127.0.0.1/v1?key=FAKE', 'http://127.0.0.1/v1#fragment',
    'http://127.0.0.1/../v1', 'file:///v1',
  ])('refuses unsafe base URL before I/O: %s', (baseUrl) => {
    expect(() => createOmlxBusAdapter({ baseUrl })).toThrow('oMLX: invalid-url');
  });

  it('does not echo credentials in rejected URLs', () => {
    const fake = `FAKE-${randomUUID()}`;
    try {
      createOmlxBusAdapter({ baseUrl: `http://user:${fake}@127.0.0.1:8000/v1` });
      expect.unreachable('credentials must be refused');
    } catch (error) {
      expect(error).toBeInstanceOf(OmlxRuntimeError);
      expect(String(error)).toBe('OmlxRuntimeError: oMLX: invalid-url');
      expect(String(error)).not.toContain(fake);
    }
  });

  it.each([301, 302, 307, 308])('refuses HTTP %i without following Location', async (status) => {
    let hits = 0;
    const target = await stub((_req, res) => { hits++; res.end('{}'); });
    const baseUrl = await stub((_req, res) => { res.writeHead(status, { Location: target }); res.end(); });
    await expect(createOmlxBusAdapter({ baseUrl }).complete(request)).rejects.toMatchObject({ code: 'http-error', status });
    expect(hits).toBe(0);
  });

  it('sanitizes upstream errors instead of exposing bodies or transport details', async () => {
    const fake = `FAKE-${randomUUID()}`;
    const baseUrl = await stub((_req, res) => { res.writeHead(503); res.end(fake); });
    await expect(createOmlxBusAdapter({ baseUrl }).complete(request)).rejects.toMatchObject({
      code: 'http-error', status: 503, message: 'oMLX: http-error (HTTP 503)',
    });
  });

  it.each(['not-json', JSON.stringify({ data: [{ id: 2 }] }), '{}'])('rejects malformed discovery responses', async (body) => {
    const baseUrl = await stub((_req, res) => res.end(body));
    await expect(createOmlxBusAdapter({ baseUrl }).listModels()).rejects.toMatchObject({ code: 'invalid-response' });
  });

  it.each([
    {}, completion({ choices: [] }), completion({ usage: { prompt_tokens: -1 } }),
    completion({ choices: [{ message: { role: 'assistant', content: null }, finish_reason: 'stop' }] }),
    completion({ choices: [{ message: { role: 'assistant', content: '', tool_calls: [{}] }, finish_reason: 'tool_calls' }] }),
  ])('rejects malformed or unsupported completion responses', async (body) => {
    const baseUrl = await stub((_req, res) => res.end(JSON.stringify(body)));
    await expect(createOmlxBusAdapter({ baseUrl }).complete(request)).rejects.toMatchObject({ code: 'invalid-response' });
  });

  it('accepts empty model inventories and empty text with a length finish reason', async () => {
    const baseUrl = await stub((req, res) => res.end(JSON.stringify(req.url?.endsWith('/models')
      ? { data: [] } : completion({ choices: [{ message: { role: 'assistant', content: '' }, finish_reason: 'length' }] }))));
    const adapter = createOmlxBusAdapter({ baseUrl });
    expect(await adapter.listModels()).toEqual([]);
    expect(await adapter.complete(request)).toMatchObject({ text: '', finishReason: 'length', usage: null });
  });

  it.each([{ tool_calls: null }, { tool_calls: [] }])('accepts text responses with no tool calls (%j)', async ({ tool_calls }) => {
    const baseUrl = await stub((_req, res) => res.end(JSON.stringify(completion({
      choices: [{ message: { role: 'assistant', content: 'Hello', tool_calls }, finish_reason: 'stop' }],
    }))));
    expect(await createOmlxBusAdapter({ baseUrl }).complete(request)).toMatchObject({ text: 'Hello' });
  });

  it('bounds response bytes', async () => {
    const baseUrl = await stub((_req, res) => res.end('x'.repeat(4 * 1024 * 1024 + 1)));
    await expect(createOmlxBusAdapter({ baseUrl }).listModels()).rejects.toMatchObject({ code: 'response-too-large' });
  });

  it.each([false, true])('deadlines cover both stalled headers and stalled bodies (headers=%s)', async (headers) => {
    const baseUrl = await stub((_req, res) => {
      if (headers) { res.writeHead(200); res.write('{'); }
    });
    await expect(createOmlxBusAdapter({ baseUrl, timeoutMs: 40 }).listModels()).rejects.toMatchObject({ code: 'timeout' });
  });

  it('cancels an in-flight response and refuses pre-cancelled calls', async () => {
    const controller = new AbortController();
    let hits = 0;
    const baseUrl = await stub((_req, res) => { hits++; res.write('{'); controller.abort(); });
    const adapter = createOmlxBusAdapter({ baseUrl });
    await expect(adapter.complete(request, controller.signal)).rejects.toMatchObject({ code: 'aborted' });
    await expect(adapter.listModels(controller.signal)).rejects.toMatchObject({ code: 'aborted' });
    expect(hits).toBe(1);
  });

  it('sanitizes connection failure and truncated bodies', async () => {
    const baseUrl = await stub((_req, res) => { res.writeHead(200); res.write('{'); res.destroy(); });
    await expect(createOmlxBusAdapter({ baseUrl }).listModels()).rejects.toMatchObject({ code: 'network-error', message: 'oMLX: network-error' });
    const server = servers.pop()!;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await expect(createOmlxBusAdapter({ baseUrl }).complete(request)).rejects.toMatchObject({ code: 'network-error', message: 'oMLX: network-error' });
  });

  it('rejects invalid request/options and oversized prompts without contacting the server', async () => {
    let hits = 0;
    const baseUrl = await stub((_req, res) => { hits++; res.end('{}'); });
    const adapter = createOmlxBusAdapter({ baseUrl });
    for (const invalid of [
      { ...request, model: '' }, { ...request, messages: [] }, { ...request, maxTokens: 0 },
      { ...request, temperature: NaN }, { ...request, temperature: 3 },
      { ...request, messages: [{ role: 'user' as const, content: 'x'.repeat(4 * 1024 * 1024) }] },
    ]) {
      await expect(adapter.complete(invalid)).rejects.toMatchObject({ code: 'invalid-request' });
    }
    for (const timeoutMs of [0, -1, NaN, Infinity, 1.5, 300_001]) {
      expect(() => createOmlxBusAdapter({ baseUrl, timeoutMs })).toThrow('oMLX: invalid-request');
    }
    expect(hits).toBe(0);
  });
});
