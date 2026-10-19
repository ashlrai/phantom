/**
 * Governed-client gateway slice B: OpenAI Agents read-only client and CLI.
 *
 * First-party origin unless `gateways.openaiAgents` is explicitly enabled and
 * validates. The key goes only to the resolved target; a refused config never
 * reads the key or contacts anything. Output carries `gateway: { via, host }`
 * only for gateway reads. Hermetic: injected fetch, no network.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentsReadClient } from '../src/core/openai-agents/client.js';

const KEY = 'sk-test-gateway-never-real';
const session = { object: 'agent.session', id: 'sess_123', created_at: 1720000000, status: 'idle',
  agent: { id: 'agent_123', model: 'gpt-test' }, required_actions: [] };
const page = { object: 'list', data: [session], has_more: false, first_id: 'sess_123', last_id: 'sess_123' };

function make(gateways?: unknown, body: unknown = page) {
  const transport = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(body));
  const readApiKey = vi.fn(() => KEY);
  const client = new AgentsReadClient({ fetch: transport, readApiKey, ...(gateways === undefined ? {} : { gateways }) });
  return { client, transport, readApiKey };
}
afterEach(() => { vi.restoreAllMocks(); delete process.env['OPENAI_BASE_URL']; });

describe('openai agents client: defaults unchanged', () => {
  it.each([
    ['absent', undefined],
    ['empty', {}],
    ['enabled false', { openaiAgents: { enabled: false, baseUrl: 'http://127.0.0.1:4000' } }],
    ['other client only', { anthropic: { enabled: true, baseUrl: 'http://127.0.0.1:4000' } }],
  ])('%s: fixed first-party origin and no marker', async (_label, gateways) => {
    process.env['OPENAI_BASE_URL'] = 'http://127.0.0.1:9/hostile';
    const { client, transport } = make(gateways);
    await client.listSessions({ limit: 1 });
    expect(transport.mock.calls[0]![0]).toBe('https://api.openai.com/v1/agents/sessions?limit=1&order=desc');
    expect(client.via).toBeUndefined();
  });
});

describe('openai agents client: explicit gateway', () => {
  it('loopback gateway: key only to that target, marker is host only', async () => {
    const { client, transport } = make({ openaiAgents: { enabled: true, baseUrl: 'http://127.0.0.1:4000/oa' } }, session);
    await client.inspectSession('sess_123');
    const [url, init] = transport.mock.calls[0]!;
    expect(url).toBe('http://127.0.0.1:4000/oa/v1/agents/sessions/sess_123');
    expect(init).toMatchObject({ method: 'GET', redirect: 'error', headers: { Authorization: `Bearer ${KEY}` } });
    expect(client.via).toEqual({ via: 'gateway', host: '127.0.0.1' });
    expect(JSON.stringify(client.via)).not.toMatch(/4000|oa|sk-/);
  });

  it('https listed host with query paths', async () => {
    const { client, transport } = make({ openaiAgents: { enabled: true, baseUrl: 'https://gw.example.com', allowedHosts: ['gw.example.com:443'] } });
    await client.listTurns('sess_123', { limit: 2 }).catch(() => undefined);
    expect(transport.mock.calls[0]![0]).toBe('https://gw.example.com/v1/agents/sessions/sess_123/turns?limit=2&order=desc');
  });

  it('a gateway echoing the key is still rejected', async () => {
    const echoed = { ...page, data: [{ ...session, status: KEY }] };
    const { client } = make({ openaiAgents: { enabled: true, baseUrl: 'http://127.0.0.1:4000' } }, echoed);
    await expect(client.listSessions()).rejects.toMatchObject({ code: 'invalid-response' });
  });

  it.each([
    ['localhost name', { enabled: true, baseUrl: 'http://localhost:4000' }],
    ['http non-loopback', { enabled: true, baseUrl: 'http://gw.example.com', allowedHosts: ['gw.example.com:80'] }],
    ['unlisted https', { enabled: true, baseUrl: 'https://gw.example.com' }],
    ['userinfo', { enabled: true, baseUrl: 'https://SECRETUSER:SECRETPW@gw.example.com', allowedHosts: ['gw.example.com:443'] }],
    ['extra headers key', { enabled: true, baseUrl: 'http://127.0.0.1:4000', headers: { x: 'y' } }],
  ])('%s refuses before reading the key or contacting anything', async (_label, entry) => {
    const { client, transport, readApiKey } = make({ openaiAgents: entry });
    const error = await client.listSessions().catch((e: unknown) => e as Error & { code?: string });
    expect(error).toMatchObject({ code: 'gateway-config-invalid' });
    expect(String((error as Error).message)).not.toContain('SECRET');
    expect(readApiKey).not.toHaveBeenCalled();
    expect(transport).not.toHaveBeenCalled();
    expect(client.via).toBeUndefined();
  });
});

describe('usage and limits endpoints stay first-party', () => {
  it('neither module reads the gateways config or the gateway validator', async () => {
    const { readFileSync } = await import('node:fs');
    for (const file of ['src/core/fabric/usage-api.ts', 'src/core/observability/limits.ts']) {
      const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
      expect(src).not.toMatch(/gateway-target|gateways/);
    }
  });
});
