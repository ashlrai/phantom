/** RQ-PHX-RECHECKREPLYPREVIEW349 — GET ?reply=1 returns the formatter's exact text. Fake values only. */
import { mkdtempSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { VERSE_FLEET_RECHECK_PATH as PATH, createFleetRecheckApi } from '../src/core/verse/fleet-recheck-api.js';
import { formatRecheckReply } from '../src/core/fleet/fleet-recheck-reply.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { FleetRecheck } from '../src/core/fleet/fleet-recheck.js';

const ISO = '2026-11-14T05:00:00.000Z';
const FAKE_HOME = '/home/fakeuser';
const VERDICT = {
  schema: 'fleet.recheck.v1', asOf: ISO,
  overall: { state: 'BLOCKED', missing: [`bridge dead under ${FAKE_HOME}/x`] },
  sections: {
    runtime: { state: 'VERIFIED', host: 'fake-host', installedVersion: '1.2.3', asOf: ISO, fleetState: { ageSeconds: 5, stale: false } },
    claims: { state: 'VERIFIED', active: 0, top: [], asOf: ISO },
    bridge: { state: 'BLOCKED', missingBridge: 'slack', channels: [], asOf: ISO },
    task: { state: 'VERIFIED', task: null, lastVerified: null, missing: [], asOf: ISO },
  },
} as unknown as FleetRecheck;

const tmps: string[] = [];
afterEach(() => { while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true }); });

async function get(api: ApiModule, url: string) {
  let status = 0;
  let text = '';
  const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  await api({ cfg: {}, allowDispatch: true } as VerseApiContext, { url } as IncomingMessage, res, PATH, 'GET');
  return { status, body: JSON.parse(text) as Record<string, unknown> };
}
const mk = (home = '/nonexistent-349') => createFleetRecheckApi({ readRecheck: () => VERDICT, home: () => home });

describe('fleet recheck api ?reply=1', () => {
  it('returns the formatter text verbatim', async () => {
    const r = await get(mk(), `${PATH}?reply=1`);
    expect(r.status).toBe(200);
    expect(r.body.reply).toBe(formatRecheckReply(VERDICT));
  });
  it('carries no home path from the verdict', async () => {
    const r = await get(mk(), `${PATH}?reply=1`);
    expect(r.body.reply).toEqual(expect.stringContaining('bridge dead'));
    expect(String(r.body.reply)).not.toContain(FAKE_HOME);
  });
  it('rejects reply values other than 1', async () => {
    const r = await get(mk(), `${PATH}?reply=2`);
    expect(r.status).toBe(400);
    expect(r.body).toEqual({ error: 'reply must be 1' });
  });
  it('omits reply when not asked', async () => {
    const r = await get(mk(), PATH);
    expect(r.status).toBe(200);
    expect(Object.keys(r.body)).toEqual(['recheck']);
  });
  it('combines with history', async () => {
    const root = mkdtempSync(join(tmpdir(), 'rr-reply-349-'));
    tmps.push(root);
    const r = await get(mk(root), `${PATH}?reply=1&history=3`);
    expect(r.status).toBe(200);
    expect(r.body.reply).toBe(formatRecheckReply(VERDICT));
    expect(r.body.history).toBeDefined();
  });
});
