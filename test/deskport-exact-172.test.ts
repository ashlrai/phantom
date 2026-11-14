/**
 * Exactness proof for the CLI-to-DESK port (RQ-PHX-DESKPORTEXACT172, recovered
 * from #5113): through the real cmdDriveApp entry, with only the fetch boundary
 * injected and createAppAdapters spied (real implementation preserved).
 *
 * Proves behaviorally:
 *   - without a live PHM_DRIVE_DESK_BEARER no DESK port exists, no DESK
 *     invocation happens, and no authorization credential of any kind is sent;
 *   - with the bearer present the desk handle routes through the existing
 *     loopbackDeskCall carrying exactly that pre-configured bearer — no second
 *     credential, no grant- or confirmation-shaped request is ever minted;
 *   - the phantom target keeps its existing session-API routing.
 *
 * All fixtures are plainly fake, the origin is loopback, and no desktop
 * process is launched.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { cmdDriveApp } from '../src/cli/drive-app.js';
import * as apps from '../src/core/drive/apps.js';

vi.mock('../src/core/drive/apps.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/core/drive/apps.js')>();
  return { ...actual, createAppAdapters: vi.fn(actual.createAppAdapters) };
});

const ENV_KEYS = ['PHM_DRIVE_ORIGIN', 'PHM_DRIVE_READ_TOKEN', 'PHM_DRIVE_MUTATION_TOKEN', 'PHM_DRIVE_DESK_BEARER'] as const;
const savedEnv: Record<string, string | undefined> = {};
// Fake fixture: 43 url-safe characters, matching the live-turn bearer shape.
const BEARER = 'FakeDeskBearer0123456789abcdefghijklmnopqRS';
const DESK_HANDLE = 'desk-codex:test.codex';
const MCP_PATH = '/api/verse/agent-tools/mcp';

interface FetchCall { path: string; method: string; headers: Record<string, string>; redirect: unknown }

function useEnv(extra: Partial<Record<(typeof ENV_KEYS)[number], string>> = {}): void {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env['PHM_DRIVE_ORIGIN'] = 'http://127.0.0.1:7777';
  process.env['PHM_DRIVE_READ_TOKEN'] = 'read-fake';
  process.env['PHM_DRIVE_MUTATION_TOKEN'] = 'write-fake';
  delete process.env['PHM_DRIVE_DESK_BEARER'];
  for (const [key, value] of Object.entries(extra)) process.env[key] = value;
}

/** Fake loopback API: the Phantom session routes plus the DESK MCP route. */
function stubApi(deskText = 'Fake DESK text'): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init: unknown) => {
    const u = new URL(String(url));
    const i = init as { method: string; headers: Record<string, string>; redirect: unknown };
    calls.push({ path: u.pathname, method: i.method, headers: i.headers, redirect: i.redirect });
    if (u.pathname === MCP_PATH) {
      if (deskText === 'refuse') return { ok: false, status: 500, json: async () => ({ error: 'refused' }) };
      return { ok: true, status: 200, json: async () => ({ result: { content: [{ type: 'text', text: deskText }] } }) };
    }
    if (u.pathname === '/api/verse/bootstrap') return { ok: true, status: 200, json: async () => ({ seats: [{ id: 'seat-1', engine: 'codex' }] }) };
    if (u.pathname === '/api/verse/sessions' && i.method === 'POST') return { ok: true, status: 201, json: async () => ({ id: 'sess-9' }) };
    if (u.pathname.endsWith('/turns')) return { ok: true, status: 202, json: async () => ({}) };
    if (u.pathname === '/api/verse/sessions/sess-9') {
      return { ok: true, status: 200, json: async () => ({ session: { engine: 'phantom', status: 'idle' }, events: [{ type: 'turn-done', ok: true }] }) };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  }));
  return calls;
}

function capturedOutput(): { lines: () => string } {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  return { lines: () => spy.mock.calls.map(c => String(c[0])).join('\n') };
}

/** The `desk` port handed to createAppAdapters by the most recent cmdDriveApp call. */
function lastDeskPort(): unknown {
  const calls = vi.mocked(apps.createAppAdapters).mock.calls;
  return (calls[calls.length - 1]?.[0] as { desk?: unknown }).desk;
}

function allAuthHeaders(calls: FetchCall[]): string[] {
  return calls.map(c => c.headers['authorization']).filter((v): v is string => typeof v === 'string');
}

/** Every observed path must belong to one of the three existing route families. */
const KNOWN_PATHS = [/^\/api\/verse\/bootstrap$/, /^\/api\/verse\/sessions(?:\/[A-Za-z0-9_-]{1,80}(?:\/turns)?)?$/, /^\/api\/verse\/agent-tools\/mcp$/];

