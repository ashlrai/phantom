/**
 * CLI-to-DESK wiring for `phm drive <target> <action> --json` (ported from the
 * accumulated #5095 hunk in src/cli/drive-app.ts). Exercises the real
 * cmdDriveApp entry. Only the fetch boundary and a spy on createAppAdapters
 * are injected. All values are plainly fake, the origin is loopback, and no
 * desktop process is launched.
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
// Fake fixtures: 43 url-safe characters, matching the live-turn bearer shape.
const BEARER = 'FakeDeskBearer0123456789abcdefghijklmnopqRS';
// Fake fixture shaped like a GitHub token so the shared scrubber must redact it in output.
const FAKE_TOKEN = 'ghp_Fake0123456789abcdefghijklmnopqrstuv';
const DESK_HANDLE = 'desk-claude:test.claude';

interface FetchCall { path: string; method: string; headers: Record<string, string>; redirect: unknown }

function useEnv(extra: Partial<Record<(typeof ENV_KEYS)[number], string>> = {}): void {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env['PHM_DRIVE_ORIGIN'] = 'http://127.0.0.1:7777';
  process.env['PHM_DRIVE_READ_TOKEN'] = 'read-fake';
  process.env['PHM_DRIVE_MUTATION_TOKEN'] = 'write-fake';
  delete process.env['PHM_DRIVE_DESK_BEARER'];
  for (const [key, value] of Object.entries(extra)) process.env[key] = value;
}

/** Fake loopback API: Phantom session routes plus the DESK MCP route. */
function stubApi(deskText = 'Fake DESK text'): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init: unknown) => {
    const u = new URL(String(url));
    const i = init as { method: string; headers: Record<string, string>; redirect: unknown };
    calls.push({ path: u.pathname, method: i.method, headers: i.headers, redirect: i.redirect });
    if (u.pathname === '/api/verse/agent-tools/mcp') {
      if (deskText === 'refuse') return { ok: false, status: 500, json: async () => ({ error: 'refused' }) };
      return { ok: true, status: 200, json: async () => ({ result: { content: [{ type: 'text', text: deskText }] } }) };
    }
    if (u.pathname === '/api/verse/bootstrap') return { ok: true, status: 200, json: async () => ({ seats: [{ id: 'seat-1', engine: 'claude' }] }) };
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

beforeEach(() => { vi.mocked(apps.createAppAdapters).mockClear(); });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('phm drive <target> <action> DESK wiring (#5095 port)', () => {
  it('passes the loopback DESK adapter when a live bearer is configured and routes a desk handle through it', async () => {
    useEnv({ PHM_DRIVE_DESK_BEARER: BEARER });
    const calls = stubApi();
    const out = capturedOutput();
    const code = await cmdDriveApp(['claude', 'status', '--handle', DESK_HANDLE, '--json']);
    expect(typeof lastDeskPort()).toBe('function');
    const desk = calls.filter(c => c.path === '/api/verse/agent-tools/mcp');
    expect(desk.length).toBeGreaterThan(0);
    expect(desk[0]).toMatchObject({ method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${BEARER}` } });
    expect(calls.some(c => c.path.startsWith('/api/verse/sessions'))).toBe(false);
    expect(code).toBe(0);
    expect(out.lines()).not.toContain(BEARER);
  });

  it('keeps the no-bearer path: no DESK port, seat start through the Phantom API only', async () => {
    useEnv();
    const calls = stubApi();
    const out = capturedOutput();
    const code = await cmdDriveApp(['claude', 'start', '--prompt', 'hello', '--json']);
    expect(lastDeskPort()).toBeUndefined();
    expect(calls.some(c => c.path === '/api/verse/agent-tools/mcp')).toBe(false);
    expect(code).toBe(0);
    expect(out.lines()).toContain('"handle":"sess-9"');
  });

  it('without a bearer a desk-shaped handle is still refused with the existing nonzero exit', async () => {
    useEnv();
    const calls = stubApi();
    const out = capturedOutput();
    const code = await cmdDriveApp(['claude', 'status', '--handle', DESK_HANDLE, '--json']);
    expect(lastDeskPort()).toBeUndefined();
    expect(calls.some(c => c.path === '/api/verse/agent-tools/mcp')).toBe(false);
    expect(code).toBe(1);
    expect(out.lines()).toContain('"ok":false');
  });

  it('refuses a non-loopback origin even when a bearer is configured, and never calls out', async () => {
    for (const origin of ['http://example.com:7777', 'http://localhost:7777']) {
      useEnv({ PHM_DRIVE_ORIGIN: origin, PHM_DRIVE_DESK_BEARER: BEARER });
      const calls = stubApi();
      const out = capturedOutput();
      const code = await cmdDriveApp(['claude', 'status', '--handle', DESK_HANDLE, '--json']);
      expect(code).toBe(1);
      expect(calls).toEqual([]);
      expect(out.lines()).not.toContain(BEARER);
      vi.restoreAllMocks();
      for (const key of ENV_KEYS) delete process.env[key];
    }
  });

  it('rejects a malformed bearer before any request, with redacted generic output', async () => {
    useEnv({ PHM_DRIVE_DESK_BEARER: 'too-short-FAKE' });
    const calls = stubApi();
    const out = capturedOutput();
    const code = await cmdDriveApp(['claude', 'status', '--handle', DESK_HANDLE, '--json']);
    expect(code).toBe(1);
    expect(calls).toEqual([]);
    expect(out.lines()).not.toContain('too-short-FAKE');
  });

  it('turns a DESK refusal into the existing nonzero generic failure', async () => {
    useEnv({ PHM_DRIVE_DESK_BEARER: BEARER });
    stubApi('refuse');
    const out = capturedOutput();
    const code = await cmdDriveApp(['claude', 'status', '--handle', DESK_HANDLE, '--json']);
    expect(code).toBe(1);
    expect(out.lines()).toContain('Drive unavailable or invalid arguments');
    expect(out.lines()).not.toContain(BEARER);
  });

  it('redacts secret-shaped text read back from DESK before printing', async () => {
    useEnv({ PHM_DRIVE_DESK_BEARER: BEARER });
    stubApi(`e1 AXTextArea "Message" value="answer ${FAKE_TOKEN}"\ne2 AXButton "Send"`);
    const out = capturedOutput();
    await cmdDriveApp(['claude', 'read-result', '--handle', DESK_HANDLE, '--json']);
    expect(out.lines()).not.toContain(FAKE_TOKEN);
    expect(out.lines()).toContain('[REDACTED]');
    expect(out.lines()).not.toContain(BEARER);
  });

  it('leaves the phantom target on the Phantom API even when a bearer is configured', async () => {
    useEnv({ PHM_DRIVE_DESK_BEARER: BEARER });
    const calls = stubApi();
    const out = capturedOutput();
    const code = await cmdDriveApp(['phantom', 'status', '--handle', 'sess-9', '--json']);
    expect(typeof lastDeskPort()).toBe('function');
    expect(calls.some(c => c.path === '/api/verse/agent-tools/mcp')).toBe(false);
    expect(calls.some(c => c.path === '/api/verse/sessions/sess-9')).toBe(true);
    expect(code).toBe(0);
    expect(out.lines()).not.toContain(BEARER);
  });
});
