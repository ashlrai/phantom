/**
 * verse/fleet-main-red-age-api.ts — GET /api/verse/fleet/main-red-age. The
 * handler is invoked directly with injected deps; no server, no real files.
 */
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import {
  createFleetMainRedAgeApi,
  VERSE_FLEET_MAIN_RED_AGE_PATH as PATH,
  type FleetMainRedAgeApiDeps,
} from '../src/core/verse/fleet-main-red-age-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const AT = '2026-11-02T12:00:00.000Z';
const state = JSON.stringify({
  'o/one': { state: 'red', red_first: '2026-11-02T10:00:00Z', attempts: 2, cur_job: 'RQ-1' },
  'o/two': { state: 'red', red_since: '2026-11-02T11:30:00Z', attempts: 0 },
  'o/three': { state: 'green', attempts: 1 },
});

const deps = (raw: string | null = state): Required<FleetMainRedAgeApiDeps> => ({
  readState: vi.fn(async () => raw),
  now: vi.fn(() => new Date(AT)),
});
const ctx = { token: 'fixture-token', allowDispatch: false } as VerseApiContext;

async function call(method: string, url = PATH, d = deps()) {
  const req = new PassThrough() as IncomingMessage & PassThrough;
  Object.assign(req, { method, url, headers: {} });
  req.end();
  let status = 0;
  let payload = '';
  const res = {
    writeHead(code: number) { status = code; return this; },
    end(chunk?: string) { payload = chunk ?? ''; return this; },
  } as unknown as ServerResponse;
  const handled = await createFleetMainRedAgeApi(d)(ctx, req, res, new URL(url, 'http://localhost').pathname, method);
  return { handled, status, json: payload ? (JSON.parse(payload) as Record<string, unknown>) : null, deps: d };
}

describe('GET /api/verse/fleet/main-red-age', () => {
  it('returns per-repo state, minutes red, attempts and current job', async () => {
    const result = await call('GET');
    expect(result.handled).toBe(true);
    expect(result.status).toBe(200);
    expect(result.json).toEqual({
      v: 1, generatedAt: AT, known: true,
      repos: [
        { repo: 'o/one', state: 'red', redSince: '2026-11-02T10:00:00Z', redMinutes: 120, attempts: 2, currentJob: 'RQ-1' },
        { repo: 'o/two', state: 'red', redSince: '2026-11-02T11:30:00Z', redMinutes: 30, attempts: 0, currentJob: null },
        { repo: 'o/three', state: 'green', redSince: null, redMinutes: null, attempts: 1, currentJob: null },
      ],
    });
    expect(result.deps.readState).toHaveBeenCalledOnce();
  });

  it('answers known:false when the state file is missing — never green', async () => {
    const result = await call('GET', PATH, deps(null));
    expect(result.status).toBe(200);
    expect(result.json).toEqual({ v: 1, generatedAt: AT, known: false, repos: [] });
    expect(JSON.stringify(result.json)).not.toContain('green');
  });

  it('answers known:false for corrupt or unreadable state — never green', async () => {
    for (const raw of ['not json{', '[1, 2]', '"red"', '']) {
      const result = await call('GET', PATH, deps(raw));
      expect(result.status).toBe(200);
      expect(result.json).toMatchObject({ known: false, repos: [] });
    }
    const d = deps(state);
    d.readState.mockRejectedValue(new Error('cannot read /private/path/here'));
    const result = await call('GET', PATH, d);
    expect(result.status).toBe(200);
    expect(result.json).toMatchObject({ known: false, repos: [] });
    expect(JSON.stringify(result.json)).not.toContain('/private/path');
  });

  it('accepts a top-level {"repos": {...}} wrapper', async () => {
    const wrapped = JSON.stringify({ repos: { 'o/one': { state: 'red', red_first: '2026-11-02T10:00:00Z', attempts: 2, cur_job: 'RQ-1' } } });
    const result = await call('GET', PATH, deps(wrapped));
    expect(result.json).toMatchObject({ known: true });
    expect((result.json!.repos as unknown[]).length).toBe(1);
  });

  it('never leaks the state path and marks unrecognized states unknown, not green', async () => {
    const d = deps(JSON.stringify({ 'o/five': { state: 'crimson', red_first: '2026-11-02T10:30:00Z' } }));
    const result = await call('GET', PATH, d);
    expect(result.status).toBe(200);
    expect(result.json!.repos).toEqual([
      { repo: 'o/five', state: 'unknown', redSince: '2026-11-02T10:30:00Z', redMinutes: 90, attempts: null, currentJob: null },
    ]);
    expect(JSON.stringify(result.json)).not.toContain('/guardian');
  });

  it('rejects unknown query parameters', async () => {
    const result = await call('GET', `${PATH}?bogus=1`);
    expect(result.status).toBe(400);
    expect(result.json).toMatchObject({ code: 'VERSE_INVALID' });
    expect(result.deps.readState).not.toHaveBeenCalled();
  });

  it('answers 405 for other methods on the path and false for other paths', async () => {
    expect((await call('POST')).status).toBe(405);
    expect((await call('DELETE')).status).toBe(405);
    expect((await call('GET', '/api/verse/fleet/main-red-age/extra')).handled).toBe(false);
    expect((await call('GET', '/api/verse/other')).handled).toBe(false);
  });
});
