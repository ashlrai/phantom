import { describe, expect, it, vi } from 'vitest';
import { createAppAdapters, DRIVE_TARGETS, loopbackAppRequest, loopbackDeskCall } from '../src/core/drive/apps.js';
import type { VerseRequest } from '../src/core/verse/desktop-adapters.js';

describe('app drive', () => {
  for (const target of DRIVE_TARGETS) it(`${target}: all four actions through the existing session API`, async () => {
    const request = vi.fn<VerseRequest>(async (method, path) => {
      if (path.endsWith('bootstrap')) return { status: 200, json: { seats: [{ id: 'seat', engine: target }] } };
      if (method === 'POST') return { status: path.endsWith('turns') ? 202 : 201, json: { id: 'session' } };
      return { status: 200, json: { session: { engine: target, status: 'idle' }, events: [{ type: 'assistant-message', text: 'answer' }, { type: 'turn-done', ok: true }] } };
    });
    const adapter = createAppAdapters({ request })[target];
    const base = { target, projectPath: '/project', seat: 'seat' };
    expect(await adapter({ ...base, action: 'start', prompt: 'hello' })).toEqual({ ok: true, handle: 'session' });
    expect(await adapter({ ...base, action: 'status', handle: 'session' })).toMatchObject({ state: 'idle' });
    expect(await adapter({ ...base, action: 'send-prompt', handle: 'session', prompt: 'continue' })).toEqual({ ok: true, handle: 'session' });
    expect(await adapter({ ...base, action: 'read-result', handle: 'session' })).toMatchObject({ ok: true, text: 'answer' });
    expect(request).toHaveBeenCalledWith('POST', '/api/verse/sessions', { projectPath: '/project', seatId: 'seat' });
  });
  it('uses separate API tokens and the live DESK bearer without redirects', async () => {
    const fetcher = vi.fn(async (_url: unknown, _options: unknown) => ({ ok: true, status: 200, json: async () => ({ result: { content: [] } }) }));
    vi.stubGlobal('fetch', fetcher);
    try {
      const request = loopbackAppRequest('http://127.0.0.1:7777', 'read', 'write');
      await request('GET', '/api/verse/bootstrap');
      expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ redirect: 'error', headers: { 'x-ashlr-token': 'read' } });
      await request('POST', '/api/verse/sessions', {});
      expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ headers: { 'x-ashlr-token': 'write' } });
      await loopbackDeskCall('http://127.0.0.1:7777', 'a'.repeat(43))('computer_list_apps', {});
      expect(fetcher.mock.calls[2]?.[1]).toMatchObject({ redirect: 'error', headers: { authorization: `Bearer ${'a'.repeat(43)}` } });
    } finally { vi.unstubAllGlobals(); }
  });
  it('rejects remote origins and absent authentication', () => {
    for (const origin of ['http://localhost:7777', 'http://example.com', 'https://127.0.0.1', 'http://127.0.0.1/path']) expect(() => loopbackAppRequest(origin, 'read', 'write')).toThrow();
    expect(() => loopbackAppRequest('http://127.0.0.1', '', 'write')).toThrow();
  });
  it('does not retry an ambiguous mutation on the GUI', async () => {
    const desk = vi.fn();
    const request: VerseRequest = async (method) => {
      if (method === 'POST') throw new Error('lost response');
      return { status: 200, json: { seats: [{ id: 'claude', engine: 'claude' }] } };
    };
    await expect(createAppAdapters({ request, desk }).claude({ target: 'claude', action: 'start', prompt: 'hello', projectPath: '/' })).rejects.toThrow();
    expect(desk).not.toHaveBeenCalled();
  });
  for (const target of ['claude', 'codex', 'devin'] as const) it(`${target}: DESK fallback preserves driver calls`, async () => {
    const bundle = `test.${target}`;
    const desk = vi.fn(async (name: string) => ({ content: [{ type: 'text' as const, text: name === 'computer_list_apps' ? `- ${target[0]!.toUpperCase() + target.slice(1)} (${bundle}): running` : 'e1 AXTextArea "Message" value="answer"\ne2 AXButton "Send"' }] }));
    const adapter = createAppAdapters({ request: async () => ({ status: 200, json: { seats: [] } }), desk })[target];
    const base = { target, projectPath: '/', handle: `desk-${target}:${bundle}` };
    expect(await adapter({ ...base, action: 'start', prompt: 'hello' })).toMatchObject({ ok: true, handle: base.handle });
    expect(await adapter({ ...base, action: 'status' })).toMatchObject({ state: 'idle' });
    expect(await adapter({ ...base, action: 'send-prompt', prompt: 'again' })).toMatchObject({ ok: true });
    expect(await adapter({ ...base, action: 'read-result' })).toMatchObject({ ok: true, text: 'answer', untrusted: true });
  });
});
