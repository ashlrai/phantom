import type { IncomingMessage, ServerResponse } from 'node:http';
import { expect, it, vi } from 'vitest';
import { createFleetDoctorApi } from '../src/core/verse/fleet-doctor-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

import type { FleetDoctorReport } from '../src/cli/fleet-doctor.js';

const report: FleetDoctorReport = { v: 1, generatedAt: '2026-11-03T00:00:00Z', level: 'red',
  checks: [{ name: 'heartbeat', level: 'red', reason: 'queue tick stale' }] };
async function call(run: () => Promise<FleetDoctorReport>, path: string, method: string) {
  const out = { status: 0, body: '' };
  const res = { writeHead: (s: number) => { out.status = s; }, end: (b?: string) => { out.body = b ?? ''; },
    setHeader: () => {}, statusCode: 0 } as unknown as ServerResponse;
  const handled = await createFleetDoctorApi(run)({} as VerseApiContext, {} as IncomingMessage, res, path, method);
  return { handled, ...out, json: out.body ? JSON.parse(out.body) : null };
}
const path = '/api/verse/fleet/doctor';
it('returns the injected report on GET', async () => {
  expect(await call(async () => report, path, 'GET')).toMatchObject({ handled: true, status: 200, json: report });
});
it('loads the default doctor only when its GET route is requested', async () => {
  const run = vi.fn(async () => report);
  const load = vi.fn(() => ({ runFleetDoctor: run }));
  const send = vi.fn();
  vi.resetModules();
  vi.doMock('../src/cli/fleet-doctor.js', load);
  // Keep module-reset coverage independent of the full dashboard import graph.
  vi.doMock('../src/core/web/api.js', () => ({ sendJson: send }));
  try {
    const { createFleetDoctorApi: create } = await import('../src/core/verse/fleet-doctor-api.js');
    const handler = create();
    const res = { writeHead: vi.fn(), end: vi.fn(), setHeader: vi.fn() } as unknown as ServerResponse;
    const ctx = {} as VerseApiContext;
    const req = {} as IncomingMessage;
    expect(await handler(ctx, req, res, '/api/verse/fleet/other', 'GET')).toBe(false);
    expect(await handler(ctx, req, res, path, 'POST')).toBe(true);
    expect(load).not.toHaveBeenCalled();
    expect(await handler(ctx, req, res, path, 'GET')).toBe(true);
    expect(load).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledTimes(1);
    expect(send).toHaveBeenLastCalledWith(res, 200, report);
  } finally {
    vi.doUnmock('../src/cli/fleet-doctor.js');
    vi.doUnmock('../src/core/web/api.js');
    vi.resetModules();
  }
});
it('rejects POST without running the doctor', async () => {
  const run = vi.fn(async () => report);
  expect(await call(run, path, 'POST')).toMatchObject({ handled: true, status: 405 });
  expect(run).not.toHaveBeenCalled();
});
it('ignores unrelated paths without running the doctor', async () => {
  const run = vi.fn(async () => report);
  expect(await call(run, '/api/verse/fleet/other', 'GET')).toMatchObject({ handled: false, status: 0, body: '' });
  expect(run).not.toHaveBeenCalled();
});
it('returns a safe warning with status 200 if the runner throws', async () => {
  const result = await call(async () => { throw new Error('/private/fixture failed'); }, path, 'GET');
  expect(result).toMatchObject({ handled: true, status: 200, json: { v: 1, level: 'warn',
    checks: [{ name: 'doctor', level: 'warn', reason: 'could not run' }] } });
  expect(Number.isNaN(Date.parse(result.json.generatedAt))).toBe(false);
  expect(result.body).not.toContain('/private/fixture');
  expect(result.body).not.toContain('failed');
});
