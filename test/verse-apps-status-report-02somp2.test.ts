import type { IncomingMessage, ServerResponse } from 'node:http';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createFleetAppsApi, FLEET_APPS } from '../src/core/verse/fleet-apps-api.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

async function get(api: ApiModule) {
  const req = Object.assign(new PassThrough(), { headers: {}, socket: { remoteAddress: '127.0.0.1' } }) as unknown as IncomingMessage;
  let status = 0, text = '';
  const res = { writeHead(code: number) { status = code; return this; }, end(value: string) { text = value; } } as unknown as ServerResponse;
  await api({} as VerseApiContext, req, res, '/api/verse/fleet/apps', 'GET');
  return { status, body: JSON.parse(text) };
}

describe('fleet apps GET status reports', () => {
  it('keeps only successful boolean readings, preserves order, and caches the snapshot', async () => {
    const reports: Record<string, unknown> = {
      Phantom: { ok: true, running: true },
      Codex: { ok: true, running: false },
      Claude: { ok: false, running: false, code: 'permission_denied', error: 'private refusal' },
      'Grok Bot': { ok: false, running: true, code: 'private refusal' },
      ChatGPT: { running: true },
      Cursor: { ok: 'true', running: false },
      Safari: { ok: true, running: 'yes' },
      'Google Chrome': { ok: true, running: true },
    };
    const exec = vi.fn(async (_file: string, args: string[]) => {
      const report = reports[args[3]!];
      if (args[3] === 'Claude') throw { code: 1, stdout: JSON.stringify(report), stderr: 'private child text' };
      return { stdout: JSON.stringify(report), stderr: 'private child text' };
    });
    const api = createFleetAppsApi({ exec, locateScript: () => '/fake/script', runsDir: '/fake/runs', now: () => 100_000 });
    const first = await get(api);
    expect(first).toEqual({ status: 200, body: {
      v: 1, available: true, generatedAt: new Date(100_000).toISOString(),
      apps: FLEET_APPS.map((app, index) => ({ app, running: [true, false, null, null, null, null, null, true][index], checkedAt: new Date(100_000).toISOString() })),
    } });
    expect(JSON.stringify(first)).not.toMatch(/private|permission_denied/);
    expect(await get(api)).toEqual(first);
    expect(exec).toHaveBeenCalledTimes(FLEET_APPS.length);
    expect(exec.mock.calls.every(([, args]) => args[2] === 'status')).toBe(true);
  });
});
