/**
 * CLI-to-DESK wiring recovered from open PR #5207 (source head 7e0fc02127,
 * ancestor of the current PR head), RQ-PHX-DRIVEDESKRECOVER196S.
 *
 * Exercises the real cmdDriveApp entry with only the fetch boundary injected.
 * `createAppAdapters` is spied (real implementation preserved) so the test can
 * observe whether a DESK port was handed in.
 *
 * Recut from #5229: only the missing CLI start/status/read-result scenario.
 * Other original scenarios are already asserted on master; see BRIDGE_NOTES.md.
 *
 * All fixtures are plainly fake. The origin is loopback, and no desktop
 * process, real app, or host credential is touched.
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
const BEARER = 'FakeDeskBearer0123456789abcdefghijklmnopqRS';
const MCP_PATH = '/api/verse/agent-tools/mcp';
const CLAUDE_BUNDLE = 'com.anthropic.claude';
const DESK_HANDLE = `desk-claude:${CLAUDE_BUNDLE}`;

interface FetchCall { path: string; method: string; headers: Record<string, string>; redirect: unknown; tool?: string }

function useEnv(extra: Partial<Record<EnvKey, string>> = {}): void {
  vi.stubEnv('PHM_DRIVE_ORIGIN', 'http://127.0.0.1:7777');
  vi.stubEnv('PHM_DRIVE_READ_TOKEN', 'read-fake');
  vi.stubEnv('PHM_DRIVE_MUTATION_TOKEN', 'write-fake');
  vi.stubEnv('PHM_DRIVE_DESK_BEARER', undefined);
  for (const [key, value] of Object.entries(extra)) vi.stubEnv(key, value);
}

/** Fake accessibility tree for the Claude window: a composer, a Send button, and one answer. */
function axTree(answer: string): string {
  return [
    'e1 AXTextArea "Message" (focused)',
    'e2 AXButton "Send"',
    `e3 AXStaticText value="${answer}"`,
  ].join('\n');
}

/** Fake loopback API: the DESK MCP route answers computer_* tools; Phantom session routes are unused here. */
function stubApi(answer = 'Fake DESK answer'): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init: unknown) => {
    const u = new URL(String(url));
    const i = init as { method: string; headers: Record<string, string>; redirect: unknown; body?: string };
    const call: FetchCall = { path: u.pathname, method: i.method, headers: i.headers, redirect: i.redirect };
    calls.push(call);
    if (u.pathname === MCP_PATH) {
      const tool = (JSON.parse(String(i.body)) as { params: { name: string } }).params.name;
      call.tool = tool;
      const text = tool === 'computer_list_apps' ? `- Claude (${CLAUDE_BUNDLE}): running`
        : tool === 'computer_ax_tree' ? axTree(answer)
          : 'ok';
      return { ok: true, status: 200, json: async () => ({ result: { content: [{ type: 'text', text }] } }) };
    }
    if (u.pathname === '/api/verse/bootstrap') return { ok: true, status: 200, json: async () => ({ seats: [] }) };
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

function deskCalls(calls: FetchCall[]): FetchCall[] {
  return calls.filter(c => c.path === MCP_PATH);
}

beforeEach(() => { vi.mocked(apps.createAppAdapters).mockClear(); });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('phm drive <target> <action> DESK wiring (RQ-PHX-DRIVEDESKRECOVER196S)', () => {
  it('desktop start returns a desk handle, and the follow-up status and read-result go through the loopback DESK route with the configured bearer', async () => {
    useEnv({ PHM_DRIVE_DESK_BEARER: BEARER });
    const calls = stubApi();

    const started = capturedOutput();
    expect(await cmdDriveApp(['claude', 'start', '--prompt', 'hello', '--json'])).toBe(0);
    expect(typeof lastDeskPort()).toBe('function');
    expect(started.lines()).toContain(`"handle":"${DESK_HANDLE}"`);
    expect(started.lines()).not.toContain(BEARER);
    // Start drives the Claude window through computer_* tools only: resolve the app, read its tree, type, press Send.
    expect(deskCalls(calls).map(c => c.tool)).toEqual(expect.arrayContaining(['computer_list_apps', 'computer_ax_tree', 'computer_type', 'computer_ax_press']));

    const status = capturedOutput();
    expect(await cmdDriveApp(['claude', 'status', '--handle', DESK_HANDLE, '--json'])).toBe(0);
    expect(status.lines()).toContain('"state":"idle"');

    const read = capturedOutput();
    expect(await cmdDriveApp(['claude', 'read-result', '--handle', DESK_HANDLE, '--json'])).toBe(0);
    expect(read.lines()).toContain('Fake DESK answer');

    // Every DESK request is POST to the loopback route, redirects are errors, and the only credential is the configured bearer.
    for (const c of deskCalls(calls)) {
      expect(c).toMatchObject({ method: 'POST', redirect: 'error', headers: { authorization: `Bearer ${BEARER}` } });
    }
    expect(calls.some(c => c.path.startsWith('/api/verse/sessions'))).toBe(false);
  });

});
