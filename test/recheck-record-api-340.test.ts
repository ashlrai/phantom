/** POST /api/verse/fleet/recheck/record — the desktop-side record path: run
 * the read-only verdict, append one sanitized row to the local recheck log
 * and answer {recorded:{overall,asOf}}. Seams are faked; one case drives the
 * real appendRecheckRecord against a temp root to prove the log write. */
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { VERSE_FLEET_RECHECK_PATH as PATH, createFleetRecheckApi } from '../src/core/verse/fleet-recheck-api.js';
import type { ApiModule } from '../src/core/verse/api-modules.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import type { FleetRecheck } from '../src/core/fleet/fleet-recheck.js';
import { recheckLogPath, type RecheckRecord } from '../src/core/fleet/recheck-record.js';

const RECORD_PATH = `${PATH}/record`;
const ISO = '2026-11-14T05:00:00.000Z';
const FAKE_HOME = '/home/fakeuser';

const VERDICT = {
  schema: 'fleet.recheck.v1', asOf: ISO,
  overall: { state: 'BLOCKED', missing: [`bridge dead under ${FAKE_HOME}`] },
  sections: {
    runtime: { state: 'VERIFIED', host: 'fake-host', installedVersion: '1.2.3', asOf: ISO },
    claims: { state: 'VERIFIED', active: 0, asOf: ISO },
    bridge: { state: 'BLOCKED', missingBridge: 'slack', asOf: ISO },
    task: { state: 'VERIFIED', task: null, lastVerified: null, asOf: ISO },
  },
} as unknown as FleetRecheck;

const tmps: string[] = [];
afterEach(() => { while (tmps.length) rmSync(tmps.pop()!, { recursive: true, force: true }); });
const tempRoot = (): string => { const d = mkdtempSync(join(tmpdir(), 'rr-api-340-')); tmps.push(d); return d; };

/** The route reads only overall/asOf back out of the appended record. */
const okAppend = () => ({ ok: true as const, record: { overall: 'BLOCKED', asOf: ISO } as RecheckRecord });

async function call(api: ApiModule, method: string, path: string) {
  let status = 0;
  let text = '';
  const res = { writeHead(code: number) { status = code; return this; }, end(body: string) { text = body; } } as unknown as ServerResponse;
  const handled = await api({ cfg: {}, allowDispatch: true } as VerseApiContext, { url: path } as IncomingMessage, res, path, method);
  return { handled, status, body: text ? JSON.parse(text) : null };
}

describe('fleet recheck record api', () => {
  it('POST /record appends once and returns the recorded verdict', async () => {
    const root = tempRoot();
    const calls: unknown[][] = [];
    const api = createFleetRecheckApi({
      readRecheck: () => VERDICT, home: () => root, homeDir: () => FAKE_HOME,
      appendRecord: (...args) => { calls.push(args); return okAppend(); },
    });
    const r = await call(api, 'POST', RECORD_PATH);
    expect(r).toMatchObject({ handled: true, status: 200 });
    expect(r.body).toEqual({ recorded: { overall: 'BLOCKED', asOf: ISO } });
    expect(calls).toEqual([[root, VERDICT, FAKE_HOME]]);
  });

  it('rejects non-POST on /record with 405, without running a recheck', async () => {
    let reads = 0;
    const api = createFleetRecheckApi({ readRecheck: () => { reads++; return VERDICT; }, appendRecord: okAppend });
    for (const m of ['GET', 'PUT', 'DELETE']) {
      expect(await call(api, m, RECORD_PATH)).toMatchObject({ handled: true, status: 405, body: { error: 'method not allowed' } });
    }
    expect(reads).toBe(0);
  });

  it('returns 503 without appending when the recheck throws', async () => {
    let appends = 0;
    const api = createFleetRecheckApi({
      readRecheck: () => { throw new Error('secret /Users/x'); },
      appendRecord: () => { appends++; return okAppend(); },
    });
    expect(await call(api, 'POST', RECORD_PATH)).toMatchObject({ status: 503, body: { error: 'recheck unavailable' } });
    expect(appends).toBe(0);
  });

  it('returns 500 with the module reason when the append fails', async () => {
    const api = createFleetRecheckApi({ readRecheck: () => VERDICT, appendRecord: () => ({ ok: false, reason: 'EROFS' }) });
    expect(await call(api, 'POST', RECORD_PATH)).toMatchObject({ status: 500, body: { error: 'record failed', reason: 'EROFS' } });
  });

  it('returns 409 while another record runs, and records after it clears', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const api = createFleetRecheckApi({ readRecheck: () => gate.then(() => VERDICT), appendRecord: okAppend });
    const pending = call(api, 'POST', RECORD_PATH);
    expect(await call(api, 'POST', RECORD_PATH)).toMatchObject({ status: 409, body: { error: 'recheck already running' } });
    release();
    expect((await pending).status).toBe(200);
    expect((await call(api, 'POST', RECORD_PATH)).status).toBe(200);
  });

  it('clears the in-flight slot after a failed record', async () => {
    let fail = true;
    const api = createFleetRecheckApi({
      readRecheck: () => { if (fail) throw new Error('down'); return VERDICT; },
      appendRecord: okAppend,
    });
    expect((await call(api, 'POST', RECORD_PATH)).status).toBe(503);
    fail = false;
    expect((await call(api, 'POST', RECORD_PATH)).status).toBe(200);
  });

  it('plain GET /recheck still returns the verdict unchanged', async () => {
    const r = await call(createFleetRecheckApi({ readRecheck: () => VERDICT }), 'GET', PATH);
    expect(r).toMatchObject({ status: 200 });
    expect(r.body).toEqual({ recheck: VERDICT });
  });

  it('writes one sanitized row through the real append path', async () => {
    const root = tempRoot();
    const api = createFleetRecheckApi({ readRecheck: () => VERDICT, home: () => root, homeDir: () => FAKE_HOME });
    expect(await call(api, 'POST', RECORD_PATH)).toMatchObject({ status: 200, body: { recorded: { overall: 'BLOCKED', asOf: ISO } } });
    const lines = readFileSync(recheckLogPath(root), 'utf8').split('\n').filter((l) => l !== '');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ schema: 'fleet.recheck-record.v1', overall: 'BLOCKED', asOf: ISO });
    expect(lines[0]).not.toContain(FAKE_HOME); // the home path is redacted before disk
  });
});
