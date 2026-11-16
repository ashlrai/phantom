/** RQ-PHX-REDTESTFIXC460 (recut of #5029 / RQ-PHX-RECUTCOREO1S139) —
 * coverage the source suite does not carry, through the same real entry
 * points: ready.tsv rows that cannot name a pool are dropped-and-counted
 * (never attributed by guessing), a queue.v1 job in a non-live non-READY
 * state is listed but counted in neither bucket, and an id-less TSV row is
 * suppressed only while queue.v1 can deduplicate it — when the JSON file is
 * absent the same row is served honestly. All files are plain fakes under a
 * per-test tmp dir; no real home, registry or GitHub read runs.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AshlrConfig } from '../src/core/types.js';
import {
  buildWorkbenchFleetView,
  WB_FLEET_PATH,
  type WorkbenchFleetViewDeps,
} from '../src/core/web/workbench-fleet-view.js';
import { handleWbApi, type WbApiDeps } from '../src/core/web/wb-read-api.js';
import { makeCfg } from './helpers/h1-fixture.js';

let tmpDir: string;
let queueDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'recut-c460-'));
  queueDir = join(tmpDir, 'queue');
  mkdirSync(queueDir, { recursive: true });
});

afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

const cfg = (): AshlrConfig => makeCfg();
const viewDeps = (): WorkbenchFleetViewDeps => ({ queueDir, paths: () => [] });
const apiDeps = (): WbApiDeps => ({ fleet: viewDeps() });

const get = { method: 'GET' } as unknown as IncomingMessage;

function fakeResponse(): { res: ServerResponse; status: () => number; body: () => unknown } {
  let status = 0;
  let raw = '';
  const res = {
    writeHead(code: number) { status = code; return res; },
    end(chunk?: string) { raw = chunk ?? ''; return res; },
  } as unknown as ServerResponse;
  return { res, status: () => status, body: () => JSON.parse(raw) };
}

describe('workbench.fleet.v1 jobs section — recut-c460', () => {
  it('counts a ready.tsv row with no parseable pool as dropped, never guessed into a lane', async () => {
    writeFileSync(join(queueDir, 'ready.tsv'), [
      'id\tstatus\tpool\ttier\trepo\tpriority\ttitle',
      'RQ-7\tREADY\tdevin\twork\tphantom\tP2\tkept row',
      'RQ-8\tREADY\t\twork\tphantom\tP1\tpool missing — must not be guessed',
      '',
    ].join('\n'));
    const view = await buildWorkbenchFleetView(cfg(), viewDeps());
    expect(view.jobs.state).toBe('ok');
    expect(view.jobs.sources).toEqual({ queueV1: 'missing', readyTsv: 'ok' });
    expect(view.jobs.dropped).toBe(1);
    expect(view.jobs.jobs.map((j) => j.id)).toEqual(['RQ-7']);
    expect(view.jobs.counts).toMatchObject({ ready: 1, total: 1 });
  });

  it('serves a non-live non-READY queue.v1 job through the real route without inflating live or ready counts', async () => {
    writeFileSync(join(queueDir, 'queue.v1.json'), JSON.stringify({
      schema: 'queue.v1',
      jobs: [{ id: 'RQ-5', status: 'HELD', pool: 'devin', repo: 'phantom' }],
    }));
    // An id-less TSV row (header with no id column) is suppressed while
    // queue.v1 is authoritative — it cannot be deduplicated against it.
    writeFileSync(join(queueDir, 'ready.tsv'), [
      'status\tpool\ttier\trepo\tpriority\ttitle',
      'READY\tdevin\twork\tphantom\tP3\tid-less tsv row',
    ].join('\n'));

    const { res, status, body } = fakeResponse();
    expect(await handleWbApi(get, res, cfg(), WB_FLEET_PATH, apiDeps())).toBe(true);
    expect(status()).toBe(200);
    const payload = body() as {
      schema?: string;
      jobs?: { counts: { live: number; ready: number; total: number }; jobs: { id: string | null; status: string; live: boolean }[] };
    };
    expect(payload.schema).toBe('workbench.fleet.v1');
    expect(payload.jobs?.jobs).toEqual([
      { id: 'RQ-5', status: 'HELD', pool: 'devin', repo: 'phantom', tier: null, priority: null, summary: null, at: null, live: false, source: 'queue.v1' },
    ]);
    expect(payload.jobs?.counts).toEqual({ live: 0, ready: 0, total: 1 });
  });

  it('serves the same id-less TSV row when queue.v1 is absent — nothing to deduplicate against', async () => {
    writeFileSync(join(queueDir, 'ready.tsv'), [
      'status\tpool\ttier\trepo\tpriority\ttitle',
      'READY\tdevin\twork\tphantom\tP3\tid-less tsv row',
    ].join('\n'));
    const view = await buildWorkbenchFleetView(cfg(), viewDeps());
    expect(view.jobs.jobs).toHaveLength(1);
    expect(view.jobs.jobs[0]).toMatchObject({
      id: null, status: 'READY', pool: 'devin', summary: 'id-less tsv row', live: false, source: 'ready.tsv',
    });
    expect(view.jobs.counts).toEqual({ live: 0, ready: 1, total: 1 });
  });
});
