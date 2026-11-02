import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseStrayStopAction, stopStray, VERSE_FLEET_CONTROL_STRAY_STOP_PATH, type StrayStopDeps } from '../src/core/fleet/stray-stop.js';
import * as evidence from '../src/core/fleet/stray-slots.js';
import { handleFleetHoldsApi } from '../src/core/verse/fleet-holds-api.js';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';

const action = { action: 'stop' as const, lane: 'devin', job: 'RQ-PHX-X', pid: 987654 };
const report = { lanes: [{ lane: action.lane, slotsLost: 1, strays: [{ job: action.job, pid: action.pid, ageSeconds: 60 }] }] };
const dirs: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
async function deps(): Promise<StrayStopDeps> {
  const dir = await mkdtemp(join(tmpdir(), 'stray-stop-')); dirs.push(dir);
  return { readStraySlots: vi.fn().mockResolvedValueOnce(report).mockResolvedValue({ lanes: [] }), kill: vi.fn(), ledgerFile: join(dir, 'stray-stops.jsonl'), now: () => new Date('2026-11-01T00:00:00Z') };
}
it('accepts exactly the action shape and rejects unsafe identities and pids', () => {
  expect(parseStrayStopAction(action)).toEqual(action);
  for (const body of [null, [], {}, { ...action, pid: 1 }, { ...action, pid: '123' }, { ...action, extra: true }, { ...action, pid: 1.5 }, { ...action, pid: Number.MAX_SAFE_INTEGER + 1 }, { ...action, lane: '../x' }, { ...action, job: 'x/y' }, { ...action, action: 'kill' }]) expect(parseStrayStopAction(body)).toBeNull();
});
it('sends only SIGTERM, appends a scrubbed ledger line and returns a fresh report', async () => {
  const d = await deps();
  // Generated shape only: this is not a credential or a stored secret fixture.
  const target = { ...action, job: ['ghp', 'a'.repeat(36)].join('_') };
  d.readStraySlots = vi.fn().mockResolvedValueOnce({ lanes: [{ lane: target.lane, slotsLost: 1, strays: [{ job: target.job, pid: target.pid, ageSeconds: 60 }] }] }).mockResolvedValue({ lanes: [] });
  expect(await stopStray(target, d)).toEqual({ v: 1, lane: target.lane, job: target.job, pid: target.pid, result: 'signalled', report: { lanes: [] } });
  expect(d.kill).toHaveBeenCalledExactlyOnceWith(target.pid, 'SIGTERM');
  const line = await readFile(d.ledgerFile, 'utf8');
  expect(line).not.toContain(target.job);
  expect(JSON.parse(line)).toEqual({ at: d.now().toISOString(), lane: target.lane, job: '[REDACTED]', pid: target.pid, result: 'signalled' });
  expect(line.endsWith('\n')).toBe(true);
  expect(line.trim().split('\n')).toHaveLength(1);
  expect(vi.mocked(d.readStraySlots)).toHaveBeenCalledTimes(2);
});
it.each([{ ...action, pid: 987655 }, { ...action, lane: 'other' }, { ...action, job: 'other' }, { ...action, pid: process.pid }])('refuses a mismatched or own process: %j', async candidate => {
  const d = await deps();
  await expect(stopStray(candidate, d)).rejects.toMatchObject({ status: 409, code: 'not-a-stray' });
  expect(d.kill).not.toHaveBeenCalled();
});
it('never signals its own process even when the report lists it', async () => {
  const d = await deps();
  d.readStraySlots = async () => ({ lanes: [{ lane: action.lane, slotsLost: 1, strays: [{ job: action.job, pid: process.pid, ageSeconds: 1 }] }] });
  await expect(stopStray({ ...action, pid: process.pid }, d)).rejects.toMatchObject({ status: 409, code: 'not-a-stray' });
  expect(d.kill).not.toHaveBeenCalled();
});
it('refuses a pid absent from the fresh evidence', async () => {
  const d = await deps(); d.readStraySlots = vi.fn(async () => ({ lanes: [] }));
  await expect(stopStray(action, d)).rejects.toMatchObject({ status: 409, code: 'not-a-stray' });
  expect(d.kill).not.toHaveBeenCalled();
});
it('records ESRCH as already gone', async () => {
  const d = await deps(); d.kill = vi.fn(() => { throw Object.assign(new Error(), { code: 'ESRCH' }); });
  expect(await stopStray(action, d)).toMatchObject({ result: 'already-gone' });
  expect(JSON.parse(await readFile(d.ledgerFile, 'utf8'))).toMatchObject({ result: 'already-gone' });
});
it('maps EPERM to a conflict', async () => {
  const d = await deps(); d.kill = vi.fn(() => { throw Object.assign(new Error(), { code: 'EPERM' }); });
  await expect(stopStray(action, d)).rejects.toMatchObject({ status: 409, code: 'not-permitted' });
});
async function request(body: unknown, method = 'POST', allowDispatch = true, authorized = true) {
  const token = 'test-mutation-token';
  const req = Readable.from([JSON.stringify(body)]) as IncomingMessage;
  req.headers = { 'content-type': 'application/json', 'x-ashlr-token': authorized ? token : '' };
  const res = { writeHead: vi.fn(), end: vi.fn() };
  const handled = await handleFleetHoldsApi({ token, allowDispatch } as VerseApiContext, req, res as unknown as ServerResponse, VERSE_FLEET_CONTROL_STRAY_STOP_PATH, method);
  return { handled, res };
}
it('handles POST validation and non-stray conflicts while leaving GET to its owner', async () => {
  vi.spyOn(evidence, 'readStraySlots').mockResolvedValue({ lanes: [] });
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  const bad = await request({ ...action, pid: 1 });
  expect(bad.res.writeHead).toHaveBeenCalledWith(400, expect.anything());
  const stale = await request(action);
  expect(stale.res.writeHead).toHaveBeenCalledWith(409, expect.anything());
  expect(JSON.parse(stale.res.end.mock.calls[0][0])).toMatchObject({ code: 'not-a-stray' });
  expect(kill).not.toHaveBeenCalled();
  expect((await request({}, 'GET')).handled).toBe(false);
  expect((await request(action, 'POST', false)).res.writeHead).toHaveBeenCalledWith(404, expect.anything());
  expect((await request(action, 'POST', true, false)).res.writeHead).toHaveBeenCalledWith(401, expect.anything());
});
