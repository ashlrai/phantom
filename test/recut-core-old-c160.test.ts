/**
 * Recut of #3151 (RQ-APPDRIVE-1): `phm drive <target> <action> --json` drives
 * enrolled agent seats through the existing authenticated loopback session
 * API. These tests exercise the landed behavior end to end through
 * src/cli/drive.ts dispatch -> src/cli/drive-app.ts -> src/core/drive/apps.ts
 * -> the injected fetch. No server, no network, no real tokens.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { cmdDrive } from '../src/cli/drive.js';

const ENV_KEYS = ['PHM_DRIVE_ORIGIN', 'PHM_DRIVE_READ_TOKEN', 'PHM_DRIVE_MUTATION_TOKEN', 'PHM_DRIVE_DESK_BEARER'] as const;
const savedEnv: Record<string, string | undefined> = {};

function useDriveEnv(): void {
  for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  process.env['PHM_DRIVE_ORIGIN'] = 'http://127.0.0.1:7777';
  process.env['PHM_DRIVE_READ_TOKEN'] = 'read-token';
  process.env['PHM_DRIVE_MUTATION_TOKEN'] = 'write-token';
  delete process.env['PHM_DRIVE_DESK_BEARER'];
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

interface FetchCall { url: string; method: string; headers: Record<string, string>; body?: unknown }

function stubVerseApi(): FetchCall[] {
  const calls: FetchCall[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: unknown, init: unknown) => {
    const u = new URL(String(url));
    const i = init as { method: string; headers: Record<string, string>; body?: string };
    calls.push({ url: u.pathname, method: i.method, headers: i.headers, body: i.body ? JSON.parse(i.body) : undefined });
    const path = u.pathname;
    if (path === '/api/verse/bootstrap') return { status: 200, json: async () => ({ seats: [{ id: 'seat-1', engine: 'claude' }] }) };
    if (path === '/api/verse/sessions' && i.method === 'POST') return { status: 201, json: async () => ({ id: 'sess-9' }) };
    if (path === '/api/verse/sessions/sess-9' && i.method === 'GET') {
      return { status: 200, json: async () => ({ session: { engine: 'claude', status: 'idle' }, events: [{ type: 'assistant-message', text: 'answer text' }, { type: 'turn-done', ok: true }] }) };
    }
    if (path.endsWith('/turns')) return { status: 202, json: async () => ({}) };
    return { status: 404, json: async () => ({}) };
  }));
  return calls;
}

describe('phm drive <target> <action> (recut of #3151)', () => {
  it('dispatches a seat start through the mutation token and returns the handle', async () => {
    useDriveEnv();
    const calls = stubVerseApi();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const code = await cmdDrive(['claude', 'start', '--prompt', 'Summarize this project', '--json']);
    expect(code).toBe(0);
    const paths = calls.map((c) => `${c.method} ${c.url}`);
    expect(paths).toEqual(['GET /api/verse/bootstrap', 'POST /api/verse/sessions', 'POST /api/verse/sessions/sess-9/turns']);
    expect(calls[0]!.headers['x-ashlr-token']).toBe('read-token');
    expect(calls[1]!.headers['x-ashlr-token']).toBe('write-token');
    expect(calls[2]!.headers['x-ashlr-token']).toBe('write-token');
    expect(calls[1]!.body).toMatchObject({ seatId: 'seat-1' });
    expect(JSON.parse(log.mock.calls.map((c) => String(c[0])).join(''))).toEqual({ ok: true, handle: 'sess-9' });
  });

  it('status and read-result use the read token on the same handle', async () => {
    useDriveEnv();
    const calls = stubVerseApi();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdDrive(['claude', 'status', '--handle', 'sess-9', '--json'])).toBe(0);
    expect(await cmdDrive(['claude', 'read-result', '--handle', 'sess-9', '--json'])).toBe(0);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
    expect(calls.every((c) => c.headers['x-ashlr-token'] === 'read-token')).toBe(true);
    expect(log.mock.calls.map((c) => String(c[0])).join('')).toContain('answer text');
  });

  it('send-prompt verifies ownership, then posts a turn with the mutation token', async () => {
    useDriveEnv();
    const calls = stubVerseApi();
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdDrive(['claude', 'send-prompt', '--handle', 'sess-9', '--prompt', 'continue', '--json'])).toBe(0);
    expect(calls.map((c) => `${c.method} ${c.url}`)).toEqual(['GET /api/verse/sessions/sess-9', 'POST /api/verse/sessions/sess-9/turns']);
    expect(calls[1]!.headers['x-ashlr-token']).toBe('write-token');
    expect(calls[1]!.body).toEqual({ text: 'continue' });
  });

  it('refuses closed without tokens: fails closed, no fetch made', async () => {
    useDriveEnv();
    delete process.env['PHM_DRIVE_READ_TOKEN'];
    delete process.env['PHM_DRIVE_MUTATION_TOKEN'];
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdDrive(['claude', 'status', '--handle', 'sess-9', '--json'])).toBe(1);
    expect(fetcher).not.toHaveBeenCalled();
    expect(JSON.parse(log.mock.calls.map((c) => String(c[0])).join(''))).toMatchObject({ ok: false });
  });

  it('non-app drive invocations still reach the supervisor path', async () => {
    useDriveEnv();
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await cmdDrive(['--help'])).toBe(0);
    expect(log.mock.calls.map((c) => String(c[0])).join('\n')).toContain('phm drive <devin|claude|codex|phantom>');
    // An unknown flag is a usage error, not an app dispatch.
    expect(await cmdDrive(['--bogus'])).toBe(2);
  });
});
