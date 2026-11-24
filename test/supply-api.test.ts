import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it } from 'vitest';
import type { SupplyDoctorReport } from '../src/core/fleet/supply-doctor.js';
import { handleSupplyApi } from '../src/core/verse/supply-api.js';

function fakeRes() {
  const out = { status: 0, body: '' };
  const res = { writeHead: (s: number) => { out.status = s; return res; }, setHeader: () => res, end: (b?: string) => { out.body = b ?? ''; } } as unknown as ServerResponse;
  return { out, res };
}
const req = {} as IncomingMessage;

describe('GET /api/verse/supply', () => {
  it('returns the doctor.supply.v1 report as-is', async () => {
    const report = { schema: 'doctor.supply.v1', verdict: 'self-supply has not landed a job in 24 h' } as SupplyDoctorReport;
    const { out, res } = fakeRes();
    expect(await handleSupplyApi(req, res, 'GET', async () => report)).toBe(true);
    expect(out.status).toBe(200);
    expect(JSON.parse(out.body)).toMatchObject({ schema: 'doctor.supply.v1', verdict: report.verdict });
  });
  it('refuses writes and answers 503 when the read throws', async () => {
    const post = fakeRes();
    await handleSupplyApi(req, post.res, 'POST', async () => { throw new Error('no'); });
    expect(post.out.status).toBe(405);
    const bad = fakeRes();
    await handleSupplyApi(req, bad.res, 'GET', async () => { throw new Error('no'); });
    expect(bad.out.status).toBe(503);
  });
});
