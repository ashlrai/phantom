import { afterEach, describe, expect, it, vi } from 'vitest';
import { cmdDriveApp } from '../src/cli/drive-app.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('C446 recovered DESK CLI boundary', () => {
  it.each([
    'http://localhost:7777',
    'http://example.invalid:7777',
    'http://127.0.0.1:7777/unexpected',
    'http://127.0.0.1:7777?unexpected=true',
    'http://fake-user@127.0.0.1:7777',
  ])('rejects an invalid configured origin before any DESK or session request: %s', async origin => {
    const bearer = 'fakedesk0fakedesk0fakedesk0fakedesk0fakedes';
    vi.stubEnv('PHM_DRIVE_ORIGIN', origin);
    vi.stubEnv('PHM_DRIVE_DESK_BEARER', bearer);
    vi.stubEnv('PHM_DRIVE_READ_TOKEN', 'fake-read');
    vi.stubEnv('PHM_DRIVE_MUTATION_TOKEN', 'fake-write');
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});

    expect(await cmdDriveApp(['codex', 'status', '--handle', 'desk-codex:fake.codex', '--json'])).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
    expect(output).toHaveBeenCalledExactlyOnceWith(JSON.stringify({
      ok: false,
      error: 'Drive unavailable or invalid arguments; check local auth, seat, handle and action options.',
    }));
    expect(output.mock.calls.flat().join('')).not.toContain(bearer);
  });
});
