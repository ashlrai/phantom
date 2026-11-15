import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { handleFleetHoldsApi } from '../src/core/verse/fleet-holds-api.js';
import { VERSE_FLEET_CONTROL_HOLDS_PATH as PATH } from '../src/core/fleet/runs-lane-hold.js';
import type { LaneTargetsV1 } from '../src/core/fleet/runs-lane-targets.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

let dir: string;
let slotsPath: string;
const fixture = () => ({
  sol: { target: 2, floor: 0, ceiling: 4, held: false, last_change: 1793448000 },
  devin: { target: 2, floor: 0, ceiling: 4, held: true, held_reason: 'manual: operator', held_by: 'mason', last_change: 1793448000 },
  claude: { target: 1, floor: 0, ceiling: 3, held: true, held_reason: 'autobackoff fake until=2026-11-01T00:00:00Z', held_until: '2026-11-01T00:00:00Z', held_by: 'autobackoff', last_change: 1793448000 },
});
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'holds-hold-route-'));
  vi.stubEnv('ASHLR_RUNS_DIR', dir);
  await mkdir(join(dir, 'queue'));
  slotsPath = join(dir, 'queue/slots.json');
  await writeFile(slotsPath, JSON.stringify(fixture()));
});
afterEach(async () => { vi.unstubAllEnvs(); await rm(dir, { recursive: true, force: true }); });
const slots = async () => JSON.parse(await readFile(slotsPath, 'utf8')) as Record<string, Record<string, unknown>>;
async function call(method: string, body?: unknown, token = 'fixture-token', url = PATH, allowDispatch = true) {
  const req = new PassThrough() as IncomingMessage & PassThrough;
  Object.assign(req, { method, url, headers: { 'content-type': 'application/json', 'x-ashlr-token': token } });
  req.end(body === undefined ? undefined : JSON.stringify(body));
  let status = 0, payload = '';
  const res = {
    writeHead(code: number) { status = code; return this; },
    end(chunk?: string) { payload = chunk ?? ''; return this; },
  } as unknown as ServerResponse;
  const ctx = { token: 'fixture-token', allowDispatch } as VerseApiContext;
  const handled = await handleFleetHoldsApi(ctx, req, res, new URL(url, 'http://localhost').pathname, method);
  return { handled, status, body: payload ? JSON.parse(payload) as LaneTargetsV1 : null };
}
it('holds a lane for N minutes and returns refreshed LaneTargetsV1', async () => {
  const before = Date.now();
  const result = await call('POST', { lane: 'sol', action: 'hold', minutes: 30, reason: 'quiet window' });
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ v: 1, sourceState: 'healthy' });
  const row = result.body?.lanes.find((entry) => entry.lane === 'sol');
  expect(row).toMatchObject({ lane: 'sol', held: true, heldReason: 'quiet window', heldUntil: expect.any(String) });
  // held_until is seconds-precision: it can land up to a second early.
  const until = Date.parse(row!.heldUntil!);
  expect(until).toBeGreaterThanOrEqual(before + 30 * 60_000 - 1_000);
  expect(until).toBeLessThan(Date.now() + 31 * 60_000);
  const file = await slots();
  expect(file.sol).toMatchObject({ held: true, held_reason: 'quiet window', held_by: expect.stringMatching(/^phantom Phantom desktop /) });
  expect(file.devin).toEqual(fixture().devin);
});
it('defaults the hold reason and accepts a printable reason up to 120 chars', async () => {
  expect((await call('POST', { lane: 'sol', action: 'hold', minutes: 5 })).status).toBe(200);
  expect((await slots()).sol.held_reason).toBe('held from desktop');
  const long = 'x'.repeat(120);
  expect((await call('POST', { lane: 'sol', action: 'hold', minutes: 5, reason: long })).status).toBe(200);
  expect((await slots()).sol.held_reason).toBe(long);
});
it.each([0, 1441, 1.5, '30', -5, undefined])('rejects minutes %j with 400 and no write', async (minutes) => {
  const original = await readFile(slotsPath, 'utf8');
  const body: Record<string, unknown> = { lane: 'sol', action: 'hold' };
  if (minutes !== undefined) body.minutes = minutes;
  expect((await call('POST', body)).status).toBe(400);
  expect(await readFile(slotsPath, 'utf8')).toBe(original);
});
it('rejects a bad lane, extra keys and an unprintable reason', async () => {
  const original = await readFile(slotsPath, 'utf8');
  for (const bad of [
    { lane: 'Sol', action: 'hold', minutes: 30 },
    { lane: 'sol', action: 'hold', minutes: 30, extra: 1 },
    { lane: 'sol', action: 'hold', minutes: 'x' },
    { lane: 'sol', action: 'hold', minutes: 30, reason: 'bad\nreason' },
    { lane: 'sol', action: 'hold', minutes: 30, reason: 'x'.repeat(121) },
    { lane: 'sol', action: 'hold' },
    { lane: 'sol', action: 'release', minutes: 30 },
  ]) {
    expect((await call('POST', bad)).status).toBe(400);
  }
  expect(await readFile(slotsPath, 'utf8')).toBe(original);
});
it('requires dispatch and the mutation token', async () => {
  const body = { lane: 'sol', action: 'hold', minutes: 30 };
  expect((await call('POST', body, 'fixture-token', PATH, false)).status).toBe(404);
  expect((await call('POST', body, '')).status).toBe(401);
  expect((await slots()).sol.held).toBe(false);
});
it('answers 400 for an unknown lane and never overwrites a hold a person placed', async () => {
  const original = await readFile(slotsPath, 'utf8');
  expect((await call('POST', { lane: 'absent', action: 'hold', minutes: 30 }))).toMatchObject({ status: 400, body: { code: 'unknown-lane' } });
  expect((await call('POST', { lane: 'devin', action: 'hold', minutes: 30 }))).toMatchObject({ status: 422, body: { code: 'manual-hold' } });
  expect(await readFile(slotsPath, 'utf8')).toBe(original);
});
it('serializes concurrent hold posts: one 200, one 409', async () => {
  const results = await Promise.all([
    call('POST', { lane: 'sol', action: 'hold', minutes: 30 }),
    call('POST', { lane: 'sol', action: 'hold', minutes: 30 }),
  ]);
  expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
  expect((await slots()).sol).toMatchObject({ held: true, held_reason: 'held from desktop' });
});
it('refreshes a hold Phantom itself placed', async () => {
  expect((await call('POST', { lane: 'sol', action: 'hold', minutes: 30 })).status).toBe(200);
  const first = Date.parse((await slots()).sol.held_until as string);
  const again = await call('POST', { lane: 'sol', action: 'hold', minutes: 60, reason: 'longer' });
  expect(again.status).toBe(200);
  expect(Date.parse((await slots()).sol.held_until as string)).toBeGreaterThan(first);
});
it('still releases an autobackoff hold', async () => {
  const released = await call('POST', { lane: 'claude', action: 'release' });
  expect(released.status).toBe(200);
  expect(released.body?.lanes.find((entry) => entry.lane === 'claude')).toMatchObject({ held: false });
  expect((await slots()).claude.held).toBe(false);
});
