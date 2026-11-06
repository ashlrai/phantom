import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { describe, expect, it, vi } from 'vitest';
import { createFleetUsageAuditApi, VERSE_FLEET_USAGE_AUDIT_PATH as PATH } from '../src/core/verse/fleet-usage-audit-api.js';
import { mountedApiModules, type VerseApiContext } from '../src/core/verse/verse-api.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import { auditUsageMotion } from '../src/core/fleet/usage-motion-audit.js';

async function call(api: ApiModule, url = PATH, method = 'GET') {
  let status = 404, text = '';
  const req = Object.assign(new PassThrough(), { url, method }) as IncomingMessage;
  const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  const handled = await api({ cfg: {} } as VerseApiContext, req, res, new URL(url, 'http://localhost').pathname, method);
  return { handled, status, body: text ? JSON.parse(text) : null, text };
}
describe('fleet usage audit read route', () => {
  it('returns the injected audit, preserving nulls and forwarding bounds', async () => {
    const view = await auditUsageMotion();
    const audit = vi.fn(async () => view);
    const result = await call(createFleetUsageAuditApi({ audit }), `${PATH}?windowMinutes=30&freshnessMinutes=10`);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ v: 1, generatedAt: view.generatedAt, audit: view });
    expect(audit).toHaveBeenCalledWith({ windowMinutes: 30, freshnessMinutes: 10 });
  });
  it.each(['windowMinutes=5', 'windowMinutes=361', 'freshnessMinutes=4', 'freshnessMinutes=121', 'other=1', 'windowMinutes=', 'windowMinutes=NaN', 'windowMinutes=30&windowMinutes=60', 'windowMinutes=30.5'])(
    'rejects invalid query %s without auditing', async query => {
      const audit = vi.fn();
      const result = await call(createFleetUsageAuditApi({ audit }), `${PATH}?${query}`);
      expect(result.status).toBe(400);
      expect(result.body.error).toBe('Invalid query.');
      expect(audit).not.toHaveBeenCalled();
    });
  it('declines POST and foreign routes (404 fallback)', async () => {
    const audit = vi.fn();
    const api = createFleetUsageAuditApi({ audit });
    expect(await call(api, PATH, 'POST')).toMatchObject({ status: 404, handled: false });
    expect((await call(api, '/unrelated')).handled).toBe(false);
    expect(audit).not.toHaveBeenCalled();
  });
  it('redacts thrown errors', async () => {
    const result = await call(createFleetUsageAuditApi({ audit: async () => { throw new Error('/private/fixture/path'); } }));
    expect(result.status).toBe(503);
    expect(result.body).toEqual({ v: 1, error: 'usage audit unavailable' });
    expect(result.text).not.toContain('/private');
  });
  it('is mounted last and answers through the default loader', async () => {
    const entry = mountedApiModules().at(-1)!;
    expect(entry.id).toBe('fleet-usage-audit');
    const result = await call(await entry.load());
    expect(result.status).toBe(200);
    expect(result.body.v).toBe(1);
  });
  it('uses custom bounds for classification without changing the CLI defaults or journal', async () => {
    const queueDir = await mkdtemp(join(tmpdir(), 'audit-route-'));
    try {
      const now = () => new Date('2026-10-31T20:00:00Z');
      const journal = [
        { pool: 'fixture', pctUsed: 10, writtenAt: '2026-10-31T19:10:00Z' },
        { pool: 'fixture', pctUsed: 13.2, writtenAt: '2026-10-31T19:40:00Z' },
      ].map(r => JSON.stringify(r)).join('\n');
      await writeFile(join(queueDir, 'usage-readings.log'), journal);
      const defaults = await auditUsageMotion({ queueDir, now });
      expect(defaults.lanes.find(l => l.lane === 'fixture')?.classification).toBe('insufficient-evidence');
      const api = createFleetUsageAuditApi({ audit: options => auditUsageMotion({ ...options, queueDir, now }) });
      const result = await call(api, `${PATH}?windowMinutes=30&freshnessMinutes=25`);
      expect(result.body.audit.lanes.find((l: { lane: string }) => l.lane === 'fixture')).toMatchObject({ classification: 'moving', observedMinutes: 30 });
      expect(await readFile(join(queueDir, 'usage-readings.log'), 'utf8')).toBe(journal);
    } finally { await rm(queueDir, { recursive: true, force: true }); }
  });
  it('applies optional bounds while defaults remain unchanged', async () => {
    expect(await auditUsageMotion()).toMatchObject({ windowMinutes: 60, freshnessMinutes: 15 });
    expect(await auditUsageMotion({ windowMinutes: 30, freshnessMinutes: 10 })).toMatchObject({ windowMinutes: 30, freshnessMinutes: 10 });
  });
});
