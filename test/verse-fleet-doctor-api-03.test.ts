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
