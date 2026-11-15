import { afterEach, expect, it, vi } from 'vitest';
import { cmdDriveApp } from '../src/cli/drive-app.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function configure() {
  vi.stubEnv('PHM_DRIVE_ORIGIN', 'http://127.0.0.1:7777');
  vi.stubEnv('PHM_DRIVE_READ_TOKEN', 'fake-read');
  vi.stubEnv('PHM_DRIVE_MUTATION_TOKEN', 'fake-write');
  vi.stubEnv('PHM_DRIVE_DESK_BEARER', 'FakeDeskBearer0123456789abcdefghijklmnopqRS');
  return vi.spyOn(console, 'log').mockImplementation(() => {});
}

it('refuses a DESK handle belonging to another target before any request', async () => {
  const output = configure();
  const fetch = vi.fn();
  vi.stubGlobal('fetch', fetch);
  expect(await cmdDriveApp(['codex', 'status', '--handle', 'desk-claude:test.claude', '--json'])).toBe(1);
  expect(fetch).not.toHaveBeenCalled();
  expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toEqual({ ok: false, error: 'Drive unavailable or invalid arguments; check local auth, seat, handle and action options.' });
});

it('does not retry or fall back to a session after a DESK send fails', async () => {
  const output = configure();
  const fetch = vi.fn().mockRejectedValue(new Error('fake lost response'));
  vi.stubGlobal('fetch', fetch);
  expect(await cmdDriveApp(['claude', 'send-prompt', '--handle', 'desk-claude:test.claude', '--prompt', 'fake prompt', '--json'])).toBe(1);
  expect(fetch).toHaveBeenCalledTimes(1);
  const [url, init] = fetch.mock.calls[0]!;
  expect(new URL(String(url)).pathname).toBe('/api/verse/agent-tools/mcp');
  expect(init).toMatchObject({ method: 'POST', redirect: 'error' });
  expect(JSON.parse(String(output.mock.calls[0]?.[0]))).toEqual({ ok: false, error: 'Drive unavailable or invalid arguments; check local auth, seat, handle and action options.' });
});
