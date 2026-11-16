/**
 * RQ-PHX-RECUTCLIC452 regression cases for the CLI-to-DESK wiring preserved
 * through #5764, exercised through the real cmdDriveApp entry with only the
 * fetch boundary injected and createAppAdapters spied (real implementation).
 *
 * The s163/172/c381 suites cover handle routing; these cases cover the other
 * half of the recut behavior — `start` when the seat discovery reports no
 * enrolled seat:
 *   - with a live bearer and no seat, `start` falls back to the existing DESK
 *     adapter and returns a `desk-<target>:` handle through the same MCP
 *     loopback, driving only computer_* tools;
 *   - an explicit `--seat` never falls back to GUI driving — a missing seat is
 *     a plain failure after one bootstrap request;
 *   - an enrolled seat keeps the session API even while the desk port exists.
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

type EnvKey = 'PHM_DRIVE_ORIGIN' | 'PHM_DRIVE_READ_TOKEN' | 'PHM_DRIVE_MUTATION_TOKEN' | 'PHM_DRIVE_DESK_BEARER';
// Fake fixture: 43 url-safe characters, matching the live-turn bearer shape.
const BEARER = 'fakeC4520fakeC4520fakeC4520fakeC4520fakeC45';
const MCP_PATH = '/api/verse/agent-tools/mcp';

interface FetchCall { path: string; method: string; tool: string | null; auth: string | null }

function useEnv(extra: Partial<Record<EnvKey, string>> = {}): void {
  vi.stubEnv('PHM_DRIVE_ORIGIN', 'http://127.0.0.1:7777');
  vi.stubEnv('PHM_DRIVE_READ_TOKEN', 'read-fake');
  vi.stubEnv('PHM_DRIVE_MUTATION_TOKEN', 'write-fake');
  vi.stubEnv('PHM_DRIVE_DESK_BEARER', undefined);
  for (const [key, value] of Object.entries(extra)) vi.stubEnv(key, value);
}

const mcpText = (text: string) => ({ ok: true, status: 200, json: async () => ({ result: { content: [{ type: 'text', text }] } }) });

/** Fake loopback API: seat discovery, Phantom session routes and the DESK MCP route. */
function stubApi(seats: unknown[] = []): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init: unknown) => {
    const u = new URL(String(url));
    const i = init as { method: string; headers: Record<string, string>; body?: string };
    const tool = i.body ? String((JSON.parse(i.body) as { params?: { name?: unknown } }).params?.name ?? '') || null : null;
    calls.push({ path: u.pathname, method: i.method, tool, auth: i.headers['authorization'] ?? null });
    if (u.pathname === MCP_PATH) {
      if (tool === 'computer_list_apps') return mcpText('- Codex (com.openai.codex): fake listing; this chat holds access');
      if (tool === 'computer_ax_tree') return mcpText('e1 AXTextArea "Ask Codex anything" value="" (focused)\ne2 AXButton "Send"');
      return mcpText('ok');
    }
    if (u.pathname === '/api/verse/bootstrap') return { ok: true, status: 200, json: async () => ({ seats }) };
    if (u.pathname === '/api/verse/sessions' && i.method === 'POST') return { ok: true, status: 201, json: async () => ({ id: 'sess-9' }) };
    if (u.pathname.endsWith('/turns')) return { ok: true, status: 202, json: async () => ({}) };
    return { ok: false, status: 404, json: async () => ({}) };
  }));
  return calls;
}

function capturedOutput(): { lines: () => string } {
  const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
  return { lines: () => spy.mock.calls.map(c => String(c[0])).join('\n') };
}

function lastDeskPort(): unknown {
  const calls = vi.mocked(apps.createAppAdapters).mock.calls;
  return (calls[calls.length - 1]?.[0] as { desk?: unknown }).desk;
}

beforeEach(() => { vi.mocked(apps.createAppAdapters).mockClear(); });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('cmdDriveApp start DESK fallback (RQ-PHX-RECUTCLIC452)', () => {
  it('with a bearer and no enrolled seat, start drives the existing DESK adapter and returns a desk- handle', async () => {
    useEnv({ PHM_DRIVE_DESK_BEARER: BEARER });
    const calls = stubApi([]);
    const out = capturedOutput();
    const code = await cmdDriveApp(['codex', 'start', '--prompt', 'fake task c452', '--json']);
    expect(typeof lastDeskPort()).toBe('function');
    const desk = calls.filter(c => c.path === MCP_PATH);
    expect(desk.map(c => c.tool)).toEqual(['computer_list_apps', 'computer_ax_tree', 'computer_ax_press', 'computer_type', 'computer_ax_press']);
    for (const call of desk) expect(call).toMatchObject({ method: 'POST', auth: `Bearer ${BEARER}` });
    expect(calls.some(c => c.path.startsWith('/api/verse/sessions'))).toBe(false);
    expect(code).toBe(0);
    expect(out.lines()).toContain('"handle":"desk-codex:com.openai.codex"');
    expect(out.lines()).not.toContain(BEARER);
  });

  it('an explicit --seat never falls back to GUI driving: a missing seat fails after one bootstrap request', async () => {
    useEnv({ PHM_DRIVE_DESK_BEARER: BEARER });
    const calls = stubApi([]);
    const out = capturedOutput();
    const code = await cmdDriveApp(['codex', 'start', '--prompt', 'fake task c452', '--seat', 'seat-1', '--json']);
    expect(calls.map(c => c.path)).toEqual(['/api/verse/bootstrap']);
    expect(calls.filter(c => c.path === MCP_PATH)).toEqual([]);
    expect(calls.every(c => c.auth === null)).toBe(true);
    expect(code).toBe(1);
    expect(out.lines()).toContain('"ok":false');
    expect(out.lines()).not.toContain(BEARER);
  });

  it('an enrolled seat keeps the session API even while the desk port is live', async () => {
    useEnv({ PHM_DRIVE_DESK_BEARER: BEARER });
    const calls = stubApi([{ id: 'seat-1', engine: 'codex' }]);
    const out = capturedOutput();
    const code = await cmdDriveApp(['codex', 'start', '--prompt', 'fake task c452', '--seat', 'seat-1', '--json']);
    expect(typeof lastDeskPort()).toBe('function');
    expect(calls.filter(c => c.path === MCP_PATH)).toEqual([]);
    expect(calls.map(c => c.path)).toEqual(['/api/verse/bootstrap', '/api/verse/sessions', '/api/verse/sessions/sess-9/turns']);
    expect(code).toBe(0);
    expect(out.lines()).toContain('"handle":"sess-9"');
    expect(out.lines()).not.toContain(BEARER);
  });
});
