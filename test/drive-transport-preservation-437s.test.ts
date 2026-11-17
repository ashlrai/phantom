import { afterEach, expect, it, vi } from 'vitest';
import { createAppAdapters, loopbackAppRequest, loopbackDeskCall } from '../src/core/drive/apps.js';

afterEach(() => vi.unstubAllGlobals());

it('keeps a DESK tool refusal unsuccessful without trying a session fallback', async () => {
  const routes: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: URL) => {
    const path = new URL(String(url)).pathname;
    routes.push(path);
    if (path === '/api/verse/agent-tools/mcp') {
      return { ok: true, status: 200, json: async () => ({ result: { isError: true, content: [{ type: 'text', text: 'access refused' }] } }) };
    }
    return { ok: true, status: 201, json: async () => ({ id: 'session-fallback' }) };
  }));
  const origin = 'http://127.0.0.1:7777';
  const adapters = createAppAdapters({
    request: loopbackAppRequest(origin, 'read-fake', 'write-fake'),
    desk: loopbackDeskCall(origin, 'a'.repeat(43)),
  });
  const result = await adapters.claude({ target: 'claude', action: 'send-prompt', handle: 'desk-claude:test.claude', prompt: 'hello', projectPath: '/' });
  expect(result).toEqual({ ok: false, error: 'Claude is not running (or is not granted to this chat). Open it, then ask the operator for access.' });
  expect(routes).toEqual(['/api/verse/agent-tools/mcp']);
});
