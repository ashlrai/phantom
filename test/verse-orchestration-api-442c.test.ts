import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { VerseApiContext } from '../src/core/verse/verse-api.js';
import { specialistRosterDirectory } from '../src/core/fleet/roster.js';
const send = vi.hoisted(() => vi.fn());
vi.mock('../src/core/web/api.js', () => ({ sendJson: send }));
import { createFleetOrchestrationApi } from '../src/core/verse/fleet-orchestration-api.js';

const path = '/api/verse/fleet/control/orchestration';
const call = (api: ReturnType<typeof createFleetOrchestrationApi>, url = path, method = 'GET') =>
  api({} as VerseApiContext, { url } as IncomingMessage, {} as ServerResponse, url.split('?')[0]!, method);
const payload = { schemaVersion: 1 as const, authority: 'none' as const, source: 'ok' as const, total: 0,
  truncated: false, counts: { reserved: 0, admitted: 0, complete: 0 }, unresolved: [], receipts: [] };
let home: string | undefined;
beforeEach(() => send.mockClear());
afterEach(() => {
  vi.useRealTimers(); vi.unstubAllEnvs();
  if (home) rmSync(home, { recursive: true, force: true });
  home = undefined;
});
it('passes through the reader payload and ignores unrelated routes', async () => {
  const read = vi.fn(() => payload), api = createFleetOrchestrationApi(read);
  expect(await call(api, '/unrelated')).toBe(false);
  expect(read).not.toHaveBeenCalled();
  expect(await call(api)).toBe(true);
  expect(send.mock.lastCall!.slice(1)).toEqual([200, payload]);
});
it.each([['POST', path, 405], ['GET', `${path}?limit=1`, 400]])('rejects %s %s without reading', async (method, url, status) => {
  const read = vi.fn(() => payload);
  expect(await call(createFleetOrchestrationApi(read), url, method)).toBe(true);
  expect(send.mock.lastCall![1]).toBe(status);
  expect(read).not.toHaveBeenCalled();
});
it('sanitizes reader errors', async () => {
  await call(createFleetOrchestrationApi(() => { throw new Error('/private/journal'); }));
  expect(send.mock.lastCall!.slice(1)).toEqual([503, { error: 'orchestration journal unavailable' }]);
});
it('times out after five seconds', async () => {
  vi.useFakeTimers();
  const pending = call(createFleetOrchestrationApi(() => new Promise<typeof payload>(() => {})));
  await vi.advanceTimersByTimeAsync(5_001);
  await pending;
  expect(send.mock.lastCall!.slice(1)).toEqual([503, { error: 'orchestration journal unavailable' }]);
  expect(vi.getTimerCount()).toBe(0);
});
it('reads real reserved and complete receipts without writing the roster', async () => {
  home = mkdtempSync(join(tmpdir(), 'orchestration-api-'));
  vi.stubEnv('HOME', home);
  const directory = specialistRosterDirectory();
  mkdirSync(directory, { recursive: true });
  const file = join(directory, 'orchestration.json');
  const receipts = (['reserved', 'complete'] as const).map((status, i) => ({
    key: String(i + 1).repeat(64), job: `RQ-FIXTURE-${i}`, lane: 'fixture', specialist: `specialist-${i}`,
    assignedAt: `2026-11-0${i + 1}T00:00:00.000Z`, status,
  }));
  writeFileSync(file, JSON.stringify({ version: 1, receipts }));
  const before = readFileSync(file);
  await call(createFleetOrchestrationApi());
  expect(send.mock.lastCall!.slice(1)).toEqual([200, {
    ...payload, total: 2, counts: { reserved: 1, admitted: 0, complete: 1 },
    unresolved: [{ job: receipts[0]!.job, specialist: receipts[0]!.specialist, assignedAt: receipts[0]!.assignedAt }],
    receipts: [...receipts].reverse(),
  }]);
  expect(readFileSync(file)).toEqual(before);
  expect(readdirSync(directory)).toEqual(['orchestration.json']);
  writeFileSync(file, '{bad-json');
  await call(createFleetOrchestrationApi());
  expect(send.mock.lastCall!.slice(1)).toEqual([503, { error: 'orchestration journal unavailable' }]);
});