beforeEach(() => { vi.mocked(apps.createAppAdapters).mockClear(); });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('cmdDriveApp DESK port exactness (RQ-PHX-DESKPORTEXACT172)', () => {
  it('without a bearer, no DESK port is built and no DESK invocation or authorization happens for any engine target', async () => {
    for (const target of ['claude', 'codex', 'devin'] as const) {
      useEnv();
      const calls = stubApi();
      const out = capturedOutput();
      const code = await cmdDriveApp([target, 'status', '--handle', `desk-${target}:test.${target}`, '--json']);
      expect(lastDeskPort(), `desk port for ${target}`).toBeUndefined();
      expect(calls.filter(c => c.path === MCP_PATH), `DESK calls for ${target}`).toEqual([]);
      expect(allAuthHeaders(calls), `authorization headers for ${target}`).toEqual([]);
      expect(code).toBe(1);
      expect(out.lines()).toContain('"ok":false');
      vi.restoreAllMocks();
      for (const key of ENV_KEYS) delete process.env[key];
    }
  });

  it('without a bearer, an engine start keeps the existing seat path end to end with zero DESK traffic', async () => {
    useEnv();
    const calls = stubApi();
    const out = capturedOutput();
    const code = await cmdDriveApp(['codex', 'start', '--prompt', 'hello', '--json']);
    expect(lastDeskPort()).toBeUndefined();
    expect(calls.some(c => c.path === MCP_PATH)).toBe(false);
    expect(calls.some(c => c.path === '/api/verse/bootstrap')).toBe(true);
    expect(calls.some(c => c.path === '/api/verse/sessions' && c.method === 'POST')).toBe(true);
    expect(code).toBe(0);
    expect(out.lines()).toContain('"handle":"sess-9"');
    expect(out.lines()).not.toContain('Fake');
  });

  it('with the bearer present, a desk handle routes through loopbackDeskCall carrying exactly the pre-configured bearer', async () => {
    useEnv({ PHM_DRIVE_DESK_BEARER: BEARER });
    const calls = stubApi();
    const out = capturedOutput();
    const code = await cmdDriveApp(['codex', 'status', '--handle', DESK_HANDLE, '--json']);
    expect(typeof lastDeskPort()).toBe('function');
    const desk = calls.filter(c => c.path === MCP_PATH);
    expect(desk.length).toBe(1);
    expect(desk[0]).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(allAuthHeaders(calls)).toEqual([`Bearer ${BEARER}`]);
    expect(calls.some(c => c.path.startsWith('/api/verse/sessions'))).toBe(false);
    expect(code).toBe(0);
    expect(out.lines()).not.toContain(BEARER);
  });

  it('across bearer-present and bearer-absent runs the CLI mints no grant: every request stays on the three existing route families', async () => {
    for (const bearer of [undefined, BEARER]) {
      useEnv(bearer ? { PHM_DRIVE_DESK_BEARER: bearer } : {});
      const calls = stubApi();
      await cmdDriveApp(bearer
        ? ['codex', 'status', '--handle', DESK_HANDLE, '--json']
        : ['codex', 'start', '--prompt', 'hello', '--json']);
      for (const call of calls) {
        expect(KNOWN_PATHS.some(re => re.test(call.path)), `unexpected route ${call.path} minted a grant`).toBe(true);
      }
      const auths = allAuthHeaders(calls);
      for (const value of auths) expect(value).toBe(`Bearer ${BEARER}`);
      vi.restoreAllMocks();
      for (const key of ENV_KEYS) delete process.env[key];
    }
  });

  it('a malformed bearer is rejected before any request and never echoed', async () => {
    useEnv({ PHM_DRIVE_DESK_BEARER: 'too-short-FAKE' });
    const calls = stubApi();
    const out = capturedOutput();
    const code = await cmdDriveApp(['codex', 'status', '--handle', DESK_HANDLE, '--json']);
    expect(code).toBe(1);
    expect(calls).toEqual([]);
    expect(out.lines()).not.toContain('too-short-FAKE');
    expect(out.lines()).toContain('Drive unavailable or invalid arguments');
  });

  it('a DESK refusal surfaces the existing generic failure with no credential in the output', async () => {
    useEnv({ PHM_DRIVE_DESK_BEARER: BEARER });
    stubApi('refuse');
    const out = capturedOutput();
    const code = await cmdDriveApp(['codex', 'read-result', '--handle', DESK_HANDLE, '--json']);
    expect(code).toBe(1);
    expect(out.lines()).toContain('Drive unavailable or invalid arguments');
    expect(out.lines()).not.toContain(BEARER);
  });

  it('the phantom target keeps its session routing even when the desk port is live', async () => {
    useEnv({ PHM_DRIVE_DESK_BEARER: BEARER });
    const calls = stubApi();
    const out = capturedOutput();
    const code = await cmdDriveApp(['phantom', 'status', '--handle', 'sess-9', '--json']);
    expect(typeof lastDeskPort()).toBe('function');
    expect(calls.some(c => c.path === MCP_PATH)).toBe(false);
    expect(calls.some(c => c.path === '/api/verse/sessions/sess-9')).toBe(true);
    expect(allAuthHeaders(calls)).toEqual([]);
    expect(code).toBe(0);
    expect(out.lines()).not.toContain(BEARER);
  });
});
