/**
 * Preservation of the stranded #5207 DESK-transport assertions
 * (source 57fc962de0efa272d647f61020a31aea4bc9cc19:
 * test/drive-app-desk-wire-s163.test.ts), re-expressed against current master
 * exports: createAppAdapters composed with the real loopbackAppRequest and
 * loopbackDeskCall transports, with only the fetch boundary faked. The CLI
 * wiring the original exercised (src/cli/drive-app.ts) belongs to
 * RQ-PHX-DRIVEDESKRECOVER196S and is deliberately not touched here.
 *
 * All fixtures are plainly fake, the origin is loopback, no desktop process
 * is launched and no network call leaves the stubbed fetch.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAppAdapters, loopbackAppRequest, loopbackDeskCall } from '../src/core/drive/apps.js';
import type { VerseRequest } from '../src/core/verse/desktop-adapters.js';

const ORIGIN = 'http://127.0.0.1:7777';
// Fake fixtures only: a 43-char url-safe bearer and a GitHub-token-shaped
// string the shared scrubber must redact.
const BEARER = `FakeDeskBearer${'0'.repeat(29)}`;
const FAKE_TOKEN = 'ghp_Fake0123456789abcdefghijklmnopqrstuv';
const DESK_HANDLE = 'desk-claude:test.claude';

const tree = (...lines: string[]): string =>
  ['Accessibility tree of X', '<untrusted id="a" source="s">', ...lines, '</untrusted id="a">'].join('\n');
const IDLE_TREE = tree(
  'e1 AXTextArea "Write your message" value="" (focused)',
  'e2 AXButton "Send"',
);
const SECRET_TREE = tree('e1 AXStaticText "answer ghp_Fake0123456789abcdefghijklmnopqrstuv done"');

interface FetchCall {
  path: string;
  method: string;
  headers: Record<string, string>;
  redirect: unknown;
  tool: string | null;
  toolArgs: Record<string, unknown> | null;
}

/** Fake loopback API: Phantom session routes plus the DESK MCP route. */
function stubApi(opts: { desk?: 'ok' | 'refuse'; axTree?: string; seats?: unknown[] } = {}): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init: unknown) => {
    const u = new URL(String(url));
    const i = init as { method: string; headers: Record<string, string>; redirect: unknown; body?: string };
    let tool: string | null = null;
    let toolArgs: Record<string, unknown> | null = null;
    if (i.body) {
      try {
        const params = (JSON.parse(i.body) as { params?: { name?: string; arguments?: Record<string, unknown> } }).params;
        tool = params?.name ?? null;
        toolArgs = params?.arguments ?? null;
      } catch { /* not JSON-RPC */ }
    }
    calls.push({ path: u.pathname, method: i.method, headers: i.headers, redirect: i.redirect, tool, toolArgs });
    const json = (payload: unknown, status = 200, okFlag = status < 400) => ({ ok: okFlag, status, json: async () => payload });
    if (u.pathname === '/api/verse/agent-tools/mcp') {
      if (opts.desk === 'refuse') return json({ error: 'refused' }, 500);
      const text = tool === 'computer_list_apps'
        ? '- Claude (test.claude): up to full control'
        : tool === 'computer_ax_tree' ? (opts.axTree ?? IDLE_TREE)
        : 'done';
      return json({ result: { content: [{ type: 'text', text }] } });
    }
    if (u.pathname === '/api/verse/bootstrap') return json({ seats: opts.seats ?? [] });
    if (u.pathname === '/api/verse/sessions' && i.method === 'POST') return json({ id: 'sess-9' }, 201);
    if (u.pathname.endsWith('/turns')) return json({}, 202);
    if (u.pathname === '/api/verse/sessions/sess-9') {
      return json({ session: { engine: 'phantom', status: 'idle' }, events: [{ type: 'turn-done', ok: true }] });
    }
    return json({}, 404);
  }));
  return calls;
}

