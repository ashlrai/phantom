/** GET /api/verse/fleet/recheck — the authoritative verdict, read-only. */
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { VERSE_FLEET_RECHECK_PATH as PATH, createFleetRecheckApi } from '../src/core/verse/fleet-recheck-api.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { FleetRecheck } from '../src/core/fleet/fleet-recheck.js';
import { WORKBENCH_ROUTE_FAMILIES } from '../src/core/verse/workbench-types.js';

const VERDICT = {
  schema: 'fleet.recheck.v1',
  asOf: '2026-11-14T00:00:00.000Z',
  sections: {},
  overall: { state: 'VERIFIED', missing: [] },
} as unknown as FleetRecheck;

const tmps: string[] = [];
afterEach(() => { while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true }); });

function home(): string {
  const d = mkdtempSync(join(tmpdir(), 'recheck-api-329-'));
  tmps.push(d);
  return d;
}

function row(asOf: string, overall: string): string {
  return JSON.stringify({
    schema: 'fleet.recheck-record.v1', asOf, overall,
    sections: {
      runtime: { state: 'VERIFIED', host: 'h', installedVersion: '1', asOf },
      claims: { state: 'VERIFIED', active: 0, asOf },
      bridge: { state: 'VERIFIED', missingBridge: null, asOf },
      task: { state: 'VERIFIED', id: null, owner: null, claimReceipt: null, asOf },
    },
  });
}

async function call(api: ApiModule, method = 'GET', url = PATH) {
  let status = 0;
  let text = '';
  const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  const handled = await api({ cfg: {}, allowDispatch: true } as VerseApiContext, { url } as IncomingMessage, res, PATH, method);
  return { handled, status, body: text ? JSON.parse(text) : null };
}

describe('fleet recheck api', () => {
  it('returns the injected verdict verbatim', async () => {
    const r = await call(createFleetRecheckApi({ readRecheck: () => VERDICT, home: home }));
    expect(r.handled).toBe(true);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ recheck: VERDICT });
  });

  it('declines other paths', async () => {
    const api = createFleetRecheckApi({ readRecheck: () => VERDICT });
    let status = 0;
    const res = { writeHead(c: number) { status = c; return this; }, end() {} } as unknown as ServerResponse;
    expect(await api({} as VerseApiContext, {} as IncomingMessage, res, '/api/verse/fleet/other', 'GET')).toBe(false);
    expect(status).toBe(0);
  });

  it('?history=2 returns newest-first rows and counts malformed lines', async () => {
    const h = home();
    mkdirSync(join(h, 'fleet'));
    writeFileSync(join(h, 'fleet', 'recheck-log.jsonl'),
      [row('2026-11-14T01:00:00.000Z', 'BLOCKED'), 'not json', row('2026-11-14T02:00:00.000Z', 'VERIFIED'), row('2026-11-14T03:00:00.000Z', 'UNKNOWN')].join('\n') + '\n');
    const r = await call(createFleetRecheckApi({ readRecheck: () => VERDICT, home: () => h }), 'GET', `${PATH}?history=2`);
    expect(r.status).toBe(200);
    expect(r.body.recheck).toEqual(VERDICT);
    expect(r.body.history.rows.map((x: { asOf: string }) => x.asOf)).toEqual(['2026-11-14T03:00:00.000Z', '2026-11-14T02:00:00.000Z']);
    expect(r.body.history.skipped).toBe(1);
    expect(r.body.history.missing).toBe(false);
  });

  it('?history with no log reports missing', async () => {
    const r = await call(createFleetRecheckApi({ readRecheck: () => VERDICT, home }), 'GET', `${PATH}?history=5`);
    expect(r.body.history).toEqual({ rows: [], skipped: 0, missing: true });
  });

  it.each(['0', 'x', '51', '-1', '1.5', ''])('rejects history=%s with 400', async (v) => {
    const r = await call(createFleetRecheckApi({ readRecheck: () => VERDICT, home }), 'GET', `${PATH}?history=${v}`);
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'history must be 1..50' });
  });

  it('rejects non-GET with 405', async () => {
    for (const m of ['POST', 'PUT', 'DELETE']) {
      const r = await call(createFleetRecheckApi({ readRecheck: () => VERDICT, home }), m);
      expect(r.status).toBe(405);
    }
  });

  it('returns 503 when the reader throws, without the message', async () => {
    const r = await call(createFleetRecheckApi({ readRecheck: () => { throw new Error('secret /Users/x'); }, home }));
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ error: 'recheck unavailable' });
  });

  it('never creates the recheck log on GET', async () => {
    const h = home();
    const api = createFleetRecheckApi({ readRecheck: () => VERDICT, home: () => h });
    await call(api);
    await call(api, 'GET', `${PATH}?history=3`);
    expect(existsSync(join(h, 'fleet', 'recheck-log.jsonl'))).toBe(false);
  });

  it('is registered as a desktop-command route family', () => {
    const f = WORKBENCH_ROUTE_FAMILIES.find((x) => x.id === 'fleet-recheck');
    expect(f).toMatchObject({ handler: 'handleFleetRecheckApi', prefixes: [PATH] });
  });
});
