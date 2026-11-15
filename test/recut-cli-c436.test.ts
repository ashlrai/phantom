/**
 * RQ-PHX-RECUTCLIC436 — exercises the recut DESK wiring through the real
 * `cmdDriveApp` entry: target isolation for desk-* handles, no retry or
 * session fallback after a DESK send failure, and no bearer leakage in output.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdDriveApp } from '../src/cli/drive-app.js';

// Fake fixture: 43 url-safe characters matching the live-turn bearer shape.
const BEARER = 'fakedesk0fakedesk0fakedesk0fakedesk0fakedes';

function driveEnv(withBearer = true): void {
  vi.stubEnv('PHM_DRIVE_ORIGIN', 'http://127.0.0.1:7777');
  vi.stubEnv('PHM_DRIVE_READ_TOKEN', 'fake-read');
  vi.stubEnv('PHM_DRIVE_MUTATION_TOKEN', 'fake-write');
  if (withBearer) vi.stubEnv('PHM_DRIVE_DESK_BEARER', BEARER);
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('cmdDriveApp DESK wiring (recut C436)', () => {
  it('refuses a desk handle belonging to another target before any request', async () => {
    driveEnv();
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await cmdDriveApp(['codex', 'status', '--handle', 'desk-claude:test.claude', '--json'])).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toEqual({ ok: false, error: 'Drive unavailable or invalid arguments; check local auth, seat, handle and action options.' });
  });

  it('does not retry or fall back to a session after a DESK send fails', async () => {
    driveEnv();
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetch = vi.fn().mockRejectedValue(new Error('fake lost response'));
    vi.stubGlobal('fetch', fetch);
    expect(await cmdDriveApp(['claude', 'send-prompt', '--handle', 'desk-claude:test.claude', '--prompt', 'fake prompt', '--json'])).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, init] = fetch.mock.calls[0]!;
    expect(new URL(String(url)).pathname).toBe('/api/verse/agent-tools/mcp');
    expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
    expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toEqual({ ok: false, error: 'Drive unavailable or invalid arguments; check local auth, seat, handle and action options.' });
    expect(output.mock.calls.map(c => String(c[0])).join('\n')).not.toContain(BEARER);
  });

  it('refuses a malformed DESK handle bundle before any request', async () => {
    driveEnv();
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    expect(await cmdDriveApp(['claude', 'status', '--handle', 'desk-claude:bad handle!', '--json'])).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
    expect(String(output.mock.calls[0]?.[0])).toContain('"ok":false');
  });
});