/** Adapters wired exactly as the CLI wires them: real loopback transports. */
function wiredAdapters(deskBearer?: string) {
  const request: VerseRequest = loopbackAppRequest(ORIGIN, 'read-fake', 'write-fake');
  const desk = deskBearer === undefined ? undefined : loopbackDeskCall(ORIGIN, deskBearer);
  return createAppAdapters({ request, ...(desk === undefined ? {} : { desk }) });
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('drive adapter DESK transport preservation (#5207 s163 port)', () => {
  it('routes a desk handle through the configured DESK transport only, never the session API', async () => {
    const calls = stubApi();
    const adapters = wiredAdapters(BEARER);
    const status = await adapters.claude({ target: 'claude', action: 'status', handle: DESK_HANDLE, projectPath: '/' }) as { state: string };
    expect(status.state).toBe('idle');
    const desk = calls.filter((c) => c.path === '/api/verse/agent-tools/mcp');
    expect(desk).toHaveLength(1);
    expect(desk[0]).toMatchObject({
      method: 'POST',
      redirect: 'error',
      headers: { authorization: `Bearer ${BEARER}` },
      tool: 'computer_ax_tree',
      toolArgs: { app: 'test.claude' },
    });
    expect(calls.some((c) => c.path.startsWith('/api/verse/sessions') || c.path === '/api/verse/bootstrap')).toBe(false);
  });

  it('desk start with no matching seat falls back to the DESK transport and returns the desk handle', async () => {
    const calls = stubApi();
    const adapters = wiredAdapters(BEARER);
    const started = await adapters.claude({ target: 'claude', action: 'start', prompt: 'hello', projectPath: '/' }) as { ok: boolean; handle?: string };
    expect(started).toEqual({ ok: true, handle: DESK_HANDLE });
    expect(calls.filter((c) => c.path === '/api/verse/agent-tools/mcp').map((c) => c.tool)).toEqual([
      'computer_list_apps', 'computer_ax_tree', 'computer_ax_press', 'computer_type', 'computer_ax_press',
    ]);
    expect(calls.some((c) => c.path === '/api/verse/sessions')).toBe(false);
  });

  it('send-prompt on a desk handle repeats the DESK start sequence', async () => {
    const calls = stubApi();
    const adapters = wiredAdapters(BEARER);
    const sent = await adapters.claude({ target: 'claude', action: 'send-prompt', handle: DESK_HANDLE, prompt: 'again', projectPath: '/' }) as { ok: boolean };
    expect(sent.ok).toBe(true);
    expect(calls.filter((c) => c.path === '/api/verse/agent-tools/mcp').map((c) => c.tool)).toContain('computer_type');
    expect(calls.some((c) => c.path === '/api/verse/sessions')).toBe(false);
  });

  it('read-result on a desk handle returns scrubbed untrusted text; a ghp_ token never survives', async () => {
    stubApi({ axTree: SECRET_TREE });
    const adapters = wiredAdapters(BEARER);
    const result = await adapters.claude({ target: 'claude', action: 'read-result', handle: DESK_HANDLE, projectPath: '/' }) as { ok: boolean; text?: string; untrusted?: boolean };
    expect(result.ok).toBe(true);
    expect(result.untrusted).toBe(true);
    expect(result.text).toContain('[REDACTED]');
    expect(result.text).not.toContain(FAKE_TOKEN);
  });

  it('absent DESK transport refuses desk handles and empty-seat starts instead of fabricating results', async () => {
    const calls = stubApi();
    const adapters = wiredAdapters();
    await expect(adapters.claude({ target: 'claude', action: 'status', handle: DESK_HANDLE, projectPath: '/' })).rejects.toThrow('Invalid session handle');
    await expect(adapters.claude({ target: 'claude', action: 'start', prompt: 'hello', projectPath: '/' })).rejects.toThrow('No matching seat');
    expect(calls.filter((c) => c.path === '/api/verse/agent-tools/mcp')).toEqual([]);
    expect(calls.filter((c) => c.path !== '/api/verse/bootstrap')).toEqual([]);
  });

  it('a DESK transport refusal stays an explicit rejection, not a fabricated success', async () => {
    const calls = stubApi({ desk: 'refuse' });
    const adapters = wiredAdapters(BEARER);
    await expect(adapters.claude({ target: 'claude', action: 'status', handle: DESK_HANDLE, projectPath: '/' })).rejects.toThrow('DESK refused operation');
    await expect(adapters.claude({ target: 'claude', action: 'start', prompt: 'hello', projectPath: '/' })).rejects.toThrow('DESK refused operation');
    expect(calls.some((c) => c.path === '/api/verse/sessions')).toBe(false);
  });

  it('rejects non-loopback origins and malformed bearers before any request', () => {
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    for (const origin of ['http://example.com:7777', 'http://localhost:7777']) {
      expect(() => loopbackDeskCall(origin, BEARER)).toThrow();
    }
    expect(() => loopbackDeskCall(ORIGIN, 'too-short-FAKE')).toThrow('Live turn bearer required');
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('the phantom target stays on the Phantom session API even with a DESK bearer configured', async () => {
    const calls = stubApi();
    const adapters = wiredAdapters(BEARER);
    const status = await adapters.phantom({ target: 'phantom', action: 'status', handle: 'sess-9', projectPath: '/' }) as { state: string };
    expect(status.state).toBe('idle');
    expect(calls.filter((c) => c.path === '/api/verse/agent-tools/mcp')).toEqual([]);
    expect(calls.some((c) => c.path === '/api/verse/sessions/sess-9' && c.method === 'GET')).toBe(true);
    const sessionCall = calls.find((c) => c.path === '/api/verse/sessions/sess-9');
    expect(sessionCall?.headers['x-ashlr-token']).toBe('read-fake');
  });
});
