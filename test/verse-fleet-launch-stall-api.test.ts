import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { handleFleetControlApi } from '../src/core/verse/fleet-control-api.js';
import {
  LAUNCH_STALL_TAIL_BYTES,
  VERSE_FLEET_CONTROL_LAUNCH_STALL_PATH as PATH,
  readLaunchStallView,
  readLogTail,
} from '../src/core/verse/fleet-launch-stall-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

let runs: string;
const NOW = Date.parse('2026-11-09T12:00:00Z');
const tick = (at: string, q: number, launched: number) => `${at} tick run={"devin":0} q=${q} launched=${launched} reap=0\n`;

function seedQueue(): void {
  mkdirSync(join(runs, 'queue', 'run'), { recursive: true });
  writeFileSync(join(runs, 'queue', 'status.json'), JSON.stringify({ lanes: { 'codex-personal': { running: 0 }, devin: { running: 2 } } }));
  const job = (id: string, lane: string, ageMin: number) => {
    const path = join(runs, 'queue', 'run', `${id}.line`);
    writeFileSync(path, `${id}\tfake-repo\t${lane}\n`);
    utimesSync(path, (NOW - ageMin * 60_000) / 1000, (NOW - ageMin * 60_000) / 1000);
  };
  job('RQ-FAKE-A', 'codex-personal', 61);
  job('RQ-FAKE-B', 'codex-personal', 50);
  job('RQ-FAKE-C', 'devin', 90);
}

beforeEach(() => { runs = mkdtempSync(join(tmpdir(), 'launch-stall-')); });
afterEach(() => { vi.unstubAllEnvs(); rmSync(runs, { recursive: true, force: true }); });

async function call(method: string) {
  let status = 0, payload = '';
  const req = { url: PATH, method } as IncomingMessage;
  const res = {
    writeHead(code: number) { status = code; return this; },
    end(body: string) { payload = body; },
  } as unknown as ServerResponse;
  const handled = await handleFleetControlApi({} as VerseApiContext, req, res, PATH, method);
  return { handled, status, body: payload ? JSON.parse(payload) as Record<string, unknown> : null };
}

it('returns the documented view for a stalled dispatcher and a stuck lane', async () => {
  writeFileSync(join(runs, 'dispatchd.log'), tick('2026-11-09 10:00:00', 37, 0) + tick('2026-11-09 10:42:00', 37, 0));
  seedQueue();
  const view = await readLaunchStallView(runs, NOW);
  expect(view).toMatchObject({
    v: 1, generatedAt: '2026-11-09T12:00:00.000Z', source: 'ok',
    stall: { minutes: 42, lastQ: 37, lastReap: 0, min: 30, stalled: true },
    lanes: [{ lane: 'codex-personal', jobs: [{ job: 'RQ-FAKE-A', ageMinutes: 61 }, { job: 'RQ-FAKE-B', ageMinutes: 50 }] }],
  });
});

it('serves the route through the fleet-control family with GET', async () => {
  vi.stubEnv('ASHLR_RUNS_DIR', runs);
  writeFileSync(join(runs, 'dispatchd.log'), tick('2026-11-09 10:00:00', 3, 1));
  seedQueue();
  const { handled, status, body } = await call('GET');
  expect(handled).toBe(true);
  expect(status).toBe(200);
  expect(body).toMatchObject({ v: 1, source: 'ok', stall: { stalled: false, startTime: null } });
});

it('a missing log answers source unavailable, not invented zeros', async () => {
  seedQueue();
  const view = await readLaunchStallView(runs, NOW);
  expect(view.source).toBe('unavailable');
  expect(view.stall).toBeNull();
  expect(view.lanes).toHaveLength(1);
  rmSync(join(runs, 'queue'), { recursive: true });
  expect(await readLaunchStallView(runs, NOW)).toMatchObject({ source: 'unavailable', stall: null, lanes: [] });
});

it('refuses non-GET methods', async () => {
  vi.stubEnv('ASHLR_RUNS_DIR', runs);
  for (const method of ['POST', 'DELETE']) {
    const { handled, status } = await call(method);
    expect(handled).toBe(true);
    expect(status).toBe(405);
  }
});

it('reads only the tail of a log over 512 KiB', async () => {
  const old = tick('2026-11-09 08:00:00', 9, 0);
  const filler = 'x'.repeat(200) + '\n';
  const head = old + filler.repeat(Math.ceil(LAUNCH_STALL_TAIL_BYTES / filler.length) + 10);
  const recent = tick('2026-11-09 11:00:00', 4, 0) + tick('2026-11-09 11:05:00', 4, 0);
  writeFileSync(join(runs, 'dispatchd.log'), head + recent);
  const tail = await readLogTail(join(runs, 'dispatchd.log'));
  expect(Buffer.byteLength(tail)).toBeLessThanOrEqual(LAUNCH_STALL_TAIL_BYTES);
  expect(tail).not.toContain('08:00:00');
  expect(tail.startsWith('x')).toBe(true);
  expect(tail.endsWith(recent)).toBe(true);
  const view = await readLaunchStallView(runs, NOW);
  expect(view.stall).toMatchObject({ minutes: 5, lastQ: 4 });
});

it('adds why from a fresh admission snapshot and diskguard markers', async () => {
  writeFileSync(join(runs, 'dispatchd.log'), tick('2026-11-09 11:50:00', 3, 1));
  seedQueue();
  writeFileSync(join(runs, 'queue', 'run', 'RQ-FAKE-A.diskguard'), '');
  writeFileSync(join(runs, 'queue', 'admission.json'), JSON.stringify({
    schema: 'dispatchd.admission.v2', ts: '2026-11-09T11:59:00Z', admit: true, disabled: true,
    cap: 18, running: 2, disk_free_gb: 41.5, disk_hard_stop_gb: 30,
  }));
  const view = await readLaunchStallView(runs, NOW);
  expect(view.source).toBe('ok');
  expect(view.stall).toMatchObject({ stalled: false });
  expect(view.why).toEqual({
    code: 'disk-reuse-only',
    line: 'Only repair jobs can start: 41 GB free on the runs disk, under the 100 GB guard. 1 job is waiting for disk.',
    detail: ['Load gate is switched off (LOADGATE_OFF); launches are not blocked by load.'],
  });
});

it('scrubs secrets out of the why line', async () => {
  seedQueue();
  writeFileSync(join(runs, 'queue', 'admission.json'), JSON.stringify({
    schema: 'dispatchd.admission.v2', ts: '2026-11-09T11:59:00Z', admit: false, disk_free_gb: 500,
    gate_reason: 'probe failed token=ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE1',
  }));
  const view = await readLaunchStallView(runs, NOW);
  expect(view.why?.code).toBe('load-gate');
  expect(view.why?.line).not.toContain('ghp_FAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKEFAKE1');
});
